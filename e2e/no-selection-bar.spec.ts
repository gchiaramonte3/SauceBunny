import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * THE MULTI-SELECT BAR IS GONE, AND ITS VERBS ARE NOT.
 *
 * What this file used to be: three measurements of a floating "N selected ·
 * Reveal · Move · Delete" bar, which had shipped as a full-height COLUMN
 * beside the grid before being made to float. It was then removed outright on
 * request - a second, competing set of actions hovering over the shelf in a
 * different idiom from the row menus that already carried those verbs, and
 * covering the last row while it did so.
 *
 * So the guard inverts. Two things must hold, and the second is the one that
 * makes the first safe: the bar must not come back, AND removing it must not
 * have removed the ability to act on a selection. A shelf where shift-click
 * selects ten files and nothing can be done with them is a highlight, not a
 * feature - which is exactly what the bar was originally written to prevent.
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
  await expect(page.locator(".cp-view-library .cp-lib-card").first()).toBeVisible({ timeout: 15_000 });
}

/** Select two cards, which is where the bar used to appear. */
async function selectRange(page: Page): Promise<void> {
  const cards = page.locator(".cp-view-library .cp-lib-card:not(.cp-lib-foldercard)");
  await cards.first().click();
  await cards.nth(1).click({ modifiers: ["Shift"] });
  await expect(page.locator(".cp-view-library .cp-lib-card.selected")).toHaveCount(2);
}

test("selecting several files raises no floating bar", async ({ page }) => {
  await bootLibrary(page);
  await selectRange(page);
  await expect(
    page.locator(".cp-lib-selbar"),
    "the multi-select bar is back over the shelf",
  ).toHaveCount(0);
});

test("selecting does not reflow the grid", async ({ page }) => {
  // Kept from the original file: the sharpest statement of the old bug was
  // that the bar TOOK width from the row, so selecting files reflowed the
  // wall of thumbnails. Nothing may do that.
  await bootLibrary(page);
  const pane = page.locator(".cp-view-library .cp-lib-pane").first();
  const before = await pane.boundingBox();
  expect(before, "no library pane").not.toBeNull();

  await selectRange(page);
  const after = await pane.boundingBox();
  expect(after!.width).toBeCloseTo(before!.width, 0);
  expect(after!.x).toBeCloseTo(before!.x, 0);
});

test("the selection's verbs are still reachable, in the row menu", async ({ page }) => {
  // The half that makes the removal safe rather than a quiet feature cut.
  await bootLibrary(page);
  await selectRange(page);
  const second = page.locator(".cp-view-library .cp-lib-card:not(.cp-lib-foldercard)").nth(1);
  await second.click({ button: "right" });

  const menu = page.locator('[role="menu"]');
  await expect(menu, "right-clicking a selected card opened no menu").toBeVisible();
  const items = await menu.getByRole("menuitem").allInnerTexts();
  expect(items.length, "the menu is empty").toBeGreaterThan(2);
  // Batch transcription lived ONLY in the removed bar; it moved here, and its
  // label carries the count so the set still has one visible answer to
  // "what will this apply to".
  expect(
    items.join(" | "),
    "batch transcribe did not survive the bar's removal",
  ).toMatch(/Transcribe 2 selected/);
});
