import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * The list view driven the way the complaint was phrased: "new column does
 * nothing", "columns don't line up", "doesn't behave like Finder".
 *
 * list-columns.spec.ts proves the column MODEL (move, hide, pixel alignment
 * of what is already there). Nothing rendered the path a person actually
 * takes to add a column: right-click a heading, choose New Column, type a
 * name, press Enter, and look for the column. The runtime-reconcile bug that
 * made that path a no-op was found by reading, fixed, and unit-tested; this
 * is the check that the fix is visible from the chair. It then edits a cell,
 * renames and deletes the column, sorts by a heading, and drags a divider -
 * each measured on the rendered list, each with the cells re-checked under
 * their headings afterwards.
 */
async function bootLibraryList(page: Page): Promise<void> {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.permissioned", "1");
    localStorage.setItem("saucebunny.libraryRoots", JSON.stringify(["/e2e-mock/Footage"]));
    localStorage.setItem("e2e.manyFiles", "12");
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+2");
  await expect(page.locator(".cp-lib-pane")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /List view/i }).click();
  await expect(page.locator(".cp-lib-list")).toBeVisible();
}

const HEAD = ".cp-lib-pane .cp-lib-list .cp-lib-list-head";
const ROWS = ".cp-lib-pane .cp-lib-list .cp-lib-lrow:not(.cp-lib-list-head)";

/** Every header cell's x against the first row's, class by class. */
async function alignment(page: Page) {
  return page.evaluate(({ HEAD, ROWS }) => {
    const head = document.querySelector<HTMLElement>(HEAD)!;
    const row = document.querySelector<HTMLElement>(ROWS)!;
    const cls = (e: Element) =>
      (e.className || "").split(" ").find((c) => /^cp-lib-lrow-(name|kind|size|date|custom)$/.test(c)) ?? null;
    const cellsOf = (el: HTMLElement) => Array.from(el.children)
      .map((c) => ({ cls: cls(c), left: Math.round(c.getBoundingClientRect().left), width: Math.round(c.getBoundingClientRect().width) }))
      .filter((c) => c.cls);
    return { head: cellsOf(head), row: cellsOf(row), tracks: getComputedStyle(row).gridTemplateColumns.split(" ").length };
  }, { HEAD, ROWS });
}

function expectAligned(when: string, a: Awaited<ReturnType<typeof alignment>>) {
  expect(a.head.length, `${when}: header exposed no columns`).toBeGreaterThan(1);
  expect(a.row.length, `${when}: row and header column counts differ`).toBe(a.head.length);
  for (let i = 0; i < a.head.length; i++) {
    expect(a.row[i].cls, `${when}: column ${i} class differs`).toBe(a.head[i].cls);
    expect(
      Math.abs(a.row[i].left - a.head[i].left),
      `${when}: "${a.head[i].cls}" header at x=${a.head[i].left} but its cell at x=${a.row[i].left}`,
    ).toBeLessThanOrEqual(1);
  }
}

async function openColumnsMenu(page: Page, header: string) {
  await page.locator(`${HEAD} ${header}`).first().click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Columns" });
  await expect(menu).toBeVisible();
  return menu;
}

test("New Column appears with a cell in every row, aligned, and can be edited, renamed and deleted", async ({ page }) => {
  await bootLibraryList(page);
  const before = await alignment(page);
  expectAligned("before", before);
  expect(before.head.some((c) => c.cls === "cp-lib-lrow-custom"), "a custom column was already there").toBe(false);

  // ── New Column… ──
  let menu = await openColumnsMenu(page, ".cp-lib-colhead");
  await menu.getByRole("menuitem", { name: /New Column/ }).click();
  const field = menu.getByRole("textbox", { name: "Column name" });
  await expect(field).toBeFocused();
  await field.fill("Take");
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();

  const customHead = page.locator(`${HEAD} .cp-lib-lrow-custom`);
  await expect(customHead, "the new column has no heading").toHaveCount(1);
  await expect(customHead).toHaveText("Take");
  const rowCount = await page.locator(ROWS).count();
  expect(rowCount).toBeGreaterThan(5);
  await expect(page.locator(`${ROWS} .cp-lib-lrow-custom`), "not every row grew a cell").toHaveCount(rowCount);
  const added = await alignment(page);
  expectAligned("after New Column", added);
  expect(added.tracks, "the grid did not gain a track").toBe(before.tracks + 1);
  expect(added.head.some((c) => c.cls === "cp-lib-lrow-custom")).toBe(true);

  // ── Type into a cell: select the row, then click the cell (Finder's
  //    click-on-selected idiom). The pause keeps the second click from
  //    counting as a double-click, which the cell deliberately ignores. ──
  const firstRow = page.locator(ROWS).first();
  const cell = firstRow.locator(".cp-lib-lrow-custom");
  await firstRow.click();
  await expect(firstRow).toHaveClass(/selected/);
  await page.waitForTimeout(600);
  await cell.click();
  const editor = page.locator(".cp-lib-cell-edit");
  await expect(editor, "clicking a custom cell on a selected row did not open an editor").toBeVisible();
  await expect(editor).toBeFocused();
  await editor.fill("A1");
  await page.keyboard.press("Enter");
  await expect(editor).toBeHidden();
  await expect(cell).toHaveText("A1");

  // ── Rename it from its own heading ──
  menu = await openColumnsMenu(page, ".cp-lib-lrow-custom");
  await menu.getByRole("menuitem", { name: /Rename “Take”/ }).click();
  const rename = menu.getByRole("textbox", { name: "Column name" });
  await expect(rename).toHaveValue("Take");
  await rename.fill("Shot");
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  await expect(customHead).toHaveText("Shot");
  await expect(cell, "renaming the column lost its values").toHaveText("A1");

  // ── Delete it, and the grid gives the track back ──
  menu = await openColumnsMenu(page, ".cp-lib-lrow-custom");
  await menu.getByRole("menuitem", { name: /Delete “Shot” and its contents/ }).click();
  await expect(menu).toBeHidden();
  await expect(customHead).toHaveCount(0);
  await expect(page.locator(`${ROWS} .cp-lib-lrow-custom`)).toHaveCount(0);
  const removed = await alignment(page);
  expectAligned("after delete", removed);
  expect(removed.tracks, "a deleted column left an invisible track behind").toBe(before.tracks);
});

test("clicking a heading sorts, and clicking it again reverses", async ({ page }) => {
  await bootLibraryList(page);
  const names = () => page.locator(`${ROWS} .cp-lib-lrow-name`).allInnerTexts();
  const size = page.locator(`${HEAD} .cp-lib-lrow-size`);
  // Finder's convention, which this follows: Name sorts A to Z first, but
  // Size and Date sort LARGEST / NEWEST first on the first click. The first
  // draft of this test expected ascending and was wrong about Finder.
  await size.click();
  await expect(size).toHaveAttribute("aria-sort", "descending");
  const desc = await names();
  await size.click();
  await expect(size).toHaveAttribute("aria-sort", "ascending");
  const asc = await names();
  expect(asc.length).toBeGreaterThan(5);
  expect(desc[0], "reversing the sort did not change which row is first").not.toBe(asc[0]);
  expect(desc[0]).toBe(asc[asc.length - 1]);
  // The Name heading takes the sort back, and Size drops its indicator.
  await page.locator(`${HEAD} .cp-lib-lrow-name`).click();
  await expect(size).toHaveAttribute("aria-sort", "none");
  expectAligned("after sorting", await alignment(page));
});

test("dragging a divider resizes that column and the cells follow", async ({ page }) => {
  await bootLibraryList(page);
  const kindHead = page.locator(`${HEAD} .cp-lib-lrow-kind`);
  const divider = page.getByRole("separator", { name: "Resize Kind column" });
  await expect(divider).toBeVisible();
  const before = Math.round((await kindHead.boundingBox())!.width);
  const box = (await divider.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(x + i * 10, y);
  await page.mouse.up();
  const after = Math.round((await kindHead.boundingBox())!.width);
  expect(after - before, `dragging 60px changed the Kind column by ${after - before}px`).toBeGreaterThanOrEqual(50);
  expect(after - before).toBeLessThanOrEqual(70);
  expectAligned("after drag", await alignment(page));

  // The keyboard path the splitter advertises: ArrowRight is one step.
  await divider.focus();
  const step = Number(await divider.getAttribute("aria-valuenow"));
  await page.keyboard.press("ArrowRight");
  expect(Number(await divider.getAttribute("aria-valuenow"))).toBeGreaterThan(step);
  expectAligned("after keyboard nudge", await alignment(page));
});
