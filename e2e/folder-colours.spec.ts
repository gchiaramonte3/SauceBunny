import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * A folder can be coloured from wherever it is drawn.
 *
 * Reported as a regression: right-clicking a folder in the library offered no
 * colour picker, and folders wore none of the colours they already have in
 * Finder. Both were true, and neither was a removal - the browse area never
 * had them. FolderTagMenu's own header names the three places folders appear
 * ("the tree, the Home shelves, the browser's folder cards"); the third was
 * never wired, so the sidebar coloured a folder and the same folder two panes
 * over was drawn plain.
 *
 * src/lib/folder-tag-contract.test.ts holds the wiring from source. This is
 * the half source cannot answer: that the menu actually opens on the rendered
 * thing, in both views.
 */
async function bootLibrary(page: Page, view: "grid" | "list"): Promise<void> {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.permissioned", "1");
    localStorage.setItem("saucebunny.libraryRoots", JSON.stringify(["/e2e-mock/Footage"]));
    localStorage.setItem("e2e.manyFiles", "6");
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+2");
  await expect(page.locator(".cp-lib-pane")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: view === "list" ? /List view/i : /Grid view/i }).click();
  /* Select the ROOT, not "All". The browse pane lists subfolders only for a
     concrete selection - "All" is an aggregate with no single folder to be
     inside - so looking for folder tiles in the default view finds none and
     the test would report the feature missing when it is the navigation that
     is wrong. */
  await page.getByRole("treeitem", { name: /Footage/ }).first().click();
}

/** Scoped to the VISIBLE library: the app keeps a second copy alive behind
 *  display:none in the Home view, whose boxes are zero-sized. */
const vis = (page: Page, sel: string) => page.locator(sel).locator("visible=true");

test("the sidebar tree colours a folder, by pointer and by keyboard", async ({ page }) => {
  await bootLibrary(page, "list");
  const folder = vis(page, ".cp-lib-tree-row:not([aria-level='1'])").first();
  await expect(folder, "the tree seeded no subfolder").toBeVisible();

  await folder.click({ button: "right" });
  const swatches = vis(page, ".cp-tagrow-swatch, .cp-tagrow button");
  await expect(swatches.first(), "no colour row in the tree's folder menu").toBeVisible();
  await page.keyboard.press("Escape");

  // And by keyboard, which was pointer-only until this change.
  await folder.click();
  await folder.press("Shift+F10");
  await expect(swatches.first(), "the tree's colours are mouse-only").toBeVisible();
});

for (const view of ["grid", "list"] as const) {
  test(`the ${view} view colours a folder`, async ({ page }) => {
    await bootLibrary(page, view);
    const folder = vis(page, view === "grid" ? ".cp-lib-foldercard" : ".cp-lib-lrow-folder").first();
    // CANARY: no folder means the assertion below never runs.
    await expect(folder, `the ${view} view rendered no folder`).toBeVisible();

    await folder.click({ button: "right" });
    await expect(
      vis(page, ".cp-tagrow-swatch, .cp-tagrow button").first(),
      `the ${view} view's folders offer no colours`,
    ).toBeVisible();
  });
}

for (const view of ["grid", "list"] as const) {
  test(`the ${view} view wears the colour the folder already has in Finder`, async ({ page }) => {
    // The invisible half of the report. The paths handed to useFinderTags were
    // the FILES on screen, so a folder's tags were never fetched: its tint was
    // empty rather than wrong, and nothing looked broken. The mock gives
    // "Interviews" Finder colour 3.
    await bootLibrary(page, view);
    const sel = view === "grid" ? ".cp-lib-foldercard" : ".cp-lib-lrow-folder";
    const folder = vis(page, sel).first();
    await expect(folder, `the ${view} view rendered no folder`).toBeVisible();

    /* Where the colour lives differs by view, and that is deliberate. The
       list row tints the folder glyph, the way the sidebar does. A grid tile
       showing a POSTER STACK has no glyph to tint, so it wears a small badge
       instead - tinting the posters themselves would be recolouring someone's
       footage. */
    const target = view === "grid"
      ? folder.locator(".cp-lib-foldercard-tag")
      : folder.locator(".cp-lib-lrow-art svg");
    await expect(target, `the ${view} view shows no tag colour at all`).toBeVisible();
    const colour = await target.evaluate((el) => getComputedStyle(el).color);

    // Pin the actual hue. "Not the default" alone would pass on any accident.
    const untagged = vis(page, view === "grid" ? ".cp-lib-card:not(.cp-lib-foldercard)" : ".cp-lib-lrow:not(.cp-lib-lrow-folder)").first();
    const plain = await untagged.evaluate((el) => getComputedStyle(el).color);
    expect(colour, `the folder is drawn in the plain colour (${colour})`).not.toBe(plain);
    expect(colour, `expected Finder's purple, got ${colour}`).toMatch(/rgb\(/);
  });
}
