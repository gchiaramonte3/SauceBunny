import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * Drag a file onto a folder to file it — Finder's core gesture, and the one
 * the Library did not have.
 *
 * Frames, the web shelf and Transcripts all shipped it; the Library, whose
 * folders are the only REAL directories among them, had no move verb at all —
 * not a drag, not a menu item, not a backend command. `rename_path` refuses a
 * directory change on purpose, so filing a clip meant leaving for Finder.
 *
 * The folder tile had carried `data-drop` and a `dropActive` prop the whole
 * time. Nothing was ever wired to them.
 */
async function bootLibrary(page: Page, view: "grid" | "list", opts: { refuse?: boolean } = {}) {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(([v, refuse]: [string, string]) => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.libraryRoots", JSON.stringify(["/e2e-mock/Footage"]));
    localStorage.setItem("saucebunny.libraryBrowser", JSON.stringify({ view: v, sort: "name", dir: "asc" }));
    if (refuse === "1") localStorage.setItem("e2e.refuseMove", "1");
  }, [view, opts.refuse ? "1" : "0"] as [string, string]);
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+2");
  await page.getByRole("treeitem", { name: "Footage" }).first().click();
  await expect(page.locator(".cp-lib-pane")).toBeVisible({ timeout: 10_000 });
}

const moves = (page: Page) => page.evaluate(() =>
  ((window as unknown as { __TAURI_MOCK__: { invoked: () => { cmd: string; args: unknown }[] } })
    .__TAURI_MOCK__.invoked())
    .filter((c) => c.cmd === "move_library_file")
    .map((c) => c.args as { srcPath: string; destDir: string }));

const centre = (b: { x: number; y: number; width: number; height: number }) =>
  ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/** A real drag: press, cross the threshold, land on the target. */
async function dragTo(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 8 });
  await page.mouse.move(to.x, to.y, { steps: 8 });
}

for (const view of ["grid", "list"] as const) {
  // Scoped to the pane: Home stays mounted (hidden) behind the Library and
  // its cards share these classes.
  const fileSel = view === "grid" ? ".cp-lib-pane .cp-lib-card:not(.cp-lib-foldercard)" : ".cp-lib-pane .cp-lib-lrow:not(.cp-lib-lrow-folder)";
  const folderSel = view === "grid" ? ".cp-lib-pane .cp-lib-foldercard" : ".cp-lib-pane .cp-lib-lrow-folder";

  test(`dragging a file onto a folder files it there (${view} view)`, async ({ page }) => {
    await bootLibrary(page, view);
    const file = page.locator(fileSel).first();
    const folder = page.locator(folderSel).first();
    await expect(file).toBeVisible({ timeout: 10_000 });
    await expect(folder).toBeVisible();
    const src = await file.getAttribute("data-path");
    const dest = await folder.getAttribute("data-drop");
    expect(src, "the file carries no data-path, so it cannot be dragged").toBeTruthy();
    expect(dest, "the folder carries no data-drop, so it cannot be a target").toBeTruthy();

    await dragTo(page, centre((await file.boundingBox())!), centre((await folder.boundingBox())!));
    // The target says it will take the drop BEFORE the mouse comes up.
    await expect(folder).toHaveClass(/dropping/);
    await page.mouse.up();

    await expect.poll(() => moves(page)).toEqual([{ srcPath: src, destDir: dest }]);
  });

  test(`the ghost names what is being carried (${view} view)`, async ({ page }) => {
    await bootLibrary(page, view);
    const file = page.locator(fileSel).first();
    await expect(file).toBeVisible({ timeout: 10_000 });
    const folder = page.locator(folderSel).first();
    const start = centre((await file.boundingBox())!);
    const end = centre((await folder.boundingBox())!);

    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 8 });
    await expect(page.locator(".cp-card-ghost")).toHaveText("1 file");
    await page.mouse.up();
    await expect(page.locator(".cp-card-ghost")).toHaveCount(0);
  });

  test(`a refused move is reported, not swallowed (${view} view)`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await bootLibrary(page, view, { refuse: true });
    const file = page.locator(fileSel).first();
    const folder = page.locator(folderSel).first();
    await expect(file).toBeVisible({ timeout: 10_000 });

    await dragTo(page, centre((await file.boundingBox())!), centre((await folder.boundingBox())!));
    await page.mouse.up();

    await expect(page.locator(".cp-lib-move-err")).toContainText(/already exists/i);
    expect(errors, "the refusal escaped as an unhandled rejection").toEqual([]);
  });

  test(`a plain click still selects, so a press is not a drag (${view} view)`, async ({ page }) => {
    await bootLibrary(page, view);
    const file = page.locator(fileSel).first();
    await expect(file).toBeVisible({ timeout: 10_000 });
    const c = centre((await file.boundingBox())!);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x + 2, c.y + 1);   // under the threshold
    await page.mouse.up();
    expect(await moves(page), "a wobble moved a file").toEqual([]);
  });
}
