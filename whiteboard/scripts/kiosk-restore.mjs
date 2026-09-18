// Un-delete elements in the live kiosk scene over CDP (run from dev-woo, tunnel as in kiosk-probe.mjs):
//   node scripts/kiosk-restore.mjs [id-to-leave-deleted ...]
// Purpose: recover a board after kiosk-clear.mjs was run on the founder's live content (2026-09-18). The scene
// still holds the cleared elements as isDeleted until the next reload, so flipping the flag brings them back as one
// undoable update; the persister then writes the restored set to localStorage. Elements whose ids are given on the
// command line (e.g. a probe's own ellipse) stay deleted.
import { chromium } from "@playwright/test";

const keep = new Set(process.argv.slice(2));
const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("127.0.0.1:8765"));
if (!page) {
  console.log("no kiosk page");
  process.exit(2);
}
const result = await page.evaluate((keepIds) => {
  const v = window.__excalidrawVoice;
  const all = v.api.getSceneElementsIncludingDeleted();
  let restored = 0;
  const next = all.map((e) => {
    if (e.isDeleted && !keepIds.includes(e.id)) {
      restored += 1;
      return { ...e, isDeleted: false, version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) };
    }
    return e; // same object: an in-progress stroke keeps its identity
  });
  v.api.updateScene({ elements: next, captureUpdate: "IMMEDIATELY" });
  return { restored, liveAfter: v.api.getSceneElements().length };
}, [...keep]);
console.log("restore:", JSON.stringify(result));
await page.waitForTimeout(1500);
const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("excalidraw") || "[]").length);
console.log("localStorage element count after save:", saved);
await browser.close();
