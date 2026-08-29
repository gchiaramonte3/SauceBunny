import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * The multi-select bar, measured where it actually renders.
 *
 * What shipped: the bar is a child of `.cp-lib-browse-body`, which is
 * `display: flex` in the ROW direction. In flow there it is not a bar at
 * all - it becomes a second COLUMN beside the grid, stretched to the full
 * height of the pane, with its verbs floating at the vertical middle of a
 * tall empty box. The user shift-clicked ten files and got that.
 *
 * `selection-bar-contract.test.ts` reads the stylesheet and asserts the bar
 * is out of flow. It cannot tell whether the result LOOKS right, because
 * jsdom has no layout engine. This one boots the app and measures boxes,
 * which is the only place the difference between "a bar" and "a column" is
 * observable at all.
 */
async function bootLibrary(page: Page): Promise<void> {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.permissioned", "1");
    localStorage.setItem("saucebunny.libraryRoots", JSON.stringify(["/e2e-mock/Footage"]));
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+2");
  await expect(page.locator(".cp-view-library")).toBeVisible();
  await page.locator(".cp-lib-statusbar").first().waitFor({ timeout: 10_000 });
}

/** Select a range: click the first card, shift-click the last. */
async function selectRange(page: Page): Promise<void> {
  const cards = page.locator(".cp-view-library .cp-lib-card");
  await expect(cards.first()).toBeVisible();
  expect(await cards.count(), "need two cards to multi-select").toBeGreaterThan(1);
  await cards.first().click();
  await cards.nth(1).click({ modifiers: ["Shift"] });
  await expect(page.locator(".cp-lib-selbar")).toBeVisible();
}

test("showing the bar does not narrow the grid", async ({ page }) => {
  // The sharpest statement of the bug. As a flex item the bar TOOK width
  // from the row, so selecting files reflowed the wall of thumbnails; out of
  // flow it cannot, and the grid is untouched.
  await bootLibrary(page);
  const pane = page.locator(".cp-view-library .cp-lib-pane").first();
  const before = await pane.boundingBox();
  expect(before, "no library pane").not.toBeNull();

  await selectRange(page);
  const after = await pane.boundingBox();
  expect(after!.width).toBeCloseTo(before!.width, 0);
  expect(after!.x).toBeCloseTo(before!.x, 0);
});

test("the bar is a bar, not a full-height column", async ({ page }) => {
  await bootLibrary(page);
  await selectRange(page);

  const body = (await page.locator(".cp-lib-browse-body").first().boundingBox())!;
  const bar = (await page.locator(".cp-lib-selbar").boundingBox())!;

  // The failure was a box as tall as the pane. A row of controls is well
  // under 80px at any window size; the pane is many hundreds.
  expect(bar.height).toBeLessThan(80);
  expect(bar.height).toBeLessThan(body.height / 3);

  // And it sits over the grid near the bottom, not off in its own column:
  // its centre is inside the body's horizontal span, and its lower edge is
  // in the bottom third.
  const barCentre = bar.x + bar.width / 2;
  expect(barCentre).toBeGreaterThan(body.x);
  expect(barCentre).toBeLessThan(body.x + body.width);
  expect(bar.y + bar.height).toBeGreaterThan(body.y + body.height * 0.66);
});

test("the bar never covers the last row of thumbnails", async ({ page }) => {
  // It floats, so it CAN overlap content - the pane's bottom padding is what
  // keeps the last row clear. That padding is load-bearing, so measure it
  // rather than trusting it.
  await bootLibrary(page);
  await selectRange(page);
  const bar = (await page.locator(".cp-lib-selbar").boundingBox())!;

  const cards = page.locator(".cp-view-library .cp-lib-card");
  const boxes = await cards.evaluateAll((els) =>
    els.map((e) => e.getBoundingClientRect().bottom));
  const lowest = Math.max(...boxes);
  expect(lowest, "the bar's top edge is above the last card's bottom").toBeLessThanOrEqual(bar.y);
});
