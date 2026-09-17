// Scaffold only — the integrator replaces this with the wired app (see src/contracts.ts).
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";

export default function App() {
  return (
    <div style={{ height: "100vh", width: "100vw" }}>
      <Excalidraw />
    </div>
  );
}
