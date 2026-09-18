/**
 * Proves the round-5 server change on the real server: a request the client ABORTS while it is queued behind the
 * GPU costs no GPU time at all — the handler wakes up holding the lock, asks `request.is_disconnected()`, logs and
 * answers 499.
 *
 * Why a script and not an e2e case: the assertion is a line in the server's own log on stt-desktop, so the check
 * needs ssh, which the Playwright suite deliberately does not. The fetch itself runs in CHROMIUM, because that is
 * the client whose abort behaviour is in question (node's fetch is a different HTTP stack).
 *
 *   node scripts/stt-abort-check.mjs [http://100.81.33.83:8770]
 */
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const base = process.argv[2] ?? "http://100.81.33.83:8770";
const b64 = (name) => readFileSync(resolve("test/fixtures", name)).toString("base64");

/**
 * A WAV whose PCM is `times` copies of the fixture's. The blocking request has to hold the GPU for SECONDS, long
 * enough for the abandoned one to be received and queued before it is aborted — a short clip finishes first and the
 * abort then lands before the server has even read the second request, which proves nothing about the lock.
 */
function repeatedWav(name, times) {
  const src = readFileSync(resolve("test/fixtures", name));
  // The chunks have to be walked, not assumed: jfk.wav carries a LIST chunk before its data, so the canonical
  // 44-byte header is a fiction and slicing at 44 produced an unreadable clip (the server answered 500).
  let at = 12;
  let dataAt = -1;
  let dataLen = 0;
  while (at + 8 <= src.length) {
    const id = src.subarray(at, at + 4).toString("latin1");
    const size = src.readUInt32LE(at + 4);
    if (id === "data") {
      dataAt = at + 8;
      dataLen = size;
      break;
    }
    at += 8 + size + (size % 2);
  }
  if (dataAt < 0) throw new Error(`${name}: no data chunk`);
  const pcm = src.subarray(dataAt, dataAt + dataLen);
  const data = Buffer.concat(Array.from({ length: times }, () => pcm));
  const head = Buffer.from(src.subarray(0, dataAt));
  head.writeUInt32LE(head.length - 8 + data.length, 4);
  head.writeUInt32LE(data.length, dataAt - 4);
  return Buffer.concat([head, data]).toString("base64");
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  // The app's own origin, served by `npm run preview` — start it first. Not a data: URL and not an intercepted
  // response: Chromium's Private Network Access rules classify both as "public" and then refuse a fetch to the
  // tailnet address, which is exactly the check the real page (served from loopback) passes.
  const origin = process.env.VOICE_APP_URL ?? "http://127.0.0.1:4173";
  await page.goto(`${origin}/`);
  const result = await page.evaluate(
    async ({ base, longClip, shortClip, untilPost, untilAbort }) => {
      const blobOf = (b64) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: "audio/wav" });
      };
      const post = (blob, signal) => {
        const form = new FormData();
        form.append("file", blob, "segment.wav");
        form.append("response_format", "verbose_json");
        return fetch(`${base}/v1/audio/transcriptions`, { method: "POST", body: form, signal });
      };
      const before = await (await fetch(`${base}/health`)).json();
      // A is long enough to hold the GPU while B queues behind it.
      // A is posted first and must already HOLD the GPU when B arrives — the whole point is that B queues. The
      // delay is a real one: a 350 KB upload to the tailnet host takes ~250 ms, and a short clip sent too early
      // simply overtakes A and is answered before it can be abandoned (which proves nothing).
      const a = post(blobOf(longClip));
      await new Promise((r) => setTimeout(r, untilPost));
      const abort = new AbortController();
      const b = post(blobOf(shortClip), abort.signal).catch((err) => ({ aborted: err.name }));
      // B is received and queued on the GPU lock by now, and is then abandoned exactly as an interim slice is when
      // a newer one is cut (controller.ts stopInterim / sendInterim).
      await new Promise((r) => setTimeout(r, untilAbort));
      abort.abort();
      const aRes = await a;
      const aBody = await aRes.json();
      await b;
      await new Promise((r) => setTimeout(r, 800));
      const after = await (await fetch(`${base}/health`)).json();
      return { skippedBefore: before.skipped, skippedAfter: after.skipped, aStatus: aRes.status, aText: (aBody.text ?? "").slice(0, 40) };
    },
    {
      base,
      longClip: repeatedWav("jfk.wav", Number(process.env.STT_ABORT_REPEAT ?? 1)),
      shortClip: b64("ko-short.wav"),
      untilPost: Number(process.env.STT_ABORT_POST_MS ?? 400),
      untilAbort: Number(process.env.STT_ABORT_MS ?? 350),
    },
  );
  console.log(JSON.stringify(result, null, 2));
  if (result.skippedAfter <= result.skippedBefore) {
    console.error("FAIL: the server did not count a skipped request");
    process.exitCode = 1;
  } else {
    console.log("PASS: the abandoned request was skipped before it reached the GPU");
  }
} finally {
  await browser.close();
}
