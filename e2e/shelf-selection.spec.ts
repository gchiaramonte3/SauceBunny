import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * Shift-click and the lasso band on the Frames and Web shelves.
 *
 * These shelves are walls of the same LibraryCard the folder pane uses, and
 * they had none of its selection: no ranges, no ⌘-toggle, no band. The rules
 * were never missing - `library-selection.ts` and `use-marquee.ts` are both
 * generic - what was missing was that the card took its identity from its
 * ART (`art.kind === "local" ? art.path`), and these shelves show REMOTE
 * art, so their cards carried no `data-path` and the band, which skips nodes
 * without one, could never see them.
 *
 * The band is the half that cannot be tested in jsdom: it is pointer
 * geometry against measured rectangles, and jsdom reports every rectangle as
 * zero. So it is tested here, where boxes are real.
 */
/** The Frames and Web shelves both render inside this view. */
const SHELF = ".cp-web-view";

async function bootShelf(page: Page, shelf: "Frames" | "From the web"): Promise<void> {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.libraryRoots", JSON.stringify(["/e2e-mock/Footage"]));
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+2");
  await expect(page.locator(".cp-view-library")).toBeVisible();
  await page.getByRole("treeitem", { name: shelf }).first().click();
  // Scoped to the shelf. The folder pane stays MOUNTED but hidden when you
  // switch shelves, so an unscoped `.cp-lib-card` resolves to one of its
  // cards - present in the DOM, invisible on screen, and belonging to a
  // different pane entirely.
  await expect(page.locator(SHELF + " .cp-lib-card").first()).toBeVisible({ timeout: 10_000 });
}

/** Drag a band from a point in the gutter across `to`. */
async function lasso(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Two moves: the hook needs one to pass its drag threshold and one to size
  // the band, and a single jump can be swallowed as a click.
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

for (const shelf of ["Frames", "From the web"] as const) {
  test(`${shelf}: every card carries an identity to select by`, async ({ page }) => {
    await bootShelf(page, shelf);
    const paths = await page.locator(SHELF + " .cp-lib-card:not(.cp-lib-foldercard)")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-path")));
    expect(paths.length).toBeGreaterThan(1);
    expect(paths.every((p) => !!p), "a card has no data-path, so no gesture can select it").toBe(true);
  });

  test(`${shelf}: shift-click selects the run between, in display order`, async ({ page }) => {
    await bootShelf(page, shelf);
    const cards = page.locator(SHELF + " .cp-lib-card:not(.cp-lib-foldercard)");
    const n = await cards.count();
    expect(n).toBeGreaterThan(2);

    await cards.nth(0).click();
    await cards.nth(2).click({ modifiers: ["Shift"] });
    await expect(page.locator(SHELF + " .cp-lib-card.selected")).toHaveCount(3);

    // Shift again from the SAME anchor shrinks the range rather than starting
    // a new one from the last click - the anchor rule, end to end.
    await cards.nth(1).click({ modifiers: ["Shift"] });
    await expect(page.locator(SHELF + " .cp-lib-card.selected")).toHaveCount(2);
  });

  test(`${shelf}: a lasso over the gutter selects what it touches`, async ({ page }) => {
    await bootShelf(page, shelf);
    const cards = page.locator(SHELF + " .cp-lib-card:not(.cp-lib-foldercard)");
    const first = (await cards.nth(0).boundingBox())!;
    const boxes = await cards.evaluateAll((els) =>
      els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, b: r.bottom }; }));
    const lowest = Math.max(...boxes.map((b) => b.b));
    const pane = (await page.locator(SHELF + " .cp-web-pane").boundingBox())!;

    // Start BELOW the last card, in the pane's own bottom padding. That is
    // blank space belonging to the scroll container itself, which is the one
    // place a band is unambiguously not a card's click.
    const startY = Math.min(lowest + 12, pane.y + pane.height - 4);
    await page.mouse.move(first.x + 12, startY);
    await page.mouse.down();
    await page.mouse.move(first.x + 12, (startY + first.y) / 2, { steps: 5 });
    // The band exists WHILE the pointer is down - if this fails the gesture
    // never started, which is a different bug from selecting nothing.
    await expect(page.locator(SHELF + " .cp-lib-marquee")).toBeVisible();
    await page.mouse.move(first.x + 12, first.y + 12, { steps: 5 });
    await page.mouse.up();

    await expect(page.locator(SHELF + " .cp-lib-card.selected")).not.toHaveCount(0);
    // ...and it is gone once released.
    await expect(page.locator(SHELF + " .cp-lib-marquee")).toHaveCount(0);
  });

  test(`${shelf}: the batch bar appears at two and clears`, async ({ page }) => {
    await bootShelf(page, shelf);
    const cards = page.locator(SHELF + " .cp-lib-card:not(.cp-lib-foldercard)");
    await cards.nth(0).click();
    await expect(page.locator(SHELF + " .cp-lib-selbar")).toHaveCount(0);

    await cards.nth(1).click({ modifiers: ["Shift"] });
    const bar = page.locator(SHELF + " .cp-lib-selbar");
    await expect(bar).toBeVisible();
    await expect(bar).toContainText("2 selected");

    // And it floats: it must not be as tall as the pane, the way the folder
    // pane's bar once was.
    const box = (await bar.boundingBox())!;
    expect(box.height).toBeLessThan(80);

    await bar.getByRole("button", { name: "Clear" }).click();
    await expect(page.locator(SHELF + " .cp-lib-selbar")).toHaveCount(0);
  });
}
