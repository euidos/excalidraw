// Arm/disarm the app's own controller (no stroke → orphan path) and inspect the blob it posts to the STT server.
import { chromium } from "@playwright/test";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes("127.0.0.1:8765"));
const res = await page.evaluate(async (holdMs) => {
  const v = window.__excalidrawVoice;
  const captured = [];
  const orig = window.fetch;
  window.fetch = async (input, init) => {
    if (init && init.body instanceof FormData) {
      const f = init.body.get("file");
      if (f) {
        const ctx = new AudioContext();
        let dur = null; try { dur = (await ctx.decodeAudioData(await f.arrayBuffer())).duration; } catch (e) { dur = String(e); }
        await ctx.close();
        captured.push({ bytes: f.size, type: f.type, browserDecodedS: dur, t: performance.now() });
      }
    }
    const r = await orig(input, init);
    try { const j = await r.clone().json(); captured.push({ server: j }); } catch {}
    return r;
  };
  const t0 = performance.now();
  v.controller.pressStart();
  await new Promise(r => setTimeout(r, holdMs));
  v.controller.pressEnd();
  const tEnd = performance.now();
  for (let i = 0; i < 100 && captured.length < 2; i++) await new Promise(r => setTimeout(r, 300));
  window.fetch = orig;
  const els = v.api.getSceneElements().map(e => ({ type: e.type, text: e.text }));
  return { holdMs: Math.round(tEnd - t0), captured, status: v.status(), els };
}, 3000);
console.log(JSON.stringify(res, null, 1));
await browser.close();
