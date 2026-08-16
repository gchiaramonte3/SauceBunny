import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * Modal focus — WCAG 2.1.2 (No Keyboard Trap, inverted) and 2.4.3 (Focus
 * Order).
 *
 * A modal owes a keyboard user three things: focus moves INTO it when it
 * opens, Tab cannot walk out of it into the page behind, and closing it puts
 * focus back where it came from. Miss the second and Tab silently lands on
 * controls the user cannot see, still covered by a backdrop. Miss the third
 * and focus resets to the top of the document, so the next Tab starts the
 * whole app again from the nav rail.
 *
 * None of that is visible without keyboard testing, which is why it goes
 * unnoticed: the modal looks perfect and behaves perfectly with a mouse.
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

/** Is the active element inside `selector`? */
async function focusInside(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    const a = document.activeElement;
    return !!root && !!a && a !== document.body && root.contains(a);
  }, selector);
}

async function activeDescription(page: Page): Promise<string> {
  return page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    if (!a) return "none";
    return `${a.tagName.toLowerCase()}.${(a.className || "").toString().split(" ")[0]} "${
      (a.getAttribute("aria-label") || a.textContent || "").trim().slice(0, 24)}"`;
  });
}

test("the settings modal takes focus, keeps it, and gives it back", async ({ page }) => {
  await boot(page);
  const gear = page.locator('[aria-label="Settings"]').first();
  await expect(gear).toBeVisible();
  await gear.focus();
  const trigger = await activeDescription(page);
  await gear.press("Enter");
  await expect(page.locator(".cp-modal, [role=\"dialog\"]").first()).toBeVisible();

  // 1. Focus moved in. A modal that opens with focus still on the trigger
  //    behind the backdrop leaves the first Tab landing somewhere arbitrary.
  expect(
    await focusInside(page, ".cp-modal, [role=\"dialog\"]"),
    `focus stayed outside the modal, on ${await activeDescription(page)}`,
  ).toBe(true);

  // 2. Tab cannot walk out. Twenty-five is past the end of any single
  //    section's controls, so a missing trap shows up rather than being
  //    outrun by a long form.
  const escaped: string[] = [];
  for (let i = 0; i < 25; i += 1) {
    await page.keyboard.press("Tab");
    if (!(await focusInside(page, ".cp-modal, [role=\"dialog\"]"))) {
      escaped.push(`after ${i + 1} tabs: ${await activeDescription(page)}`);
      break;
    }
  }
  expect(escaped, "Tab reached the page behind the modal").toEqual([]);

  // 3. Closing returns focus to what opened it.
  await page.keyboard.press("Escape");
  await expect(page.locator(".cp-modal, [role=\"dialog\"]").first()).toHaveCount(0);
  expect(await activeDescription(page), "focus did not return to the trigger").toBe(trigger);
});

test("shift-tab cannot walk backwards out either", async ({ page }) => {
  // The half that gets forgotten: a trap built by wrapping the LAST element
  // to the first handles Tab and lets Shift+Tab leave from the first.
  await boot(page);
  const gear = page.locator('[aria-label="Settings"]').first();
  await gear.click();
  await expect(page.locator(".cp-modal, [role=\"dialog\"]").first()).toBeVisible();

  const escaped: string[] = [];
  for (let i = 0; i < 15; i += 1) {
    await page.keyboard.press("Shift+Tab");
    if (!(await focusInside(page, ".cp-modal, [role=\"dialog\"]"))) {
      escaped.push(`after ${i + 1} shift-tabs: ${await activeDescription(page)}`);
      break;
    }
  }
  expect(escaped, "Shift+Tab reached the page behind the modal").toEqual([]);
});
