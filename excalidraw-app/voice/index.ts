/**
 * The voice tool's public surface — the ONLY thing upstream files import.
 *
 * Every symbol the app needs is re-exported here so each upstream touchpoint costs one import line instead of
 * two. `excalidraw-app/App.tsx` and `components/AppMainMenu.tsx` are files upstream rewrites often, and every
 * inserted line in them is a rebase conflict hunk; `collab/Collab.tsx` reaches for `../voice/persist` directly
 * because it wants only the pure sweep and has no business pulling a React component in.
 */
export {
  VoiceTool,
  VoiceSettingsMenuItem,
  openVoiceSettings,
} from "./VoiceTool";
export { LIVE_SCAFFOLDING_MS, sweepGhostPlaceholders } from "./persist";
export { isVoiceEnabled } from "./enabled";
