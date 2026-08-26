import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * Rubber-band selection in the Library, in BOTH views.
 *
 * A band starts only on a press whose target is the container itself, or that
 * matches a named gutter. In the grid `.cp-lib-pane` IS the wall, so that
 * holds. The LIST nests its rows inside `.cp-lib-list`, and that child covers
 * the blank area below the last row - so every press a user would make to
 * start a band landed on the child and was ignored. Lasso worked in one view
 * and silently did nothing in the other.
 */
async function bootLibrary(page: Page, view: "grid" | "list"): Promise<void> {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript((v) => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.libraryRoots", JSON.stringify(["/e2e-mock/Footage"]));
    localStorage.setItem("saucebunny.libraryBrowser", JSON.stringify({ view: v, sort: "name", dir: "asc" }));
  }, view);
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+2");
  await page.getByRole("treeitem", { name: "Footage" }).first().click();
  await expect(page.locator(".cp-lib-pane")).toBeVisible({ timeout: 10_000 });
}

const selected = (page: Page) =>
  page.locator(".cp-lib-pane .selected, .cp-lib-pane [aria-current='true']");

/** Drag a band from `from` to `to` in viewport coords. */
async function band(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
}

for (const view of ["grid", "list"] as const) {
  test(`a band drawn on blank space selects what it covers (${view} view)`, async ({ page }) => {
    await bootLibrary(page, view);
    const items = page.locator(view === "grid" ? ".cp-lib-pane .cp-lib-card" : ".cp-lib-lrow");
    await expect(items.first()).toBeVisible({ timeout: 10_000 });
    const n = await items.count();
    expect(n, "need items to band over").toBeGreaterThan(1);

    const pane = (await page.locator(".cp-lib-pane").boundingBox())!;
    const first = (await items.first().boundingBox())!;
    const last = (await items.nth(n - 1).boundingBox())!;

    // Start well below the last item - blank space a user would press - and
    // drag up across everything.
    const startY = Math.min(pane.y + pane.height - 6, last.y + last.height + 40);
    await band(page,
      { x: pane.x + pane.width - 12, y: startY },
      { x: first.x + 8, y: first.y + 6 });

    // The band itself is visible while dragging.
    await expect(page.locator(".cp-lib-marquee")).toBeVisible();
    await page.mouse.up();

    await expect(selected(page).first()).toBeVisible();
    expect(await selected(page).count(), "the band selected nothing").toBeGreaterThan(0);
  });

  test(`a press on blank space with no drag clears the selection (${view} view)`, async ({ page }) => {
    await bootLibrary(page, view);
    const items = page.locator(view === "grid" ? ".cp-lib-pane .cp-lib-card" : ".cp-lib-lrow");
    await expect(items.first()).toBeVisible({ timeout: 10_000 });

    // Build the selection with a BAND, not a click: a plain click also opens
    // the detail panel, and this test is about the pane.
    const pane = (await page.locator(".cp-lib-pane").boundingBox())!;
    const first = (await items.first().boundingBox())!;
    const last = (await items.nth(await items.count() - 1).boundingBox())!;
    const startY = Math.min(pane.y + pane.height - 6, last.y + last.height + 40);
    await band(page,
      { x: pane.x + pane.width - 12, y: startY },
      { x: first.x + 8, y: first.y + 6 });
    await page.mouse.up();
    expect(await selected(page).count(), "the band selected nothing to clear").toBeGreaterThan(0);

    // Finder: a click on empty space drops the selection.
    await page.mouse.click(pane.x + pane.width - 12, pane.y + pane.height - 8);
    await expect(selected(page)).toHaveCount(0);
  });
}
