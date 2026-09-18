/**
 * Boards-page acceptance — collab-plan phase 3 §3, driven as three real
 * identities against a rehearsal of the euidos-internal stack (see
 * playwright.config.ts for how the stack comes up and why :18099 is loopback).
 *
 * The suite is SERIAL and stateful on purpose: the thing under test is a shared
 * index that several people edit, so "bob's draw moved alice's row to the top"
 * and "bob's delete removed it from alice's list" only mean anything as a
 * sequence. Each test names the step it owns.
 *
 * Identities:
 *   alice  — `Tailscale-User-Login: alice@euidos.ai`   (via:"tailnet")
 *   bob    — `Tailscale-User-Login: bob@euidos.ai`     (via:"tailnet")
 *   wall   — no header at all                          (via:"wall", restricted)
 */
import { expect, test } from "@playwright/test";

import type { Browser, BrowserContext, Page } from "@playwright/test";

const ORIGIN = process.env.BOARDS_ORIGIN ?? "http://127.0.0.1:18099";

const ALICE = "alice@euidos.ai";
const BOB = "bob@euidos.ai";

test.describe.configure({ mode: "serial" });

let alice: BrowserContext;
let bob: BrowserContext;
let wall: BrowserContext;

/** every uncaught page error in the run, asserted empty at the end */
const pageErrors: string[] = [];

const older = { id: "", key: "", name: "Ampere (older)" };
const newer = { id: "", name: "Bernoulli (newer)" };
const legacy = { id: "legacyboard0000", name: "Legacy board (no room key)" };

const makeContext = async (browser: Browser, login?: string) => {
  const context = await browser.newContext({
    baseURL: ORIGIN,
    viewport: { width: 1280, height: 900 },
    // nginx's :8081 block forwards this header to the storage backend; the
    // absence of it is what makes a request the wall.
    extraHTTPHeaders: login ? { "Tailscale-User-Login": login } : {},
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: ORIGIN,
  });
  context.on("page", (page) =>
    page.on("pageerror", (error) =>
      pageErrors.push(`${login ?? "wall"}: ${error.message}`),
    ),
  );
  return context;
};

const boardsPage = async (context: BrowserContext, page?: Page) => {
  const it = page ?? (await context.newPage());
  await it.goto("/boards", { waitUntil: "domcontentloaded" });
  await it.getByTestId("boards-page").waitFor();
  // the list is only trustworthy once the fetch has resolved
  await it
    .locator('[data-testid="board-row"], [data-testid="boards-empty"]')
    .first()
    .waitFor();
  return it;
};

const rowNames = (page: Page) =>
  page.getByTestId("board-open").allTextContents();

const rowFor = (page: Page, id: string) =>
  page.locator(`[data-testid="board-row"][data-board-id="${id}"]`);

const parseRoomLink = (url: string) => {
  const match = url.match(/#room=([A-Za-z0-9_-]+),([A-Za-z0-9_-]+)$/);
  if (!match) {
    throw new Error(`not a room link: ${url}`);
  }
  return { id: match[1], key: match[2] };
};

/** The editor mounts its canvases before it accepts pointer input. */
const openEditor = async (page: Page) => {
  await page.locator("canvas.interactive").waitFor({ timeout: 30_000 });
  await page.waitForTimeout(2500);
};

/**
 * Right-hand side on purpose: the left is covered by the shape-properties
 * island once a tool is active, the middle by the welcome screen.
 */
const drawRectangle = async (page: Page) => {
  await page.locator('.App-toolbar [title^="Rectangle"]').click();
  await page.waitForTimeout(300);
  await page.mouse.move(950, 200);
  await page.mouse.down();
  await page.mouse.move(1050, 300, { steps: 8 });
  await page.mouse.move(1150, 400, { steps: 8 });
  await page.mouse.up();
};

const collabUsername = (page: Page) =>
  page.evaluate(() => {
    const raw = localStorage.getItem("excalidraw-collab");
    return raw ? (JSON.parse(raw).username as string) : null;
  });

test.beforeAll(async ({ browser }) => {
  alice = await makeContext(browser, ALICE);
  bob = await makeContext(browser, BOB);
  wall = await makeContext(browser);
});

test.afterAll(async () => {
  await Promise.all([alice?.close(), bob?.close(), wall?.close()]);
});

test("the stack under test is the rehearsal, and it sees three identities", async ({
  request,
}) => {
  expect((await (await request.get(`${ORIGIN}/api/health`)).json()).ok).toBe(
    true,
  );

  const me = async (login?: string) =>
    (
      await request.get(`${ORIGIN}/api/me`, {
        headers: login ? { "Tailscale-User-Login": login } : {},
      })
    ).json();

  expect(await me(ALICE)).toMatchObject({ login: ALICE, via: "tailnet" });
  expect(await me(BOB)).toMatchObject({ login: BOB, via: "tailnet" });
  expect(await me()).toMatchObject({ login: "wall", via: "wall" });
});

test("alice lands on an empty boards page and creates two boards", async () => {
  const page = await boardsPage(alice);

  await expect(page.getByTestId("boards-identity")).toHaveText(ALICE);
  await expect(page.getByTestId("boards-empty")).toBeVisible();

  // ---- first board, created entirely from the keyboard -------------------
  await page.getByTestId("boards-new").click();
  await expect(page.getByTestId("boards-new-name")).toBeFocused();
  await page.keyboard.type(older.name);
  await page.keyboard.press("Enter");

  await page.waitForURL(/#room=/, { timeout: 30_000 });
  Object.assign(older, parseRoomLink(page.url()));
  await openEditor(page);

  // phase 3 §2: the collaborator name is the EDGE identity, not a random one
  await expect.poll(() => collabUsername(page)).toBe(ALICE);

  // ---- back to the list through the main menu affordance -----------------
  await page.getByTestId("main-menu-trigger").click();
  await page.getByTestId("menu-boards").click();
  await page.waitForURL(/\/boards$/, { timeout: 30_000 });
  await page.getByTestId("boards-page").waitFor();

  // ---- second board ------------------------------------------------------
  await page.getByTestId("boards-new").click();
  await page.getByTestId("boards-new-name").fill(newer.name);
  await page.getByTestId("boards-new-submit").click();
  await page.waitForURL(/#room=/, { timeout: 30_000 });
  newer.id = parseRoomLink(page.url()).id;
  expect(newer.id).not.toBe(older.id);

  await boardsPage(alice, page);
  // newest first, and "newest" right after creation is the one just made
  expect(await rowNames(page)).toEqual([newer.name, older.name]);
  await expect(rowFor(page, older.id).getByTestId("board-meta")).toContainText(
    `by ${ALICE}`,
  );
  await page.close();
});

test("bob drawing in the OLDER board moves it to the top of the list", async () => {
  const page = await bob.newPage();
  await page.goto(`/#room=${older.id},${older.key}`, {
    waitUntil: "domcontentloaded",
  });
  await openEditor(page);
  await expect.poll(() => collabUsername(page)).toBe(BOB);

  // the app throttles the full-scene save to 20 s, leading:false — wait for the
  // real PUT rather than for a wall-clock guess
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().includes(`/api/rooms/${older.id}`) &&
      response.ok(),
    { timeout: 60_000 },
  );
  await drawRectangle(page);
  await saved;
  await page.close();

  const alicePage = await boardsPage(alice);
  await expect
    .poll(() => rowNames(alicePage), { timeout: 20_000 })
    .toEqual([older.name, newer.name]);
  await expect(
    rowFor(alicePage, older.id).getByTestId("board-meta"),
  ).toContainText(`1 element · last edited by ${BOB}`);
  await alicePage.close();
});

test("bob renames a board inline; alice sees the new name on reload, and the order does not move", async () => {
  const page = await boardsPage(bob);
  const row = rowFor(page, older.id);

  await row.getByTestId("board-rename").click();
  const input = page.getByTestId("board-rename-input");
  await expect(input).toBeFocused();
  await input.fill("Ampere (renamed by bob)");
  await input.press("Enter");

  await expect(row.getByTestId("board-open")).toHaveText(
    "Ampere (renamed by bob)",
  );
  older.name = "Ampere (renamed by bob)";
  await page.close();

  const alicePage = await boardsPage(alice);
  // a rename must NOT bump updated_at — "newest edit first" means the newest
  // SCENE edit, so renaming does not reshuffle the list
  expect(await rowNames(alicePage)).toEqual([older.name, newer.name]);
  await alicePage.close();
});

test("the wall may open and copy, but is shown no rename or delete control", async () => {
  const page = await boardsPage(wall);

  await expect(page.getByTestId("boards-identity")).toHaveText("Wall");
  await expect(page.getByTestId("board-row")).toHaveCount(2);
  // G-P3.1: PATCH/DELETE are 403 for via:"wall", so the controls are not there
  await expect(page.getByTestId("board-rename")).toHaveCount(0);
  await expect(page.getByTestId("board-delete")).toHaveCount(0);

  // ...and the hidden buttons are a convenience, not the boundary: the same two
  // writes, header-less and same-origin, must be refused by the BACKEND. A
  // regression that dropped requireNamedIdentity would otherwise leave every
  // gate in this file green.
  const wallWrite = (method: "patch" | "delete") =>
    wall.request[method](`${ORIGIN}/api/boards/${older.id}`, {
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      data: method === "patch" ? { name: "wall was here" } : undefined,
    });
  expect((await wallWrite("patch")).status()).toBe(403);
  expect((await wallWrite("delete")).status()).toBe(403);

  const row = rowFor(page, older.id);
  await expect(row.getByTestId("board-copy")).toBeEnabled();
  await row.getByTestId("board-copy").click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(`${ORIGIN}/#room=${older.id},${older.key}`);

  // "works" = it opens that board, with the rectangle bob drew in it
  await page.goto(copied, { waitUntil: "domcontentloaded" });
  await openEditor(page);
  await expect.poll(() => collabUsername(page)).toBe("Wall");
  const ink = await page.evaluate(() => {
    const canvas = document.querySelector(
      "canvas.static",
    ) as HTMLCanvasElement | null;
    if (!canvas) {
      return -1;
    }
    const { data } = canvas
      .getContext("2d")!
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
  expect(ink).toBeGreaterThan(200);
  await page.close();
});

test("a board whose roomKey was never stored offers no way to open or share it", async ({
  request,
}) => {
  // G-P3.2: rows like this exist from before phase 1 stored the key with the
  // board, and there is no backfill route. Seeded through the API because the
  // app can no longer create one.
  const created = await request.post(`${ORIGIN}/api/boards`, {
    headers: {
      "Tailscale-User-Login": ALICE,
      "Content-Type": "application/json",
    },
    data: { id: legacy.id, roomKey: "", name: legacy.name },
  });
  expect(created.status()).toBe(201);

  const page = await boardsPage(alice);
  const row = rowFor(page, legacy.id);

  // no link means no OPEN either: clicking the name used to navigate to
  // "#room=legacyboard0000," — a hash the editor ignores, so the user landed in
  // their own private local scene wearing that board's name
  await expect(row.getByTestId("board-open")).toHaveCount(0);
  await expect(row.getByTestId("board-copy")).toHaveCount(0);
  await expect(row.getByTestId("board-name-unopenable")).toHaveText(legacy.name);
  await expect(row.getByTestId("board-no-link")).toBeVisible();
  await page.close();
});

test("bob deletes the board with a scene: alice's list drops it and its link 404s without crashing the app", async () => {
  const page = await boardsPage(bob);
  const row = rowFor(page, older.id);

  // Escape must back out of the confirm dialog without deleting anything
  await row.getByTestId("board-delete").click();
  await expect(page.getByTestId("board-delete-confirm")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("board-delete-confirm")).toHaveCount(0);
  await expect(row).toHaveCount(1);

  await row.getByTestId("board-delete").click();
  await expect(page.getByTestId("board-delete-confirm-yes")).toBeFocused();
  await page.getByTestId("board-delete-confirm-yes").click();
  await expect(row).toHaveCount(0);
  await page.close();

  const alicePage = await boardsPage(alice);
  await expect(rowFor(alicePage, older.id)).toHaveCount(0);
  await expect(rowFor(alicePage, newer.id)).toHaveCount(1);
  await alicePage.close();

  const gone = await alice.request.get(`${ORIGIN}/api/rooms/${older.id}`);
  expect(gone.status()).toBe(404);

  // the old link is still pasted in someone's chat: it must open an EMPTY
  // board, not a broken app
  const stale = await alice.newPage();
  await stale.goto(`/#room=${older.id},${older.key}`, {
    waitUntil: "domcontentloaded",
  });
  await openEditor(stale);
  await expect(stale.locator("canvas.static")).toBeVisible();
  await stale.close();
});

test("the row's secondary buttons look like buttons in the default light theme", async () => {
  // regression: `--island-bg-color-alt` is #fff in light theme, the same colour
  // as the row behind it, with a transparent border — so "Copy link"/"Rename"
  // rendered as plain text and only "New board" looked clickable. Dark theme
  // happened to be fine, which is why a screenshot of one theme did not show it.
  const page = await boardsPage(alice);
  const row = page.getByTestId("board-row").first();

  const paint = await row.evaluate((element) => {
    const button = element.querySelector(
      '[data-testid="board-copy"], [data-testid="board-rename"]',
    ) as HTMLElement;
    const style = getComputedStyle(button);
    return {
      row: getComputedStyle(element).backgroundColor,
      background: style.backgroundColor,
      border: style.borderTopColor,
    };
  });

  expect(paint.background).not.toBe(paint.row);
  expect(paint.border).not.toBe("rgba(0, 0, 0, 0)");
  await page.close();
});

/**
 * The two ways out of a live board. Both used to lose everything drawn since
 * the last throttled save (SYNC_FULL_SCENE_INTERVAL_MS = 20 s, leading:false):
 * Back is a same-document hash change, so nothing unloads and no beforeunload
 * can warn; the main-menu item unloads, but the unload path only closes the
 * socket. Each now flushes the scene first.
 */
test("Back out of a board keeps what was drawn", async () => {
  const page = await alice.newPage();
  // start at the BARE origin, which is the list: opening a board from here is
  // an in-place hash swap, which is exactly the case that cannot unload
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("boards-page").waitFor();

  await page.getByTestId("boards-new").click();
  await page.getByTestId("boards-new-name").fill("Back button board");
  await page.getByTestId("boards-new-submit").click();
  await page.waitForURL(/#room=/, { timeout: 30_000 });
  const board = parseRoomLink(page.url());
  await openEditor(page);

  await drawRectangle(page);
  // immediately: the throttled save is ~20 s away, so anything saved here was
  // saved BECAUSE of the navigation
  await page.goBack();
  await page.getByTestId("boards-page").waitFor({ timeout: 30_000 });

  const scene = await alice.request.get(`${ORIGIN}/api/rooms/${board.id}`);
  expect(scene.status()).toBe(200);
  expect((await scene.json()).elements.length).toBe(1);

  await expect(
    rowFor(page, board.id).getByTestId("board-meta"),
  ).toContainText("1 element");
  await page.close();
});

test("the main menu's Boards item saves too, and does not prompt on the way out", async () => {
  const page = await alice.newPage();
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });

  await page.goto("/boards", { waitUntil: "domcontentloaded" });
  await page.getByTestId("boards-new").click();
  await page.getByTestId("boards-new-name").fill("Menu exit board");
  await page.getByTestId("boards-new-submit").click();
  await page.waitForURL(/#room=/, { timeout: 30_000 });
  const board = parseRoomLink(page.url());
  await openEditor(page);

  await drawRectangle(page);
  await page.getByTestId("main-menu-trigger").click();
  await page.getByTestId("menu-boards").click();
  await page.waitForURL(/\/boards$/, { timeout: 30_000 });
  await page.getByTestId("boards-page").waitFor();

  const scene = await alice.request.get(`${ORIGIN}/api/rooms/${board.id}`);
  expect(scene.status()).toBe(200);
  expect((await scene.json()).elements.length).toBe(1);
  // a "Leave site?" prompt here means the app navigated away from unsaved work
  expect(dialogs).toEqual([]);
  await page.close();
});

test("nothing in the run threw an uncaught error in the page", () => {
  expect(pageErrors).toEqual([]);
});
