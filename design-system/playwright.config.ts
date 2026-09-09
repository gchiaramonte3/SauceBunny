import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "catalog.browser.ts",
  outputDir: "../test-results/design-catalog",
  timeout: 30_000,
  fullyParallel: true,
  use: { baseURL: "http://127.0.0.1:51731", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx vite --config vite.config.ts --host 127.0.0.1 --port 51731",
    cwd: "..",
    url: "http://127.0.0.1:51731/design-system.html",
    reuseExistingServer: !process.env.CI,
  },
});
