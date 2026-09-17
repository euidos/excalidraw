// Probe the live whiteboard kiosk over CDP (run from dev-woo):
//   ssh -f -N -L 9223:127.0.0.1:9222 root@100.102.3.47   # tunnel to the kiosk's --remote-debugging-port
//   node scripts/kiosk-probe.mjs [screenshot-path] [--stroke]
// Reports the page URL, voice status, mic devices, STT health as seen FROM the whiteboard, and optionally
// performs one F9-held stroke with the real microphone (room audio) to exercise the whole pipeline.
import { chromium } from "@playwright/test";

const out = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "/tmp/kiosk.png";
const doStroke = process.argv.includes("--stroke");
const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes("127.0.0.1:8765"));
if (!page) { console.log("no kiosk page; pages:", browser.contexts().flatMap(c => c.pages()).map(p => p.url())); process.exit(2); }
const info = await page.evaluate(async () => {
  const v = window.__excalidrawVoice;
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audioinput").map(d => d.label || d.deviceId);
  let health = null;
  try { const s = v ? v.settings() : null; const r = await fetch((s ? s.sttUrl : "http://100.81.33.83:8770") + "/health"); health = await r.json(); } catch (e) { health = String(e); }
  return {
    url: location.href, voice: !!v, status: v ? v.status() : null, settings: v ? v.settings() : null, devices, health,
    toolbarVoice: !!document.querySelector('[data-testid="toolbar-voice"]'),
    elements: v ? v.api.getSceneElements().length : null, fonts: document.fonts.check("20px Excalifont"),
  };
});
console.log(JSON.stringify(info, null, 1));
if (doStroke && info.voice) {
  const vp = page.viewportSize() || { width: 1920, height: 1080 };
  const cx = Math.round(vp.width * 0.6), cy = Math.round(vp.height * 0.6);
  await page.keyboard.down("F9");
  await page.mouse.move(cx - 150, cy);
  await page.mouse.down();
  for (let i = 1; i <= 24; i++) { const a = (i / 24) * Math.PI * 2; await page.mouse.move(cx - 150 * Math.cos(a), cy + 80 * Math.sin(a)); }
  await page.mouse.up();
  await page.waitForTimeout(2500);
  await page.keyboard.up("F9");
  const t0 = Date.now();
  let st;
  while (Date.now() - t0 < 30000) { st = await page.evaluate(() => window.__excalidrawVoice.status()); if (st.pending === 0) break; await page.waitForTimeout(300); }
  const els = await page.evaluate(() => window.__excalidrawVoice.api.getSceneElements().slice(-2).map(e => ({ type: e.type, text: e.text, containerId: e.containerId, strokeStyle: e.strokeStyle })));
  console.log("after stroke:", JSON.stringify({ status: st, last: els }, null, 1));
}
await page.screenshot({ path: out });
console.log("screenshot", out);
await browser.close();
