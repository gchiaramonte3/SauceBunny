import { defineConfig, devices } from "@playwright/test";

const packagedFrontend = process.env.SAUCE_PACKAGED_FRONTEND === "1";

/**
 * UI smoke harness (CLAUDE.md refactor item 5). Serves the frontend with the
 * dev-mode Vite server and runs the e2e/ specs in Chromium with the Tauri IPC
 * layer mocked. Run: `npm run test:e2e`.
 *
 * The port avoids `tauri dev` (1420) and, since r162, also avoids 4173 -
 * Vite's DEFAULT preview port, which any other Vite project on the machine
 * will happily take. `reuseExistingServer` then hands the whole suite to
 * whatever is listening, so the run does not fail, it passes and fails
 * against someone else's app: 129 specs reported "element not found" for
 * `.cp-view-home` because the page being served was a different project
 * entirely. A wrong answer that looks like a real one is worse than a
 * crash, and it cost two full gate runs before the cause was found.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:51730",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Opt-in checks exercise the exact dist/ about to ship; IPC is still
    // mocked, so this is not a native WKWebView certification.
    command: packagedFrontend
      ? "npx vite preview --port 51730 --strictPort"
      : "SAUCE_BROWSER_TEST=1 npx vite --port 51730",
    url: "http://localhost:51730",
    reuseExistingServer: !packagedFrontend && !process.env.CI,
    timeout: 60_000,
  },
});
