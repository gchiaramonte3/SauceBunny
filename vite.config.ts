// vitest/config's defineConfig = vite's + the typed `test` block.
import { defineConfig, configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

const host = process.env.TAURI_DEV_HOST;

/**
 * CFBundleVersion, read from the one file that declares it.
 *
 * The About tab has always SAID the build number is what distinguishes two
 * DMGs of the same semver — and then rendered the semver alone, so four
 * builds of 0.2.0 were one indistinguishable string in the only place a user
 * can check what they are running. Injected here rather than fetched through
 * a Tauri command because it is a build-time constant: scripts/set-version.sh
 * writes it into tauri.conf.json, and this reads that same value, so the
 * number on screen cannot drift from the number in the bundle.
 */
const buildNumber: string =
  JSON.parse(readFileSync("./src-tauri/tauri.conf.json", "utf8"))
    ?.bundle?.macOS?.bundleVersion ?? "dev";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  define: { __BUILD_NUMBER__: JSON.stringify(buildNumber) },
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
