import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * The list view's columns, driven the way a person drives them.
 *
 * Requested as Finder parity: drag a header to move a column, right-click a
 * header to turn one off, and drag its right edge to resize. All three used to
 * be impossible here for the same structural reason - the grid template was
 * five literal tracks in the stylesheet, the header cells were literal JSX in
 * source order, and the row cells were literal JSX in source order. Three
 * literals that have to agree, kept in agreement by attention.
 *
 * They are now derived from one column model, and this is what checks that the
 * three still agree AFTER a change: the assertion that matters is not "the
 * header moved", it is "the header moved and the cells under it moved too".
 */
/** Column state is seeded BEFORE boot rather than written and reloaded: a
 *  reload lands on Home, so the list this measures would not be on screen. */
async function bootLibraryList(page: Page, cols?: unknown): Promise<void> {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript((seed) => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.permissioned", "1");
    localStorage.setItem("saucebunny.libraryRoots", JSON.stringify(["/e2e-mock/Footage"]));
    localStorage.setItem("e2e.manyFiles", "12");
    if (seed) localStorage.setItem("saucebunny.libraryListCols", JSON.stringify(seed));
  }, cols ?? null);
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+2");
  await expect(page.locator(".cp-lib-pane")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /List view/i }).click();
  await expect(page.locator(".cp-lib-list")).toBeVisible();
}

/** The header labels and the first row's cell classes, in rendered order. */
async function layout(page: Page) {
  return page.evaluate(() => {
    const list = document.querySelector(".cp-lib-list")!;
    const head = list.querySelector(".cp-lib-list-head")!;
    const row = list.querySelector(".cp-lib-lrow:not(.cp-lib-list-head)")!;
    const cls = (e: Element) =>
      (e.className || "").split(" ").find((c) => /^cp-lib-lrow-(kind|size|date)$/.test(c)) ?? null;
    return {
      headers: Array.from(head.children).map((c) => cls(c)).filter(Boolean),
      cells: Array.from(row.children).map((c) => cls(c)).filter(Boolean),
      tracks: getComputedStyle(row).gridTemplateColumns.split(" ").length,
    };
  });
}

test("a column carries its cells when it moves", async ({ page }) => {
  await bootLibraryList(page);

  const before = await layout(page);
  // CANARY. Every assertion below compares two lists; two empty lists are
  // equal, and a selector that stopped matching would report a perfect move.
  expect(before.headers.length, "no optional headers were found").toBe(3);
  expect(before.cells, "the header and the first row disagree before any change").toEqual(before.headers);

  // Move the last column to the front, through the same persisted model the
  // drag writes to.
  await page.context().clearCookies();
  const moved = await page.context().newPage();
  await bootLibraryList(moved, { w: { kind: 64, size: 84, date: 96 }, order: ["date", "kind", "size"], hidden: [] });

  const after = await layout(moved);
  expect(after.headers, "the header did not reorder").toEqual([
    "cp-lib-lrow-date", "cp-lib-lrow-kind", "cp-lib-lrow-size",
  ]);
  expect(after.cells, "the header moved and the row cells did not follow").toEqual(after.headers);
});

test("a hidden column stops reserving its track", async ({ page }) => {
  await bootLibraryList(page);
  const before = await layout(page);
  expect(before.tracks, "the grid did not lay out").toBeGreaterThan(3);

  const hidden = await page.context().newPage();
  await bootLibraryList(hidden, { w: { kind: 64, size: 84, date: 96 }, order: ["kind", "size", "date"], hidden: ["kind"] });

  const after = await layout(hidden);
  expect(after.headers, "the hidden column still has a header").toEqual([
    "cp-lib-lrow-size", "cp-lib-lrow-date",
  ]);
  expect(after.cells, "the hidden column still has a cell").toEqual(after.headers);
  expect(
    after.tracks,
    "the column is hidden but its grid track is still reserved",
  ).toBe(before.tracks - 1);
});

test("right-clicking a header offers the columns", async ({ page }) => {
  await bootLibraryList(page);
  await page.locator(".cp-lib-list-head .cp-lib-colhead").first().click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Columns" });
  await expect(menu).toBeVisible();
  const items = menu.getByRole("menuitemcheckbox");
  await expect(items).toHaveCount(3);
  // Every column starts on, so every row is checked.
  for (const item of await items.all()) {
    await expect(item).toHaveAttribute("aria-checked", "true");
  }
  // Escape closes it, which useDismiss provides and a hand-rolled one would not.
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
});

/**
 * THE CELLS SIT UNDER THEIR HEADINGS, measured in pixels on every list.
 *
 * The tests above compare class ORDER and track COUNT, and both passed while
 * every column on the web shelf sat 40px to the left of its heading: the rows
 * reserved a right gutter for the forget button and the header did not, so
 * the header's 1fr name track was wider than the rows'. Order and count were
 * perfect. Only the x positions were wrong, and nothing measured them.
 */
async function alignment(page: Page, scope: string) {
  return page.evaluate((sel) => {
    const list = document.querySelector(sel + " .cp-lib-list") ?? document.querySelector(sel);
    if (!list) return null;
    const head = list.querySelector<HTMLElement>(".cp-lib-list-head");
    const row = list.querySelector<HTMLElement>(".cp-lib-lrow:not(.cp-lib-list-head)");
    if (!head || !row) return null;
    const cls = (e: Element) =>
      (e.className || "").split(" ").find((c) => /^cp-lib-lrow-(name|kind|size|date|custom)$/.test(c)) ?? null;
    const cellsOf = (el: HTMLElement) => Array.from(el.children)
      .map((c) => ({ cls: cls(c), left: Math.round(c.getBoundingClientRect().left) }))
      .filter((c) => c.cls);
    return { head: cellsOf(head), row: cellsOf(row) };
  }, scope);
}

function expectAligned(name: string, a: Awaited<ReturnType<typeof alignment>>) {
  expect(a, `${name}: no header/row pair found`).not.toBeNull();
  // CANARY: an empty pair aligns perfectly. Demand real columns.
  expect(a!.head.length, `${name}: header exposed no columns`).toBeGreaterThan(1);
  expect(a!.row.length, `${name}: row exposed no columns`).toBe(a!.head.length);
  for (let i = 0; i < a!.head.length; i++) {
    expect(a!.row[i].cls, `${name}: column ${i} class differs`).toBe(a!.head[i].cls);
    expect(
      Math.abs(a!.row[i].left - a!.head[i].left),
      `${name}: "${a!.head[i].cls}" header at x=${a!.head[i].left} but its cell at x=${a!.row[i].left}`,
    ).toBeLessThanOrEqual(1);
  }
}

test("library list: every cell sits under its heading", async ({ page }) => {
  await bootLibraryList(page);
  expectAligned("library", await alignment(page, ".cp-lib-pane"));
});

for (const shelf of ["From the web", "Frames"] as const) {
  test(`${shelf}: every cell sits under its heading`, async ({ page }) => {
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
    await page.getByRole("treeitem", { name: shelf }).first().click();
    await expect(page.locator(".cp-web-view .cp-lib-card").first()).toBeVisible({ timeout: 10_000 });
    await page.locator(".cp-web-view").getByRole("button", { name: /List view/i }).click();
    await expect(page.locator(".cp-web-view .cp-lib-list")).toBeVisible();
    expectAligned(shelf, await alignment(page, ".cp-web-view"));
  });
}
