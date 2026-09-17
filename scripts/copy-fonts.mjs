// Copies the library's font files to public/fonts so window.EXCALIDRAW_ASSET_PATH = "/" resolves them.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules/@excalidraw/excalidraw/dist/prod/fonts");
const dst = join(root, "public/fonts");
if (!existsSync(src)) throw new Error("fonts not found at " + src);
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });
console.log("fonts copied to", dst);
