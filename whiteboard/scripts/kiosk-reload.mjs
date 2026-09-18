// Reload the live kiosk page over CDP after a deploy (run from dev-woo, tunnel as in kiosk-probe.mjs):
//   node scripts/kiosk-reload.mjs [--force]
// Gentler than restarting Chromium: the board persists through localStorage and the founder keeps their window.
// Refuses while the board is in use — an element updated in the last IDLE_MS — unless --force is given, because a
// reload mid-stroke drops that stroke (2026-09-18: the founder was drawing on the wall while we deployed).
import { chromium } from "@playwright/test";

const IDLE_MS = 5 * 60 * 1000;
const force = process.argv.includes("--force");
const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("127.0.0.1:8765"));
if (!page) {
  console.log("no kiosk page; pages:", browser.contexts().flatMap((c) => c.pages()).map((p) => p.url()));
  process.exit(2);
}
const before = await page.evaluate(() => {
  const v = window.__excalidrawVoice;
  const els = v ? v.api.getSceneElements() : [];
  const last = els.reduce((m, e) => Math.max(m, e.updated || 0), 0);
  const st = v ? v.status() : null;
  return { elements: els.length, lastUpdated: last, pending: st ? st.pending : null, mode: st ? st.mode : null,
    bundle: (document.querySelector('script[src*="index-"]') || {}).src || null };
});
const idleFor = Date.now() - before.lastUpdated;
console.log(JSON.stringify({ ...before, idleForS: Math.round(idleFor / 1000) }));
if (!force && (before.pending > 0 || before.mode !== "idle" || (before.elements > 0 && idleFor < IDLE_MS))) {
  console.log("board in use (pending/armed/recent edit): not reloading; pass --force to override");
  await browser.close();
  process.exit(3);
}
await page.reload({ waitUntil: "load" });
await page.waitForFunction(() => !!window.__excalidrawVoice, null, { timeout: 30000 });
const after = await page.evaluate(() => ({
  elements: window.__excalidrawVoice.api.getSceneElements().length,
  bundle: (document.querySelector('script[src*="index-"]') || {}).src || null,
  toolbarVoice: !!document.querySelector('[data-testid="toolbar-voice"]'),
  menuVoice: !!document.querySelector('[data-testid="menu-voice-settings"]') || "closed-menu",
}));
console.log("reloaded:", JSON.stringify(after));
if (after.elements !== before.elements) {
  console.log(`WARNING: element count changed ${before.elements} -> ${after.elements}`);
}
await browser.close();
