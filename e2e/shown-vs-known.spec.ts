import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * What a pane DREW and what it KNOWS ABOUT are different lists, and selection
 * has to run over the first one.
 *
 * The same bug was written three times:
 *
 *  - Home built its selection order from each root's top-level items while the
 *    shelf rendered every depth, so ⌘-click on a card that came from a
 *    subfolder selected nothing (clickSelect returns the state unchanged for a
 *    path it has not heard of) and a ⇧-range skipped over the cards drawn
 *    between its own endpoints;
 *  - a Home shelf header counted the whole subtree while the shelf stopped at
 *    24 cards, with nothing saying so;
 *  - and the Library browser published its uncapped path list to ⌘A, so in a
 *    folder of 400 files ⌘A reported "400 selected" over 300 drawn cards and a
 *    batch action then ran across a hundred files the pane had already said it
 *    was not showing.
 */
async function boot(page: Page, opts: { many?: number } = {}): Promise<void> {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript((many) => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.libraryRoots", JSON.stringify(["/e2e-mock/Footage"]));
    if (many) localStorage.setItem("e2e.manyFiles", String(many));
  }, opts.many ?? 0);
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
}

const cards = (page: Page) => page.locator(".cp-lib-row .cp-lib-card");
const selectedCards = (page: Page) => page.locator(".cp-lib-row .cp-lib-card.selected, .cp-lib-row .cp-lib-card[aria-current='true']");

test("⌘-click selects a Home card that came from a subfolder", async ({ page }) => {
  await boot(page);
  // intro.mp4 lives in Footage/Interviews. The shelf draws it; the selection
  // list used not to contain it at all.
  const nested = cards(page).filter({ hasText: "intro.mp4" }).first();
  await expect(nested).toBeVisible({ timeout: 10_000 });
  await nested.click({ modifiers: ["ControlOrMeta"] });
  await expect(selectedCards(page)).toHaveCount(1);
  await expect(selectedCards(page).first()).toContainText("intro.mp4");
});

test("a ⇧-range covers the card drawn between its endpoints", async ({ page }) => {
  // Wide viewport and a few spare cards, so the two endpoints sit well clear
  // of the shelf's right-hand fade and hover arrow.
  await page.setViewportSize({ width: 1600, height: 900 });
  await boot(page, { many: 6 });
  await expect(cards(page).first()).toBeVisible({ timeout: 10_000 });
  expect(await cards(page).count()).toBeGreaterThanOrEqual(4);

  // A PLAIN click on a Home card opens it - Home is a launcher first - so the
  // range is anchored with ⌘ the way it is in the app.
  await cards(page).nth(0).click({ modifiers: ["ControlOrMeta"] });
  await cards(page).nth(2).click({ modifiers: ["Shift"] });
  // Three cards, not two: the middle one is on screen, so it is in the range.
  // It used to be skipped, because the selection order was built from a list
  // that did not contain it.
  await expect(selectedCards(page)).toHaveCount(3);
});

test("a capped Home shelf says how many of them it drew", async ({ page }) => {
  await boot(page, { many: 40 });
  await expect(cards(page).first()).toBeVisible({ timeout: 10_000 });
  const count = page.locator(".cp-lib-row-count").first();
  // 42 in the subtree (40 bulk + 2 loose + 1 nested), 24 drawn.
  await expect(count).toContainText(/^24 of \d+$/);
  await expect(cards(page)).toHaveCount(24);
});

test("an uncapped shelf still prints a plain count", async ({ page }) => {
  // The disclosure must not turn into "3 of 3" on every shelf.
  await boot(page);
  await expect(cards(page).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".cp-lib-row-count").first()).toHaveText("3");
});

test("⌘A in the Library selects what the pane drew, not what it knows", async ({ page }) => {
  await boot(page, { many: 400 });
  await page.keyboard.press("Meta+2");
  await page.getByRole("treeitem", { name: "Footage" }).first().click();
  // Scope to the browser pane: Home stays mounted (hidden) behind it.
  const paneCards = page.locator(".cp-lib-pane .cp-lib-card:not(.cp-lib-foldercard)");
  await expect(paneCards.first()).toBeVisible({ timeout: 15_000 });

  await paneCards.first().click();
  await page.keyboard.press("Meta+a");

  const drawn = await paneCards.count();
  const highlighted = await page.locator(".cp-lib-pane .cp-lib-card.selected, .cp-lib-pane .cp-lib-card[aria-current='true']").count();
  expect(drawn, "the browser cap should have bitten at 400 files").toBeLessThan(400);
  // The bar's number and the highlighted cards must be the same claim.
  expect(highlighted).toBe(drawn);
  await expect(page.locator(".cp-lib-selbar, .cp-lib-selection-bar").first())
    .toContainText(String(drawn));
});
