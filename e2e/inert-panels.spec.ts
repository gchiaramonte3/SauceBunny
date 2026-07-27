import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * A collapsed panel must be genuinely unreachable, not merely silent.
 *
 * Both panels close by animating to width: 0 with overflow: hidden — not
 * display: none — so their controls stayed focusable, while aria-hidden told
 * the screen reader to describe none of them. Tab walked ~40 invisible
 * controls including "Export N clips": an unannounced path to a destructive
 * button, which is worse than either problem on its own.
 */
async function boot(page: Page): Promise<void> {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Control+3");
  await expect(page.locator(".cp-toolbar")).toBeVisible();
}

/** Focusable descendants a keyboard user could actually land on. */
const focusableIn = (page: Page, sel: string) => page.evaluate((s) => {
  const root = document.querySelector(s);
  if (!root) return -1;
  const q = "a[href],button,input,select,textarea,[tabindex]:not([tabindex='-1'])";
  return [...root.querySelectorAll<HTMLElement>(q)]
    // An inert subtree reports no focus target; this is what we are asserting.
    .filter((el) => !el.closest("[inert]"))
    .length;
}, sel);

test("a collapsed queue drawer has no focusable controls", async ({ page }) => {
  await boot(page);
  const drawer = page.locator(".cp-queue-drawer").first();
  // The drawer opens with the Clip view; close it the way a user would.
  await expect(drawer).toHaveClass(/open/);
  await page.keyboard.press("Control+Shift+Q");
  await expect(drawer).not.toHaveClass(/open/);

  await expect(drawer).toHaveAttribute("aria-hidden", "true");
  await expect(drawer).toHaveAttribute("inert", "");
  expect(await focusableIn(page, ".cp-queue-drawer")).toBe(0);
});

test("reopening the drawer restores its controls", async ({ page }) => {
  // The other half, and the reason inertWhen returns an object to spread
  // rather than a value to assign: `inert` is presence-based like `disabled`,
  // so inert="false" is STILL inert. Setting it falsey would freeze the panel
  // permanently while looking perfectly correct in the JSX.
  await boot(page);
  const drawer = page.locator(".cp-queue-drawer").first();
  await page.keyboard.press("Control+Shift+Q");   // close
  await expect(drawer).toHaveAttribute("inert", "");
  await page.keyboard.press("Control+Shift+Q");   // and open again
  await expect(drawer).toHaveClass(/open/);
  await expect(drawer).not.toHaveAttribute("inert", /.*/);
  expect(await focusableIn(page, ".cp-queue-drawer")).toBeGreaterThan(0);
});
