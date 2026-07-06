import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * UI smoke — boots the real frontend bundle in Chromium with Tauri IPC mocked
 * (see tauri-mock.ts) and proves the shell renders and its chrome is wired.
 * Not a pixel test and not the native pipeline: it exists to catch "the app
 * white-screens on launch" and "the popover/modal wiring broke" classes of
 * regression that tsc + vitest can't see.
 */

const pageErrors: string[] = [];

async function boot(page: Page): Promise<void> {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  // Latch the one-time first-run prompt (YouTube sign-in welcome) — its
  // backdrop would otherwise intercept every click in the suite.
  // (App.tsx DEFAULTS_KEY — the cp- prefix is the project-wide carryover.)
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
  });
  await page.goto("/");
  // The app shell is up once the toolbar renders.
  await expect(page.locator(".cp-toolbar")).toBeVisible({ timeout: 15_000 });
}

test("shell boots: toolbar, sidebar, monitor render without pageerrors", async ({ page }) => {
  await boot(page);
  await expect(page.locator(".cp-wordmark")).toContainText("sauce bunny");
  await expect(page.locator(".cp-sidebar")).toBeVisible();
  await expect(page.locator(".cp-monitor-area")).toBeVisible();
  // No stale-binary warning — the mocked build-id matches the frontend's.
  await expect(page.getByText(/stale/i)).toHaveCount(0);
  expect(pageErrors, `pageerrors:\n${pageErrors.join("\n")}`).toHaveLength(0);
});

test("settings modal opens and closes", async ({ page }) => {
  await boot(page);
  await page.getByTitle("Settings (⌘,)").click();
  await expect(page.getByText("Settings", { exact: true }).first()).toBeVisible();
  await page.keyboard.press("Escape");
  expect(pageErrors, `pageerrors:\n${pageErrors.join("\n")}`).toHaveLength(0);
});

test("co-review popover opens with session-first Start available", async ({ page }) => {
  await boot(page);
  await page.getByLabel("Co-review session").click();
  const pop = page.locator(".cp-coreview-pop");
  await expect(pop).toBeVisible();
  // Session-first: Start is enabled even with no source loaded.
  await expect(pop.getByRole("button", { name: "Start a session" })).toBeEnabled();
  await expect(pop.getByPlaceholder("Paste a join code…")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
  expect(pageErrors, `pageerrors:\n${pageErrors.join("\n")}`).toHaveLength(0);
});

test("side panel toggles open", async ({ page }) => {
  await boot(page);
  await page.locator(".cp-queue-toggle").click();
  await expect(page.locator(".cp-queue-drawer.open")).toBeVisible();
  expect(pageErrors, `pageerrors:\n${pageErrors.join("\n")}`).toHaveLength(0);
});

test("transcript tab shows the empty state with Generate gated on a source", async ({ page }) => {
  await boot(page);
  await page.locator(".cp-queue-toggle").click();
  await page.getByRole("tab", { name: /Transcript/ }).click();
  const empty = page.locator(".cp-tx-empty");
  await expect(empty).toBeVisible();
  await expect(empty.getByText("No transcript yet")).toBeVisible();
  // No source loaded in the smoke run → the primary action is disabled with
  // a hint, while Import stays available.
  await expect(empty.getByRole("button", { name: "Generate transcript" })).toBeDisabled();
  await expect(empty.getByRole("button", { name: "Import transcript…" })).toBeEnabled();
  await expect(page.locator(".cp-tx-empty-hint")).toBeVisible();
  expect(pageErrors, `pageerrors:\n${pageErrors.join("\n")}`).toHaveLength(0);
});
