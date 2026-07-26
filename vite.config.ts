// vitest/config's defineConfig = vite's + the typed `test` block.
import { defineConfig, configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  test: {
    // e2e/ is Playwright's turf (npm run test:e2e) — vitest must not collect it.
    // .claude/ holds agent worktrees (full repo copies) — same rule applies.
    exclude: [...configDefaults.exclude, "e2e/**", ".claude/**"],
    // The default environment stays `node`. jsdom is roughly 200ms of setup
    // per file, and the overwhelming majority of these tests are pure
    // functions that have no use for a DOM. Component tests opt in with a
    // `// @vitest-environment jsdom` pragma on their first line, which keeps
    // the whole suite around a second.
    setupFiles: ["./src/test-setup.ts"],
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
