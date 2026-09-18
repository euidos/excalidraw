import { chromium } from "@playwright/test";
const b = await chromium.launch({ args: ["--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream","--use-file-for-fake-audio-capture=/root/dev_workspaces/excalidraw/whiteboard/test/fixtures/jfk.wav"] });
const p = await b.newPage({ viewport: { width: 1400, height: 800 } });
const errors = []; p.on("pageerror", e => errors.push(String(e))); p.on("console", m => { if (m.type()==="error") errors.push(m.text()); });
await p.goto("http://127.0.0.1:4173/");
await p.waitForSelector(".App-toolbar", { timeout: 20000 });
const tools = await p.$$eval(".App-toolbar input[data-testid^='toolbar-']", els => els.map(e => e.getAttribute("data-testid")));
const voiceTool = await p.evaluate(() => document.querySelector('[data-testid="toolbar-voice"]') != null);
const voiceDebug = await p.evaluate(() => window.__excalidrawVoice != null);
const fontOk = await p.evaluate(async () => { await document.fonts.load("20px Excalifont"); await document.fonts.ready; return document.fonts.check("20px Excalifont"); }); // Excalidraw registers fonts lazily, so ask for the face before checking
const mic = await p.evaluate(async () => { try { const s = await navigator.mediaDevices.getUserMedia({audio:true}); const ok = s.getAudioTracks().length; s.getTracks().forEach(t=>t.stop()); return ok; } catch (e) { return "ERR " + e; } });
await p.screenshot({ path: "/tmp/smoke.png" });
console.log(JSON.stringify({ tools, voiceTool, voiceDebug, fontOk, mic, errors: errors.slice(0,5) }, null, 1));
await b.close();
