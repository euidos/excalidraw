import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

// The fake microphone is fed per test through a fresh browser context (see test/e2e/helpers.ts); the
// default context here only guarantees the flags that every test needs.
export default defineConfig({
  testDir: "test/e2e",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  workers: 1,
  // The STT server is real: a ~1 s segment occasionally decodes to an empty transcript, which the app then
  // (correctly) treats as "nothing was said". One retry keeps that server-side nondeterminism from reading
  // as a product failure; a genuine defect fails both attempts.
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
