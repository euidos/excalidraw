// Acoustic round trip on the real whiteboard: arm the live kiosk over CDP, draw a stroke, then play a speech clip
// through the panel's own speakers (pw-play on the whiteboard) so the panel's microphone hears it; report what
// landed in the shape. Usage: node scripts/kiosk-acoustic.mjs /tmp/ko-short.wav <sinkId> [expected-substring]
import { chromium } from "@playwright/test";
import { execFile } from "node:child_process";
const [clip = "/tmp/ko-short.wav", sink = "", expected = ""] = process.argv.slice(2);
const HOST = process.env.WB_HOST || "root@100.102.3.47";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes("127.0.0.1:8765"));
const errors = []; page.on("pageerror", e => errors.push(String(e))); page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
const vp = page.viewportSize() || { width: 1920, height: 1080 };
const cx = Math.round(vp.width * 0.5), cy = Math.round(vp.height * 0.55);
const before = await page.evaluate(() => window.__excalidrawVoice.api.getSceneElements().length);
await page.evaluate(() => window.__excalidrawVoice.controller.pressStart());
await page.waitForTimeout(400);
const t0 = Date.now();
await page.mouse.move(cx - 160, cy); await page.mouse.down();
for (let i = 1; i <= 20; i++) { const a = (i / 20) * Math.PI * 2; await page.mouse.move(cx - 160 * Math.cos(a), cy + 90 * Math.sin(a)); }
await page.mouse.up();
const strokeMs = Date.now() - t0;
const play = new Promise(res => execFile("ssh", [HOST, `sudo -u euidos XDG_RUNTIME_DIR=/run/user/1000 pw-play ${sink ? "--target=" + sink : ""} ${clip}`], (err, so, se) => res({ err: err ? String(err) : null, se: se.slice(0, 200) })));
const played = await play;
await page.waitForTimeout(1500);
await page.evaluate(() => window.__excalidrawVoice.controller.pressEnd());
let st; const tEnd = Date.now();
while (Date.now() - tEnd < 30000) { st = await page.evaluate(() => window.__excalidrawVoice.status()); if (st.pending === 0 && st.mode === "idle") break; await page.waitForTimeout(400); }
const els = await page.evaluate(n => window.__excalidrawVoice.api.getSceneElements().slice(n).map(e => ({ type: e.type, text: e.text, fontSize: e.fontSize, containerId: e.containerId, strokeStyle: e.strokeStyle, w: Math.round(e.width), h: Math.round(e.height) })), before);
const text = els.filter(e => e.type === "text").map(e => e.text).join(" | ");
console.log(JSON.stringify({ clip, sink, strokeMs, played, status: st, elements: els, expected, ok: expected ? text.includes(expected) : null, errors }, null, 1));
await page.screenshot({ path: "/tmp/kiosk-acoustic.png" });
await browser.close();
