import { defineConfig, devices } from "@playwright/test";

/**
 * UI smoke harness (CLAUDE.md refactor item 5). Serves the frontend with the
 * dev-mode Vite server on a port that can't collide with `tauri dev` (1420)
 * and runs the e2e/ specs in Chromium with the Tauri IPC layer mocked.
 * Run: `npm run test:e2e`.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:4173",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx vite --port 4173",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
