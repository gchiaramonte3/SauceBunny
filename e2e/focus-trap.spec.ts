import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * Modal focus — WCAG 2.1.2 (No Keyboard Trap, inverted) and 2.4.3 (Focus
 * Order).
 *
 * A modal owes a keyboard user FOUR things: focus moves INTO it when it opens,
 * Tab REACHES its controls, Tab cannot walk out of it into the page behind,
 * and closing it puts focus back where it came from. Miss the third and Tab
 * silently lands on controls the user cannot see, still covered by a backdrop.
 * Miss the fourth and focus resets to the top of the document, so the next Tab
 * starts the whole app again from the nav rail.
 *
 * The second is here because it was MISSING, and its absence was not academic.
 * These tests only asked whether focus escaped, so a trap that swallowed every
 * Tab and moved focus nowhere at all passed both of them - the dialog would be
 * open with not one control reachable, and this file would be green. Verified
 * by freezing the trap on purpose: both tests passed.
 *
 * That is also the precise shape `use-modal-focus` fails in. It bails with
 * `preventDefault()` when its focusable list comes back empty, and that list
 * was until recently filtered by `offsetParent !== null` - null for every
 * `position: fixed` element. A dialog built entirely from fixed controls would
 * have frozen exactly this way. So the walk below now records WHERE focus
 * lands, not just whether it stayed.
 *
 * None of it is visible without keyboard testing, which is why it goes
 * unnoticed: the modal looks perfect and behaves perfectly with a mouse.
 */

async function boot(page: Page): Promise<void> {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.permissioned", "1");
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+3");
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

const MODAL = '.cp-modal, [role="dialog"]';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), '
  + 'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Press `key` n times, recording where focus lands each time and the first
 * press that left the modal.
 *
 * Identity is the control's INDEX among the dialog's focusables, not its label.
 * Labels looked fine and are not: one of the stops is a select reading "Off,
 * keep everything2 GB", whose text carries a live cache size, so the same
 * control can describe itself two ways between two presses and shift a
 * distinct-count that is supposed to be exact. Index is stable under that.
 * The label is still collected, but only to make a failure readable.
 */
async function walk(page: Page, key: string, presses: number) {
  const visited: number[] = [];
  const labels: string[] = [];
  const escaped: string[] = [];
  for (let i = 0; i < presses; i += 1) {
    await page.keyboard.press(key);
    if (!(await focusInside(page, MODAL))) {
      escaped.push(`after ${i + 1} ${key}: ${await activeDescription(page)}`);
      break;
    }
    visited.push(await page.evaluate(([sel, F]) => {
      const root = document.querySelector(sel);
      if (!root) return -1;
      return [...root.querySelectorAll<HTMLElement>(F)].indexOf(document.activeElement as HTMLElement);
    }, [MODAL, FOCUSABLE] as const));
    labels.push(await activeDescription(page));
  }
  return { visited, labels, escaped, distinct: new Set(visited).size };
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
  const tab = await walk(page, "Tab", 25);
  expect(tab.escaped, "Tab reached the page behind the modal").toEqual([]);

  // 3. ...and Tab REACHES things. Without this the assertion above is
  //    satisfied by a trap that swallows every Tab and moves focus nowhere,
  //    which is a worse dialog than a leaky one: nothing in it is operable.
  //
  //    EVERY press must reach a control not seen yet. That is measured, not
  //    aspirational - the walk currently returns 25 distinct stops from 25
  //    presses, so focus advances by exactly one control each time and never
  //    doubles back. It holds because the settings dialog has ~41 focusable
  //    controls, comfortably more than the 25 presses; strip it below that and
  //    this fails, correctly, asking for the count to be revisited.
  expect(
    tab.distinct,
    `Tab revisited a control or stopped advancing (${tab.distinct} distinct in 25): ` +
      `${tab.labels.join(" | ")}`,
  ).toBe(25);

  // 4. Closing returns focus to what opened it.
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

  const back = await walk(page, "Shift+Tab", 15);
  expect(back.escaped, "Shift+Tab reached the page behind the modal").toEqual([]);
  // Same rule backwards: fifteen presses, fifteen controls, no repeats.
  expect(
    back.distinct,
    `Shift+Tab revisited a control or stopped advancing (${back.distinct} distinct in 15): ` +
      `${back.labels.join(" | ")}`,
  ).toBe(15);
});
