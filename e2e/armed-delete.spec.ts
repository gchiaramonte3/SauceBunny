import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * The armed model Delete, in a real browser.
 *
 * The vitest suite drives the same component in jsdom and proves the state
 * machine: one click arms, two deletes, Escape cancels the arming instead of
 * closing Settings. What it CANNOT prove is the half that lives in CSS. jsdom
 * applies no stylesheet, so `.btn.armed` could be missing, misspelled, or
 * overridden by a later `.btn` rule and every unit test would still pass while
 * the armed button looked exactly like the ghost button beside it — which is
 * the entire point of the change. A destructive confirm the user cannot see is
 * not a confirm.
 *
 * So this asserts the computed style: the armed button's background must
 * actually differ from its own resting background, and from the sibling
 * control it used to be indistinguishable from.
 *
 * The mock lists one DOWNLOADED whisper model for this. That also un-blinded
 * the contrast / target-size / accessible-name sweeps, which had been walking
 * a Settings page whose entire model region rendered nothing.
 */

const pageErrors: string[] = [];

async function boot(page: Page): Promise<void> {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
}

/** Open Settings and land on the tab holding the whisper models. */
async function openModels(page: Page) {
  const gear = page.locator('[aria-label="Settings"], button:has-text("Settings")').first();
  await expect(gear, "no Settings control found").toHaveCount(1);
  await gear.click();
  await expect(page.locator('.cp-modal, [role="dialog"]').first()).toBeVisible();
  const tab = page.getByRole("button", { name: /Transcription/i }).first();
  if (await tab.count()) await tab.click();
  // Asserted, not assumed: if the model row stops rendering, every assertion
  // below would be querying nothing.
  const del = page.getByRole("button", { name: /^Delete Small/ });
  await expect(del, "no Delete button for the downloaded model").toHaveCount(1);
  return del;
}

const bg = (el: ReturnType<Page["locator"]>) =>
  el.evaluate((n) => getComputedStyle(n as HTMLElement).backgroundColor);

test("the armed Delete is visibly different from the button it used to look like", async ({ page }) => {
  await boot(page);
  const del = await openModels(page);

  const restingDelete = await bg(del);
  const sibling = page.getByRole("button", { name: /Use as default/ }).first();
  const siblingBg = (await sibling.count()) ? await bg(sibling) : null;

  await del.click();

  // The state actually changed in a real browser, not just in jsdom.
  await expect(page.getByRole("button", { name: /^Confirm deleting Small/ })).toHaveCount(1);

  const armed = page.getByRole("button", { name: /^Confirm deleting Small/ });

  // POLL, do not read once. `.btn` carries a background transition, so the fill
  // animates from the ghost gradient to the danger colour. A single read right
  // after the click samples the animation mid-flight: the first version of this
  // test saw `rgba(0, 0, 0, 0)` at 0% and reported that the rule was not
  // applying at all, and a later run of the same code saw
  // `rgba(194, 37, 45, 0.23)` — the same colour, 23% of the way in. Two
  // different answers from one unchanged stylesheet is the tell.
  await expect.poll(
    () => bg(armed),
    { message: "armed background never settled on an opaque fill — .btn.armed is not applying" },
  ).toMatch(/^rgb\(/);   // opaque rgb(), not rgba(...,<1) and not transparent

  const armedBg = await bg(armed);

  // The whole point: an armed destructive control cannot render identically to
  // its own resting state, or the second click is a trap.
  expect(armedBg, `armed background ${armedBg} matches the resting Delete`)
    .not.toBe(restingDelete);
  if (siblingBg !== null) {
    expect(armedBg, "armed Delete renders the same as the benign button next to it")
      .not.toBe(siblingBg);
  }
  expect(armedBg).not.toBe("rgba(0, 0, 0, 0)");
  expect(armedBg).not.toBe("transparent");

  expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
});

test("Escape cancels the arming and leaves Settings open", async ({ page }) => {
  // The precedence that could not be copied from CachedWebPane: this modal
  // already closes on Escape, so the two behaviours had to be ordered rather
  // than both registered. Worth re-checking against a real key event.
  await boot(page);
  const del = await openModels(page);
  await del.click();
  await expect(page.getByRole("button", { name: /^Confirm deleting Small/ })).toHaveCount(1);

  await page.keyboard.press("Escape");

  await expect(page.getByRole("button", { name: /^Confirm deleting Small/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Delete Small/ })).toHaveCount(1);
  await expect(page.locator('.cp-modal, [role="dialog"]').first(),
    "Escape closed Settings as well as disarming").toBeVisible();

  // Second Escape, nothing armed, now it closes — the behaviour that existed
  // before and must survive.
  await page.keyboard.press("Escape");
  await expect(page.locator('.cp-modal, [role="dialog"]').first()).toBeHidden();

  expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
});
