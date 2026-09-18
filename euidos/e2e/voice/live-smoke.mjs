#!/usr/bin/env node
/**
 * Phase-2 acceptance for the voice tool: the DEPLOYED app on a real HTTPS origin, a real microphone stream
 * (Chromium's fake device fed with a real speech WAV) and the founder's real STT server — reached the way a
 * browser on that origin must reach it, through nginx's `/stt/` proxy.
 *
 * The 27-gate suite next to this file (voice.spec.ts) runs against a LOOPBACK build, where `contracts.defaultSttUrl`
 * dials http://100.81.33.83:8770 DIRECTLY. That is the kiosk's branch and it deliberately never exercises:
 *
 *   1. getUserMedia on an HTTPS origin (Tailscale Serve's cert, not a loopback secure-context freebie);
 *   2. the multipart upload through the same-origin `/stt/` proxy, whose location block STRIPS the identity
 *      headers phase 1 added (fleet-infra stacks/euidos-internal/nginx.conf) — a stripped header set that broke
 *      the upload would look exactly like "the tool is broken";
 *   3. that what the tool writes SURVIVES the board's own storage: the words reach PUT /api/rooms/:id and come
 *      back on a cold reopen, and the SCAFFOLDING does not. Region markers, interim previews and placeholder
 *      frames are ordinary canvas elements, so they broadcast to peers and they persist; a peer watching a live
 *      45 % preview is fine, a ghost that outlives the session is not (collab-plan.md G-P2.2).
 *
 * Step 5 is therefore not decoration: the scaffolding is INJECTED into the live scene on purpose (a dashed marker,
 * a stamped interim preview and a "·" placeholder), waited for until it has really reached the backend, and then
 * the board is reopened cold. Without the injection the reopen would only prove that a committed take cleans up
 * after itself — which the unit tests already know — instead of proving that `sweepGhostPlaceholders` runs on the
 * COLLAB load path in Collab.tsx, which is the thing 0.1.0 never had.
 *
 *   cd euidos/e2e/voice && node live-smoke.mjs [origin]
 *
 * Default origin is the tailnet name (no Cloudflare Access in front; board.euidos.ai would answer 302 to the
 * Access login and there is no headless identity here). @playwright/test resolves from euidos/e2e/node_modules.
 *
 * Fails loudly BEFORE launching a browser if the STT server is not warm: an exit code that cannot tell "the app
 * regressed" from "the GPU box was rebooting" is worthless (voice-tool-CLAUDE.md, "Verifying").
 */
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { chromium } from "@playwright/test";

const ORIGIN =
  process.argv[2] ?? "https://euidos-internal.pony-bellatrix.ts.net";
const CLIP = resolve("fixtures/en-short.wav");
/** en-short.wav says "Ship the voice tool tonight" — asserted loosely, an STT server is allowed its own spelling. */
const EXPECT_WORDS = /ship|voice|tonight/i;
const TRANSCRIPT_BUDGET_MS = 40_000; // arm → committed words, over the proxy
const SAVE_BUDGET_MS = 75_000; // SYNC_FULL_SCENE_INTERVAL_MS is 20 s, leading:false
const HEADLESS = process.env.HEADED !== "1";
/** A loopback origin dials STT directly (contracts.defaultSttUrl), so a rehearsal there cannot prove the proxy. */
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost)(:|$)/.test(ORIGIN);

const t0 = Date.now();
const log = (msg) =>
  console.log(`[${String(Date.now() - t0).padStart(6)}ms] ${msg}`);

let failures = 0;
const check = (ok, label, detail = "") => {
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`,
  );
  if (!ok) {
    failures++;
  }
  return ok;
};

/** Same shape as the app's generateCollaborationLinkData(); RE_COLLAB_LINK rejects any other. */
const roomLink = () => ({
  roomId: randomBytes(10).toString("hex"),
  roomKey: randomBytes(16).toString("base64url"),
});

const api = async (path) => {
  const res = await fetch(`${ORIGIN}${path}`);
  const body = await res.text();
  try {
    return { status: res.status, json: JSON.parse(body) };
  } catch {
    return { status: res.status, json: null, body };
  }
};

// --- what the page can tell us -------------------------------------------

/** The element fields the assertions read; page.evaluate can only hand back plain JSON. */
const sceneElements = (page, includeDeleted = false) =>
  page.evaluate((withDeleted) => {
    const a = window.__excalidrawVoice.api;
    const src = withDeleted
      ? a.getSceneElementsIncludingDeleted()
      : a.getSceneElements();
    return src.map((el) => ({
      id: el.id,
      type: el.type,
      x: el.x,
      y: el.y,
      width: el.width,
      height: el.height,
      isDeleted: !!el.isDeleted,
      text: typeof el.text === "string" ? el.text : undefined,
      customData: el.customData ?? null,
    }));
  }, includeDeleted);

const voiceStatus = (page) =>
  page.evaluate(() => window.__excalidrawVoice.status());
const voiceSettings = (page) =>
  page.evaluate(() => window.__excalidrawVoice.settings());

const isPlaceholder = (el) => /^·{1,3}$/.test((el.text ?? "").trim());
/** The words that really landed: not a placeholder frame, not a "⚠ STT" report, not a 45 % interim preview. */
const committedTexts = (els) =>
  els.filter(
    (el) =>
      !el.isDeleted &&
      el.type === "text" &&
      (el.text ?? "").trim().length > 0 &&
      !isPlaceholder(el) &&
      !(el.text ?? "").includes("STT") &&
      el.customData?.voiceInterim !== true,
  );
/** Live scaffolding: markers, interim previews, placeholder frames. None of it may survive a reload. */
const scaffolding = (els) =>
  els.filter(
    (el) =>
      !el.isDeleted &&
      (el.customData?.voiceRegion === true ||
        el.customData?.voiceInterim === true ||
        (el.type === "text" && isPlaceholder(el))),
  );

const flat = (s) => (s ?? "").replace(/\s+/g, " ").trim();

// --- the browser ----------------------------------------------------------

/**
 * Opens the board with Chromium's fake microphone playing `CLIP`.
 *
 * `warmMicOnBoot` is seeded OFF exactly as the gate suite does: Chromium starts playing the file when
 * getUserMedia is called, so warming at page load would start the clip at an unknowable offset. With it off the
 * clip starts at the arm, which is the reference point the region draw is scheduled against.
 */
const open = async (url, who, sink) => {
  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${CLIP}%noloop`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 900 },
    });
    await context.grantPermissions(["microphone"], { origin: ORIGIN });
    const page = await context.newPage();
    // Seeded once: a reload must read back what the app persisted, not the pristine seed again.
    await page.addInitScript(() => {
      if (!localStorage.getItem("__e2e-seeded")) {
        localStorage.setItem(
          "voice-settings",
          JSON.stringify({ warmMicOnBoot: false }),
        );
        localStorage.setItem("__e2e-seeded", "1");
      }
    });
    page.on("pageerror", (e) => {
      sink.errors.push(`${who}: ${e.message}`);
      log(`${who} pageerror: ${e.message}`);
    });
    page.on("response", (r) => {
      const u = r.url();
      if (u.includes("/stt/")) {
        sink.stt.push({ url: u, status: r.status() });
      }
      if (u.includes("/api/rooms/")) {
        // Collab.initializeRoom() calls excalidrawAPI.resetScene() and only THEN loads the room, so anything the
        // voice tool put on the canvas before this answer arrives is thrown away with the rest of the local scene.
        // Nothing may be armed until it has landed — see the wait in main().
        sink.roomLoads.push({ status: r.status(), at: Date.now() });
      }
      if (u.startsWith("http://100.81.33.83:8770")) {
        sink.direct.push(u);
      }
      if (r.status() >= 400 && !u.includes("favicon")) {
        log(`${who} HTTP ${r.status()} ${new URL(u).pathname}`);
      }
    });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".excalidraw canvas", { timeout: 40_000 });
    await page.waitForFunction(() => !!window.__excalidrawVoice, undefined, {
      timeout: 40_000,
    });
    // The toolbar button is injected by a poll once the editor's own toolbar row exists.
    await page.waitForSelector('[data-testid="toolbar-voice"]', {
      timeout: 40_000,
    });
    // The editor mounts its canvases before it accepts pointer input; without this the first drag is swallowed.
    await page.waitForTimeout(2500);
    return { browser, page };
  } catch (err) {
    await browser.close();
    throw err;
  }
};

/** An oval traced the way a hand does on a wall panel: every sample gets its own frame (the drag is rAF-throttled). */
const ovalPath = (cx, cy, rx, ry, steps = 14) =>
  Array.from({ length: steps + 1 }, (_, i) => {
    const a = (i / steps) * Math.PI * 2;
    return {
      x: Math.round(cx + rx * Math.cos(a)),
      y: Math.round(cy + ry * Math.sin(a)),
    };
  });

const drawPath = async (page, pts, stepMs = 24) => {
  await page.mouse.move(pts[0].x, pts[0].y);
  await page.waitForTimeout(stepMs);
  await page.mouse.down();
  await page.waitForTimeout(stepMs);
  for (const p of pts.slice(1)) {
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(stepMs);
  }
  await page.mouse.up();
  await page.waitForTimeout(150);
};

const poll = async (fn, budgetMs, stepMs = 250) => {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) {
      return { value, ms: Date.now() - started };
    }
    if (Date.now() - started > budgetMs) {
      return { value: null, ms: Date.now() - started };
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
};

const main = async () => {
  const { roomId, roomKey } = roomLink();
  const url = `${ORIGIN}/#room=${roomId},${roomKey}`;
  log(`origin ${ORIGIN}`);
  log(`room   ${roomId} (key redacted, ${roomKey.length} chars)`);
  log(`clip   ${CLIP}`);

  // --- 0. preflight: is the server that will answer even awake? -----------
  const health = await api(LOOPBACK ? "/api/health" : "/stt/health").catch(
    (e) => ({ status: 0, body: String(e) }),
  );
  if (!LOOPBACK) {
    if (health.json?.warm !== true) {
      console.error(
        `ABORT — ${ORIGIN}/stt/health is not warm: ${JSON.stringify(
          health.json ?? health.body,
        )}`,
      );
      process.exit(2);
    }
    check(
      true,
      "GET /stt/health through the proxy",
      `${health.json.model} on ${health.json.device}, warm`,
    );
  } else {
    log(
      "loopback origin: this is a REHEARSAL — the app dials STT directly, the proxy leg is not under test",
    );
  }

  const sink = { errors: [], stt: [], direct: [], roomLoads: [] };
  let session = await open(url, "A", sink);
  const { page } = session;

  // The room has to be JOINED before the tool arms: initializeRoom() resets the scene and then loads it, so a
  // region drawn a moment too early is wiped mid-take and its transcript is dropped on the floor. (Seen for real
  // against a loopback build with no backend: the marker appeared, the scene emptied, the words never landed.)
  const joined = await poll(async () => sink.roomLoads.length > 0, 30_000, 200);
  check(
    !!joined.value,
    "the room was joined (GET /api/rooms/:id answered) before anything was armed",
    joined.value
      ? `${joined.ms}ms, HTTP ${sink.roomLoads[0].status}${
          sink.roomLoads[0].status === 404 ? " (new room)" : ""
        }`
      : "no /api/rooms response in 30 s",
  );
  await page.waitForTimeout(1500);

  const settings = await voiceSettings(page);
  check(
    LOOPBACK
      ? settings.sttUrl === "http://100.81.33.83:8770"
      : settings.sttUrl === `${ORIGIN}/stt`,
    "the page resolved the STT URL for its own origin",
    settings.sttUrl,
  );

  let words = null;
  let ghosts = null;
  try {
    // --- 1. arm: getUserMedia on this origin ----------------------------
    await page.keyboard.down("F9");
    const armed = await poll(
      async () => (await voiceStatus(page)).recording === true,
      20_000,
      100,
    );
    check(
      !!armed.value,
      "F9 armed the tool: getUserMedia granted a stream on this origin",
      `${armed.ms}ms to recording`,
    );
    const micOk = (await voiceStatus(page)).mic;
    check(micOk === "ok", "the microphone is live", `mic=${micOk}`);

    // --- 2. speak, then draw the region round the words -----------------
    // The rhythm the tool is built for: the label is spoken and the region is drawn while it is still being said.
    // The clip starts playing at the F9 press, so 400 ms in the utterance has begun and the pre-roll (1500 ms)
    // still assigns it to this stroke.
    await page.waitForTimeout(400);
    await drawPath(page, ovalPath(760, 430, 170, 90));

    const landed = await poll(async () => {
      const els = await sceneElements(page);
      const t = committedTexts(els)[0];
      return t ? { t, els } : null;
    }, TRANSCRIPT_BUDGET_MS);
    check(
      !!landed.value,
      "the transcript came back and landed on the canvas",
      landed.value
        ? `${landed.ms}ms, "${flat(landed.value.t.text)}"`
        : `nothing committed after ${landed.ms}ms`,
    );
    if (!landed.value) {
      throw new Error("no transcript: the rest of the run would be noise");
    }
    words = flat(landed.value.t.text);
    check(
      EXPECT_WORDS.test(words),
      "and they are the words in the clip, not a hallucination",
      `"${words}"`,
    );
    check(
      scaffolding(landed.value.els).length === 0,
      "the committed take took its own scaffolding with it",
      `${scaffolding(landed.value.els).length} left in the live scene`,
    );

    const st = await voiceStatus(page);
    check(
      (st.lastSttLatencyMs ?? 0) > 50 && st.failed === 0,
      "a real round trip to the STT server happened, and nothing failed",
      `${Math.round(st.lastSttLatencyMs ?? 0)}ms, failed=${
        st.failed
      }, orphans=${st.orphans}`,
    );
    if (!LOOPBACK) {
      const upload = sink.stt.find((r) =>
        r.url.includes("/stt/v1/audio/transcriptions"),
      );
      check(
        upload?.status === 200,
        "the multipart upload went through the same-origin /stt/ proxy (identity headers stripped)",
        upload
          ? `HTTP ${upload.status} ${upload.url}`
          : "no /stt/ request seen",
      );
      check(
        sink.direct.length === 0,
        "and nothing was dialled at the STT box directly (no mixed content)",
        `${sink.direct.length} direct request(s)`,
      );
    }
  } finally {
    await page.keyboard.up("F9").catch(() => {});
  }

  // --- 3. inject the litter a crashed session would have left behind -----
  // A committed take cleans up after itself, so a scene that only ever behaved well cannot prove the sweep runs.
  // This is the state a reload during a pending take leaves: a dashed marker nobody will ever commit, the interim
  // preview drawn at 45 %, and a placeholder frame.
  await page.locator('.App-toolbar [title^="Rectangle"]').click();
  await page.waitForTimeout(300);
  await page.mouse.move(1180, 640);
  await page.mouse.down();
  await page.mouse.move(1280, 700, { steps: 6 });
  await page.mouse.move(1400, 780, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  ghosts = await page.evaluate(() => {
    const a = window.__excalidrawVoice.api;
    const els = a.getSceneElementsIncludingDeleted();
    const rect = [...els]
      .reverse()
      .find((el) => !el.isDeleted && el.type === "rectangle");
    const text = els.find((el) => !el.isDeleted && el.type === "text");
    if (!rect || !text) {
      return null;
    }
    const rnd = () => Math.floor(Math.random() * 2 ** 31);
    const stamp = Date.now();
    const marker = {
      ...rect,
      strokeStyle: "dashed",
      customData: { voiceRegion: true },
      version: rect.version + 1,
      versionNonce: rnd(),
      updated: stamp,
    };
    const clone = (over) => ({
      ...text,
      containerId: null,
      boundElements: null,
      version: 1,
      versionNonce: rnd(),
      seed: rnd(),
      updated: stamp,
      ...over,
    });
    const interim = clone({
      id: `ghost-interim-${stamp}`,
      x: rect.x + 8,
      y: rect.y + 8,
      opacity: 45,
      text: "half a sentence so far",
      originalText: "half a sentence so far",
      customData: { voiceInterim: true },
    });
    const placeholder = clone({
      id: `ghost-dot-${stamp}`,
      x: rect.x + 8,
      y: rect.y + 60,
      text: "·",
      originalText: "·",
      customData: null,
    });
    a.updateScene({
      elements: [
        ...els.map((el) => (el.id === marker.id ? marker : el)),
        interim,
        placeholder,
      ],
      captureUpdate: "IMMEDIATELY",
    });
    return {
      markerId: marker.id,
      interimId: interim.id,
      placeholderId: placeholder.id,
    };
  });
  check(
    !!ghosts,
    "injected a marker, an interim preview and a placeholder into the live scene",
  );
  const withGhosts = await sceneElements(page);
  check(
    scaffolding(withGhosts).length === 3,
    "the scene really is carrying the scaffolding now",
    `${scaffolding(withGhosts).length} element(s)`,
  );

  // --- 4. wait until ALL of it has reached our backend --------------------
  const stored = await poll(
    async () => {
      const res = await api(`/api/rooms/${roomId}`);
      if (res.status !== 200) {
        return null;
      }
      const els = res.json?.elements ?? [];
      const hasWords = els.some(
        (el) => !el.isDeleted && el.type === "text" && flat(el.text) === words,
      );
      const hasGhost = els.some(
        (el) => !el.isDeleted && el.customData?.voiceRegion === true,
      );
      return hasWords && hasGhost ? res.json : null;
    },
    SAVE_BUDGET_MS,
    1000,
  );
  check(
    !!stored.value,
    "the transcript AND the scaffolding reached PUT /api/rooms/:id",
    stored.value
      ? `${stored.ms}ms, version ${stored.value.version}, ${stored.value.elements.length} element(s)`
      : `not stored after ${stored.ms}ms`,
  );

  await session.browser.close();
  log("browser closed — everything below can only have come from the server");

  // --- 5. cold reopen: the words survive, the scaffolding does not --------
  session = await open(url, "B", sink);
  const reopened = await poll(async () => {
    const els = await sceneElements(session.page);
    return committedTexts(els).some((el) => flat(el.text) === words)
      ? els
      : null;
  }, 30_000);
  check(
    !!reopened.value,
    "a cold reopen still shows the transcribed words (loaded from /api/rooms)",
    reopened.value
      ? `${reopened.ms}ms, "${words}"`
      : `absent after ${reopened.ms}ms`,
  );
  // Only meaningful once the words are back: an EMPTY board carries no scaffolding either, and a sweep check that
  // passes on a board that failed to load is the kind of green that hides a regression.
  const left = reopened.value ? scaffolding(reopened.value) : null;
  check(
    left !== null && left.length === 0,
    "and carries no voiceRegion / voiceInterim / placeholder scaffolding (G-P2.2: the sweep ran on the collab load path)",
    left === null
      ? "NOT EVALUATED — the reopened board never showed the words, so an empty scene proves nothing"
      : left.length
      ? left
          .map(
            (el) =>
              `${el.type} ${JSON.stringify(el.customData)} "${flat(el.text)}"`,
          )
          .join("; ")
      : `clean, ${
          reopened.value.filter((el) => !el.isDeleted).length
        } live element(s) on the board`,
  );
  await session.browser.close();

  check(
    sink.errors.length === 0,
    "no uncaught page errors in either session",
    sink.errors.join(" | ") || "none",
  );

  console.log(
    `\n${failures === 0 ? "PASS" : `FAIL (${failures})`} — ${
      Date.now() - t0
    }ms total, room ${roomId}`,
  );
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
