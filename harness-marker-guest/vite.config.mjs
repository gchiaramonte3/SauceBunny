import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
const root = process.env.SAUCE_MARKER_GUEST_ROOT;
if (!/^\/private\/tmp\/sauce-marker-guest\.[A-Za-z0-9]+$/.test(root ?? "")) {
  throw new Error("Build through scripts/build-marker-guest-test.sh with a fresh isolated test directory.");
}
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)), plugins: [react()],
  resolve: { alias: [{ find: /^@tauri-apps\/api\/core$/, replacement: fileURLToPath(new URL("core.ts", import.meta.url)) }] },
  define: { __BUILD_NUMBER__: JSON.stringify("marker-guest-test"), __MARKER_GUEST_ROOT__: JSON.stringify(root) },
  build: { target: "esnext", outDir: "/private/tmp/sauce-marker-guest-harness-dist", emptyOutDir: true },
});
