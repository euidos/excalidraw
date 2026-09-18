import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

// The fake microphone is fed per test through a fresh browser context (see test/e2e/helpers.ts); the
// default context here only guarantees the flags that every test needs.
export default defineConfig({
  testDir: "test/e2e",
  // Playwright wipes its output directory at the start of a run: with the default (test-results) that also wipes
  // the run log the report cites and the evidence screenshots written by earlier runs. Artifacts get their own
  // subdirectory so `tee test-results/last-run.txt` survives.
  outputDir: "test-results/artifacts",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  workers: 1,
  // Gate runs never retry (RETRO N8): a retry once absorbed a real race in G2 and the board read green. A flake
  // here is a failure, and the run log the report cites is written by the command in CLAUDE.md.
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
        `--use-file-for-fake-audio-capture=${resolve("test/fixtures/jfk.wav")}`,
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
  webServer: {
    command: "npm run preview",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
