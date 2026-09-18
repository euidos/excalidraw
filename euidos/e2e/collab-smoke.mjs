#!/usr/bin/env node
/**
 * Phase-1 acceptance for the collaborative boards (euidos/docs/collab-plan.md §4).
 *
 * Runs against the DEPLOYED app on a real origin — no dev server, no mocks:
 *
 *   1. mint a room link exactly as the app's generateCollaborationLinkData()
 *      does (ROOM_ID_BYTES = 10 random bytes hex = 20 chars, plus the `k` of a
 *      128-bit AES-GCM JWK = 22 base64url chars — see excalidraw-app/data/index.ts
 *      and app_constants.ts; RE_COLLAB_LINK rejects any other shape)
 *   2. open `#room=<id>,<key>` in TWO isolated browser contexts
 *   3. draw a rectangle in A with real pointer events, assert B RENDERS it
 *      within RELAY_BUDGET_MS — the payload crosses excalidraw-room encrypted
 *      with the room key, so this is a true round trip
 *   4. wait for the scene to reach OUR backend (PUT /api/rooms/:id; the app
 *      throttles that save to SYNC_FULL_SCENE_INTERVAL_MS = 20 s, leading:false,
 *      so the wait below is the app's cadence, not slack in the test)
 *   5. close BOTH browsers, reopen the link in a THIRD cold context, assert the
 *      rectangle is still drawn — with empty localStorage it can only have come
 *      from GET /api/rooms/:id
 *   6. assert GET /api/boards lists the room
 *
 * WHY PIXELS: `window.h` (elements, appState) is a dev/test-only hook and this
 * is a production build, and the stats panel is unmounted whenever a tool with
 * properties is active. What a collaborator actually gets is a drawn scene, so
 * the assertion is "the scene canvas has ink" — counted straight out of
 * `canvas.static`'s ImageData. Element-level truth is asserted separately, from
 * the API response.
 *
 *   node collab-smoke.mjs [origin]
 *
 * Default origin is the tailnet name. Identity there comes from Tailscale
 * Serve: from a TAGGED node such as dev-woo there is none, so boards created by
 * this run are owned by "wall" (the wall kiosk's identity) — expected, not a bug.
 */
import { randomBytes } from "node:crypto";

import { chromium } from "@playwright/test";

const ORIGIN =
  process.argv[2] ?? "https://euidos-internal.pony-bellatrix.ts.net";
const RELAY_BUDGET_MS = 2000; // the plan's acceptance budget for A -> B
const SAVE_BUDGET_MS = 45000; // SYNC_FULL_SCENE_INTERVAL_MS is 20 s, leading:false
const SETTLE_MS = 2500; // the editor ignores input for a beat after first paint
const MIN_INK = 200; // a 200x200 rectangle outline is ~2400 dark pixels
const HEADLESS = process.env.HEADED !== "1";

const t0 = Date.now();
const log = (msg) =>
  console.log(`[${String(Date.now() - t0).padStart(6)}ms] ${msg}`);

let failures = 0;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
  return ok;
};

/** Same shape as the app's generateCollaborationLinkData(). */
const generateCollaborationLinkData = () => ({
  roomId: randomBytes(10).toString("hex"),
  roomKey: randomBytes(16).toString("base64url"),
});

const api = async (path) => {
  const res = await fetch(`${ORIGIN}${path}`);
  const body = await res.text();
  try {
    return { status: res.status, json: JSON.parse(body) };
  } catch {
    return { status: res.status, json: null, body };
  }
};

/** Dark, non-transparent pixels on the scene canvas = what the user can see. */
const ink = (page) =>
  page.evaluate(() => {
    const canvas = document.querySelector("canvas.static");
    if (!canvas) {
      return -1;
    }
    const { data } = canvas
      .getContext("2d")
      .getImageData(0, 0, canvas.width, canvas.height);
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (
        data[i + 3] > 16 &&
        (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200)
      ) {
        n++;
      }
    }
    return n;
  });

const waitForInk = async (page, budgetMs) => {
  const started = Date.now();
  for (;;) {
    const n = await ink(page);
    if (n >= MIN_INK) {
      return { ms: Date.now() - started, pixels: n };
    }
    if (Date.now() - started > budgetMs) {
      throw new Error(`only ${n} ink pixels after ${budgetMs}ms`);
    }
    await page.waitForTimeout(50);
  }
};

const openRoom = async (browser, url, who) => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => log(`${who} pageerror: ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 400) {
      log(`${who} HTTP ${r.status()} ${new URL(r.url()).pathname}`);
    }
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator("canvas.interactive").waitFor({ timeout: 30000 });
  // The editor mounts its canvases before it is ready to accept pointer input;
  // without this pause the first drag is swallowed and nothing is drawn.
  await page.waitForTimeout(SETTLE_MS);
  return { context, page };
};

/**
 * Draw on the right-hand side of the canvas on purpose: the left is covered by
 * the shape-properties island once a drawing tool is active, and the middle by
 * the welcome screen while the scene is still empty. Both intercept the drag.
 */
const drawRectangle = async (page) => {
  await page.locator('.App-toolbar [title^="Rectangle"]').click();
  await page.waitForTimeout(300);
  await page.mouse.move(950, 200);
  await page.mouse.down();
  await page.mouse.move(1050, 300, { steps: 8 });
  await page.mouse.move(1150, 400, { steps: 8 });
  await page.mouse.up();
};

const main = async () => {
  const { roomId, roomKey } = generateCollaborationLinkData();
  const url = `${ORIGIN}/#room=${roomId},${roomKey}`;
  log(`origin ${ORIGIN}`);
  log(`room   ${roomId} (key redacted, ${roomKey.length} chars)`);

  const health = await api("/api/health");
  check(health.json?.ok === true, "GET /api/health", JSON.stringify(health.json));

  const before = await api(`/api/rooms/${roomId}`);
  check(
    before.status === 404,
    "GET /api/rooms/:id is 404 before the first save",
    `HTTP ${before.status}`,
  );

  const browser = await chromium.launch({ headless: HEADLESS });
  let a;
  let b;
  try {
    let mark = Date.now();
    a = await openRoom(browser, url, "A");
    log(`A open (${Date.now() - mark}ms)`);
    mark = Date.now();
    b = await openRoom(browser, url, "B");
    log(`B open (${Date.now() - mark}ms)`);

    check((await ink(b.page)) === 0, "B starts with an empty canvas");

    await drawRectangle(a.page);
    const drawn = await waitForInk(a.page, 5000);
    log(`A drew a rectangle (${drawn.ms}ms to render locally, ${drawn.pixels}px)`);

    const relay = await waitForInk(b.page, RELAY_BUDGET_MS + 3000).catch(
      (e) => e,
    );
    check(
      typeof relay !== "string" && relay.ms <= RELAY_BUDGET_MS,
      `B received the rectangle within ${RELAY_BUDGET_MS}ms`,
      relay.ms === undefined
        ? String(relay.message ?? relay)
        : `${relay.ms}ms over the socket relay, ${relay.pixels}px`,
    );

    mark = Date.now();
    let saved = null;
    while (Date.now() - mark < SAVE_BUDGET_MS) {
      const res = await api(`/api/rooms/${roomId}`);
      if (res.status === 200) {
        saved = res.json;
        break;
      }
      await a.page.waitForTimeout(500);
    }
    const savedMs = Date.now() - mark;
    check(
      saved?.elements?.length === 1 && saved.elements[0]?.type === "rectangle",
      "the scene reached PUT /api/rooms/:id",
      saved
        ? `${savedMs}ms, version ${saved.version}, ${saved.elements.length} element(s), type ${saved.elements[0]?.type}`
        : `nothing stored after ${savedMs}ms`,
    );
  } finally {
    if (a) {
      await a.context.close();
    }
    if (b) {
      await b.context.close();
    }
  }
  log("both browsers closed");

  let c;
  try {
    const mark = Date.now();
    c = await openRoom(browser, url, "C");
    const reloaded = await waitForInk(c.page, 15000).catch((e) => e);
    check(
      reloaded.ms !== undefined,
      "a cold reopen still shows the rectangle (loaded from /api/rooms)",
      reloaded.ms === undefined
        ? String(reloaded.message ?? reloaded)
        : `${reloaded.pixels}px, ${Date.now() - mark}ms from open`,
    );
  } finally {
    if (c) {
      await c.context.close();
    }
    await browser.close();
  }

  const boards = await api("/api/boards");
  const board = boards.json?.boards?.find((x) => x.id === roomId);
  check(
    !!board,
    "GET /api/boards lists the room",
    board
      ? `name "${board.name}", createdBy ${board.createdBy}, updatedBy ${board.updatedBy}, elementCount ${board.elementCount}`
      : `${boards.json?.boards?.length ?? "?"} board(s), none matching`,
  );

  console.log(
    `\n${failures === 0 ? "PASS" : `FAIL (${failures})`} — ${Date.now() - t0}ms total`,
  );
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
