// vitest/config's defineConfig = vite's + the typed `test` block.
import { defineConfig, configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  test: {
    // e2e/ is Playwright's turf (npm run test:e2e) — vitest must not collect it.
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
