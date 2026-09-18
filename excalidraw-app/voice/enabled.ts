/**
 * The fork's kill switch for the voice tool.
 *
 * Everything else in this directory is fork-only code grafted onto an upstream app, and phase 1 already
 * established the pattern for exactly that: `VITE_APP_ENABLE_PWA` gates the service worker, `VITE_APP_ENABLE_
 * TRACKING` the analytics. The voice tool is the largest such surface — it injects a button into the editor's own
 * toolbar row, adds a main-menu item and asks for the microphone — and all three of those are things a bad rebase
 * against upstream's markup, or a public Access origin where nobody speaks, may want off without a code change.
 *
 * FAIL-OPEN on purpose: only the literal string "false" disables it, so the e2e suite, the kiosk build and a
 * plain `yarn start` (none of which set the variable) are unaffected. Read at call time rather than captured in a
 * module constant so a test can stub it.
 */
export const isVoiceEnabled = (): boolean =>
  import.meta.env.VITE_APP_ENABLE_VOICE !== "false";
