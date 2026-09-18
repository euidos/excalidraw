import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import "../excalidraw-app/sentry";

import ExcalidrawApp from "./App";

window.__EXCALIDRAW_SHA__ = import.meta.env.VITE_APP_GIT_SHA;
const rootElement = document.getElementById("root")!;
const root = createRoot(rootElement);
// euidos: VITE_APP_ENABLE_PWA gates only the *dev* service worker upstream;
// a production build always registered one. Our deploys rsync a new build
// over the same origin, and a service worker would keep serving the previous
// bundle to the wall and to staff tabs, so registration is opt-in here too.
if (import.meta.env.VITE_APP_ENABLE_PWA === "true") {
  registerSW();
}
root.render(
  <StrictMode>
    <ExcalidrawApp />
  </StrictMode>,
);
