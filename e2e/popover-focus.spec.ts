import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * Popovers return focus when they close — WCAG 2.4.3 (Focus Order).
 *
 * A modal is expected to manage focus and this app's does. A POPOVER is the
 * case people forget: open one with the keyboard, press Escape, and if nothing
 * puts focus back on the trigger it lands on `document.body`. The next Tab
 * then restarts from the top of the app, so a keyboard user who checks the
 * volume popover is thrown back to the nav rail and has to walk the whole
 * toolbar again.
 *
 * It is invisible with a mouse, which is why it survives: the popover opens,
 * closes, and looks completely correct.
 */

const TRIGGERS = [
  "Notifications",
  "Canvas aspect and view options",
  "Volume",
] as const;

async function boot(page: Page): Promise<void> {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+3");
  await expect(page.locator(".cp-toolbar")).toBeVisible();
}

const activeLabel = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    if (!a || a === document.body) return "BODY";
    return (a.getAttribute("aria-label") || a.textContent || a.tagName).trim().slice(0, 40);
  });

for (const label of TRIGGERS) {
  test(`"${label}" gives focus back when Escape closes it`, async ({ page }) => {
    await boot(page);
    const trigger = page.locator(`button[aria-label="${label}"]`).first();
    await expect(trigger).toBeVisible();
    // Focus is asserted by POLLING a re-focus, for the same reason the press
    // below goes through the locator: this toolbar re-renders constantly, and
    // a node replaced between focus() and the read leaves activeElement on
    // BODY forever. A plain expect() catches that once and fails; retrying the
    // read alone cannot fix it either, because focus is genuinely gone. Only
    // re-focusing each attempt recovers, which is why the closure does both.
    await expect
      .poll(async () => { await trigger.focus(); return activeLabel(page); },
            { message: "could not focus the trigger to begin with" })
      .toBe(label);

    // Pressed ON the locator, not on the page: focus() followed by a page-level
    // keypress races a re-render - this app re-renders the toolbar constantly
    // (playhead, ambient backdrop) and the button node can be replaced between
    // the two calls, so the key lands on a detached element. That was the
    // remaining flake after the sleeps went.
    await trigger.press("Enter");
    // Auto-retrying assertions, not sleeps. The first version of this spec
    // waited fixed 120ms and was FLAKY under parallel workers - two different
    // tests in it failed on two consecutive runs, which is worse than no test:
    // it teaches you to re-run until green.
    await expect(trigger, "Enter did not open it, so the rest proves nothing")
      .toHaveAttribute("aria-expanded", "true");

    await trigger.press("Escape");
    await expect(trigger, "Escape did not close it").toHaveAttribute("aria-expanded", "false");

    await expect
      .poll(() => activeLabel(page), {
        message: "focus was dropped on close; the next Tab restarts from the top of the app",
      })
      .toBe(label);
  });
}

/**
 * ...and their contents are reachable by keyboard once open.
 *
 * These popovers never move focus into themselves - which is why the tests
 * above pass trivially, since focus never leaves the trigger. That is only
 * acceptable if Tab then walks INTO the popover. A panel rendered through a
 * portal at the end of <body> sits beside the trigger on screen and nowhere
 * near it in the DOM, so Tab would go to the next toolbar button instead and
 * the contents could not be reached by keyboard at all.
 *
 * "Inside the popover" is decided STRUCTURALLY: snapshot the focusable
 * elements before opening, and the ones that appear afterwards are the
 * popover's. The first version of this asked whether the focused element
 * matched a list of popover class names that I had guessed at - `.cp-volume-pop`
 * where the real class is `.cp-volume-popover` - and duly reported all three
 * as broken. They were fine. Guessing an identifier and then believing the
 * failure is a good way to invent a bug.
 */
for (const label of TRIGGERS) {
  test(`"${label}" contents are reachable by Tab`, async ({ page }) => {
    await boot(page);
    const trigger = page.locator(`button[aria-label="${label}"]`).first();
    await trigger.focus();

    // Mark every control that exists BEFORE opening. Identifying them by label
    // instead was ambiguous: "Mute" appears both in the toolbar and inside the
    // volume popover, so the popover's copy looked like an element that had
    // always been there and the test flickered between pass and fail.
    const SEEN = "data-pf-seen";
    await page.evaluate((attr) => {
      document.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]:not([tabindex='-1'])")
        .forEach((e) => e.setAttribute(attr, "1"));
    }, SEEN);
    // Pressed ON the locator, not on the page: focus() followed by a page-level
    // keypress races a re-render - this app re-renders the toolbar constantly
    // (playhead, ambient backdrop) and the button node can be replaced between
    // the two calls, so the key lands on a detached element. That was the
    // remaining flake after the sleeps went.
    await trigger.press("Enter");
    await expect(trigger, "Enter did not open it").toHaveAttribute("aria-expanded", "true");

    const appeared = await page.evaluate((attr) =>
      Array.from(document.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]:not([tabindex='-1'])"))
        .filter((e) => !e.hasAttribute(attr) && e.checkVisibility())
        .map((e) => (e.getAttribute("aria-label") || e.textContent || e.tagName).trim().slice(0, 40)), SEEN);

    // An EMPTY popover has nothing to tab to, and the notifications panel is
    // empty until something notifies. That is not a defect, so the reachable
    // question becomes the one that actually matters for a portalled panel:
    // did opening it put focus somewhere a keyboard user can work from? If
    // focus stayed on the trigger and the panel is across the document, the
    // panel is unreachable the moment it does have contents.
    if (appeared.length === 0) {
      const where = await page.evaluate((l) => {
        const a = document.activeElement as HTMLElement | null;
        if (!a || a === document.body) return "BODY";
        const trig = document.querySelector(`button[aria-label="${l}"]`);
        return a === trig ? "STILL-ON-TRIGGER" : "MOVED-INTO-PANEL";
      }, label);
      // Must have MOVED, not merely "not body". Checking only for body let the
      // regression through: with the fix reverted focus simply stayed on the
      // trigger, which is not body, and the test passed while the panel sat
      // unreachable across the document.
      await expect
        .poll(async () => where, {
          message: "the panel is empty and took no focus, so once it HAS content " +
            "there is no way to tab to it - it is portalled away from its trigger",
        })
        .toBe("MOVED-INTO-PANEL");
      return;
    }

    // A few tabs, not one. The view-options cluster has a SECOND trigger
    // sitting between the first and its panel, so landing there is correct
    // document order rather than a defect - an earlier version of this test
    // insisted on the very next Tab and called that a bug.
    const walked: string[] = [];
    let reached = false;
    for (let i = 0; i < 4 && !reached; i += 1) {
      await page.keyboard.press("Tab");
      // One frame for focus to move. There is no state to assert on here -
      // the question IS where focus landed - so this is the one wait that
      // cannot become an assertion.
      await page.waitForTimeout(50);
      const at = await page.evaluate(() => {
        const a = document.activeElement as HTMLElement | null;
        return a ? (a.getAttribute("aria-label") || a.textContent || a.tagName).trim().slice(0, 40) : "none";
      });
      walked.push(at);
      if (appeared.includes(at)) reached = true;
    }
    expect(
      reached,
      `Tab walked ${JSON.stringify(walked)} without reaching any of the controls the ` +
        `popover revealed (${JSON.stringify(appeared.slice(0, 4))}), so they are not keyboard reachable`,
    ).toBe(true);
  });
}
