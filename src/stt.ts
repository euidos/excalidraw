/**
 * stt.ts — client for the OpenAI-compatible speech-to-text endpoint on the founder's local server.
 */
import { SttError } from "./contracts";
import type { CheckHealth, SttOptions, SttResult, Transcribe } from "./contracts";

const DEFAULT_TIMEOUT_MS = 20_000;
const HEALTH_TIMEOUT_MS = 3_000;

function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function fileNameFor(blob: Blob): string {
  return blob.type.includes("ogg") ? "segment.ogg" : "segment.webm";
}

export const transcribe: Transcribe = async (
  blob: Blob,
  opts: SttOptions,
  signal?: AbortSignal,
): Promise<SttResult> => {
  const form = new FormData();
  form.append("file", blob, fileNameFor(blob));
  form.append("response_format", "verbose_json");
  if (opts.language) form.append("language", opts.language);
  if (opts.prompt) form.append("prompt", opts.prompt);
  form.append("temperature", "0");

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onCallerAbort = () => controller.abort();
  signal?.addEventListener("abort", onCallerAbort);
  if (signal?.aborted) controller.abort();

  const startedAt = performance.now();
  try {
    const res = await fetch(`${normalizeBase(opts.baseUrl)}/v1/audio/transcriptions`, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
    if (res.status === 503) {
      throw new SttError("loading", "speech model is still loading", 503);
    }
    if (!res.ok) {
      throw new SttError("http", `STT server returned ${res.status}`, res.status);
    }
    const data = (await res.json()) as { text?: string; language?: string; duration?: number };
    return {
      text: (data.text ?? "").trim(),
      language: data.language,
      durationS: typeof data.duration === "number" ? data.duration : undefined,
      latencyMs: performance.now() - startedAt,
    };
  } catch (err) {
    if (err instanceof SttError) throw err;
    if ((err as { name?: string } | null)?.name === "AbortError") {
      throw timedOut
        ? new SttError("timeout", "STT request timed out")
        : new SttError("aborted", "STT request aborted");
    }
    // fetch rejects with TypeError for DNS/connection/CORS failures — the server is simply not reachable.
    if (err instanceof TypeError) throw new SttError("offline", "STT server unreachable");
    throw new SttError("http", err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
  }
};

export const checkHealth: CheckHealth = async (baseUrl: string) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${normalizeBase(baseUrl)}/health`, { signal: controller.signal });
    if (!res.ok) return { ok: false, warm: false };
    const data = (await res.json().catch(() => ({}))) as {
      warm?: boolean;
      loaded?: boolean;
      status?: string;
      model?: string;
    };
    return {
      ok: true,
      warm: data.warm ?? data.loaded ?? data.status === "ok",
      model: data.model,
    };
  } catch {
    return { ok: false, warm: false };
  } finally {
    clearTimeout(timer);
  }
};
