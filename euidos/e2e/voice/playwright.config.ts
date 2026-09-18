import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The voice gates, run against a BUILD of excalidraw-app (not the dev server): the toolbar button is injected
 * into the editor's own DOM and the fit measurements are font measurements, so the artifact under test has to be
 * the one that ships.
 *
 *   euidos/scripts/build-app.sh          # excalidraw-app/build/
 *   cd euidos/e2e/voice && npm run e2e   # serves that build on 127.0.0.1:4173
 *
 * 127.0.0.1 is load-bearing, not incidental: `contracts.defaultSttUrl` dials the STT server DIRECTLY from a
 * loopback origin and through `<origin>/stt` from anything else, so a suite served from loopback exercises the
 * same URL the kiosk build used and needs no proxy. The proxied branch is a deploy-time check against the tailnet
 * origin, not this suite's job.
 *
 * `curl -sf http://100.81.33.83:8770/health` must say `warm:true` BEFORE the run: the suite never probes it, so
 * its exit code cannot tell "this app regressed" from "the server was down" (voice CLAUDE.md, "Verifying").
 *
 * Paths here and in helpers.ts are resolved against the PROCESS cwd, so run it from this directory.
 */
const repoRoot = resolve(import.meta.dirname, "../../..");

export default defineConfig({
  testDir: ".",
  // Playwright wipes its output directory at the start of a run: with the default (test-results) that also wipes
  // the run log the report cites and the evidence screenshots written by earlier runs. Artifacts get their own
  // subdirectory so `tee test-results/last-run.txt` survives.
  outputDir: "test-results/artifacts",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  workers: 1,
  // Gate runs never retry (RETRO N8): a retry once absorbed a real race in G2 and the board read green. A flake
  // here is a failure, and the run log the report cites is written by the command in voice-tool-CLAUDE.md.
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: true,
    viewport: { width: 1600, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        `--use-file-for-fake-audio-capture=${resolve("fixtures/jfk.wav")}`,
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
  webServer: {
    // vite preview serves excalidraw-app's own outDir (build/); nothing is rebuilt here, so a stale build is a
    // stale run — build first.
    command: "npx vite preview --host 127.0.0.1 --port 4173 --strictPort",
    cwd: resolve(repoRoot, "excalidraw-app"),
    // excalidraw-app's vite config sets `server.open: true` and `preview` inherits it, so without this vite tries
    // to spawn xdg-open and dies on a headless box the instant it has started listening.
    env: { BROWSER: "none" },
    url: "http://127.0.0.1:4173",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
