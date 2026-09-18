/**
 * The upload's FILE NAME is part of the contract: OpenAI and whisper.cpp's strict server validate the extension,
 * so a WAV posted as segment.webm 400s every utterance against anything but the founder's content-sniffing server.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { transcribe } from "../stt";
import { SttError } from "../contracts";

const OPTS = { baseUrl: "http://stt.invalid:8770" };

interface Captured {
  url: string;
  fileName: string;
  size: number;
}

function stubFetch(status = 200): () => Captured {
  const seen: Captured[] = [];
  vi.stubGlobal("fetch", async (url: string, init: { body: FormData }) => {
    const file = init.body.get("file") as File;
    seen.push({ url: String(url), fileName: file.name, size: file.size });
    return new Response(JSON.stringify({ text: "ok" }), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return () => seen[0]!;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("transcribe — the uploaded file is named after what capture.ts actually cut", () => {
  it("names the round-2 PCM blob segment.wav", async () => {
    const first = stubFetch();
    await transcribe(
      new Blob([new Uint8Array(64)], { type: "audio/wav" }),
      OPTS,
    );
    expect(first().fileName).toBe("segment.wav");
    expect(first().url).toBe("http://stt.invalid:8770/v1/audio/transcriptions");
  });

  it("keeps ogg and falls back to webm for a container it does not know", async () => {
    const ogg = stubFetch();
    await transcribe(new Blob(["x"], { type: "audio/ogg;codecs=opus" }), OPTS);
    expect(ogg().fileName).toBe("segment.ogg");

    vi.unstubAllGlobals();
    const webm = stubFetch();
    await transcribe(new Blob(["x"], { type: "audio/webm;codecs=opus" }), OPTS);
    expect(webm().fileName).toBe("segment.webm");

    vi.unstubAllGlobals();
    const unknown = stubFetch();
    await transcribe(new Blob(["x"], { type: "" }), OPTS);
    expect(unknown().fileName).toBe("segment.webm");
  });

  it("types a rejection from a stricter server rather than swallowing it", async () => {
    stubFetch(400);
    await expect(
      transcribe(new Blob(["x"], { type: "audio/wav" }), OPTS),
    ).rejects.toBeInstanceOf(SttError);
  });
});
