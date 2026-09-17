import { chromium } from "@playwright/test";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes("127.0.0.1:8765"));
const n = await page.evaluate(() => { const v = window.__excalidrawVoice; const els = v.api.getSceneElements(); v.api.updateScene({ elements: els.map(e => ({ ...e, isDeleted: true, version: e.version + 1 })) }); return els.length; });
console.log("cleared elements:", n);
await browser.close();
