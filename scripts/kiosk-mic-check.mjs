// Record 3 s from each audio input on the kiosk and report blob size + decoded duration (CDP tunnel on 9223).
import { chromium } from "@playwright/test";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes("127.0.0.1:8765"));
const res = await page.evaluate(async () => {
  const out = [];
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audioinput");
  for (const d of devs) {
    const t0 = performance.now();
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: d.deviceId } } }); } catch (e) { out.push({ label: d.label, error: String(e) }); continue; }
    const track = stream.getAudioTracks()[0];
    const settings = track.getSettings();
    const rec = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
    const chunks = [];
    rec.ondataavailable = e => chunks.push(e.data);
    const stopped = new Promise(r => (rec.onstop = r));
    rec.start();
    const tStart = performance.now();
    await new Promise(r => setTimeout(r, 3000));
    rec.stop();
    await stopped;
    const wall = performance.now() - tStart;
    const blob = new Blob(chunks, { type: "audio/webm" });
    let decoded = null;
    try {
      const ctx = new AudioContext();
      const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
      let peak = 0; const ch = buf.getChannelData(0); for (let i = 0; i < ch.length; i += 16) peak = Math.max(peak, Math.abs(ch[i]));
      decoded = { durationS: buf.duration, sampleRate: buf.sampleRate, peak };
      await ctx.close();
    } catch (e) { decoded = String(e); }
    track.stop();
    out.push({ label: d.label, acquireMs: Math.round(tStart - t0), wallMs: Math.round(wall), blobBytes: blob.size, settings, decoded });
  }
  return out;
});
console.log(JSON.stringify(res, null, 1));
await browser.close();
