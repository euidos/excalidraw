import { defineConfig } from "@playwright/test";

/**
 * The boards acceptance runs against a REHEARSAL of the real stack, not a dev
 * server and not the live host:
 *
 *   euidos/scripts/build-app.sh
 *   cd euidos/storage-backend && docker build -t euidos/boards-storage:e2e-boards .
 *   cd fleet-infra/stacks/euidos-internal
 *   docker compose -p boards-e2e --env-file <throwaway env> \
 *     -f compose.yaml -f <override publishing 127.0.0.1:18099 -> web:8081> \
 *     up -d db storage room web
 *   cd euidos/e2e/boards && ../node_modules/.bin/playwright test
 *   docker compose -p boards-e2e ... down -v
 *
 * WHY THE REAL STACK. Three of the things under test are enforced by nginx and
 * the backend, not by the app: the CSRF/415 guards on every write, the wall's
 * 403 on rename/delete, and identity itself. A mocked fetch cannot fail any of
 * them (phase-1 RETRO L2), so this suite drives the same containers the host
 * runs.
 *
 * WHY :18099 ON LOOPBACK. It is the TAILNET listener (nginx's :8081 block).
 * There is no Tailscale Serve in front of the rehearsal, so that block passes a
 * client-supplied `Tailscale-User-Login` through — which is exactly how this
 * suite gets THREE identities out of one origin: alice, bob, and (no header at
 * all) the wall. On the real host Serve strips client copies, so this is a
 * rehearsal affordance, not a hole. Nothing is ever published on 0.0.0.0.
 */
export default defineConfig({
  testDir: ".",
  outputDir: "test-results/artifacts",
  // a scene save is throttled to SYNC_FULL_SCENE_INTERVAL_MS (20 s, leading:false)
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  // Gate runs never retry: a flake here is a failure (voice suite's RETRO N8).
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.BOARDS_ORIGIN ?? "http://127.0.0.1:18099",
    headless: true,
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
