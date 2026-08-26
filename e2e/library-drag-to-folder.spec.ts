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

/**
 * The drag's keyboard-reachable twin.
 *
 * `e2e/transcript-drag.spec.ts` states the rule this repo holds itself to:
 * "the drag is an addition to a menu item, never the only route." The Library
 * shipped the drag first, so for one commit the only way to file a clip was a
 * pointer gesture. The menu item it needed already existed - LibraryCardMenu
 * has rendered "Move to folder…" behind an `onMove` prop the whole time.
 */
test("Move to folder… is in the menu, and files the file without a drag", async ({ page }) => {
  await bootLibrary(page, "list");
  const file = page.locator(".cp-lib-pane .cp-lib-lrow:not(.cp-lib-lrow-folder)").first();
  await expect(file).toBeVisible({ timeout: 10_000 });
  const src = await file.getAttribute("data-path");

  await file.click({ button: "right" });
  const item = page.getByRole("menuitem", { name: /Move to folder/ });
  await expect(item, "the menu offers no move, so the drag is the only route").toBeVisible();
  await item.click();

  // The picker offers exactly the folders the drag can reach.
  const dialog = page.getByRole("dialog", { name: /Move to folder/i });
  await expect(dialog).toBeVisible();
  const dest = await page.locator(".cp-lib-pane .cp-lib-lrow-folder").first().getAttribute("data-drop");
  await dialog.getByRole("button", { name: "Interviews" }).click();

  await expect.poll(() => moves(page)).toEqual([{ srcPath: src, destDir: dest }]);
});

test("the move picker traps focus, like every other dialog here", async ({ page }) => {
  await bootLibrary(page, "list");
  const file = page.locator(".cp-lib-pane .cp-lib-lrow:not(.cp-lib-lrow-folder)").first();
  await expect(file).toBeVisible({ timeout: 10_000 });
  await file.click({ button: "right" });
  await page.getByRole("menuitem", { name: /Move to folder/ }).click();

  const dialog = page.getByRole("dialog", { name: /Move to folder/i });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  for (let i = 0; i < 8; i++) await page.keyboard.press("Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest("[role=dialog]")),
    "focus escaped the move dialog").toBe(true);
});

/**
 * Finder's sidebar is a first-class drop target — "drag files onto any folder
 * listed there" — and it is usually where the destination IS: the folder you
 * want is one you can see in the tree, not necessarily a subfolder of the one
 * on screen. The Library's tree accepted nothing.
 */
test("a file can be dropped on a folder in the tree", async ({ page }) => {
  await bootLibrary(page, "list");
  const file = page.locator(".cp-lib-pane .cp-lib-lrow:not(.cp-lib-lrow-folder)").first();
  await expect(file).toBeVisible({ timeout: 10_000 });
  const src = await file.getAttribute("data-path");

  // A tree row naming a real directory.
  const treeRow = page.locator(".cp-lib-tree-row[data-drop]").first();
  await expect(treeRow).toBeVisible();
  const dest = await treeRow.getAttribute("data-drop");
  expect(dest, "no tree row offers a drop").toBeTruthy();

  await dragTo(page, centre((await file.boundingBox())!), centre((await treeRow.boundingBox())!));
  await expect(treeRow).toHaveClass(/dropping/);
  await page.mouse.up();

  await expect.poll(() => moves(page)).toEqual([{ srcPath: src, destDir: dest }]);
});

test("the aggregate and shelf rows are not drop targets", async ({ page }) => {
  // "All" is not a directory, and the two shelf rows are views over a
  // category. A target that lights up and then refuses is worse than one that
  // never offered.
  await bootLibrary(page, "list");
  await expect(page.locator(".cp-lib-tree-row").first()).toBeVisible({ timeout: 10_000 });
  for (const name of ["All", "From the web", "Frames"]) {
    const row = page.locator(".cp-lib-tree-row").filter({ hasText: name }).first();
    await expect(row, `${name} should not be a drop target`).not.toHaveAttribute("data-drop", /.+/);
  }
});

const copies = (page: Page) => page.evaluate(() =>
  ((window as unknown as { __TAURI_MOCK__: { invoked: () => { cmd: string; args: unknown }[] } })
    .__TAURI_MOCK__.invoked())
    .filter((c) => c.cmd === "copy_library_file")
    .map((c) => c.args as { srcPath: string; destDir: string }));

/**
 * Apple: "Option-drag: Copy the dragged item. The pointer changes while you
 * drag the item." Without it a copy and a move are indistinguishable, and only
 * one of them is recoverable.
 */
test("Option-dragging copies instead of moving, and says so", async ({ page }) => {
  await bootLibrary(page, "list");
  const file = page.locator(".cp-lib-pane .cp-lib-lrow:not(.cp-lib-lrow-folder)").first();
  const folder = page.locator(".cp-lib-pane .cp-lib-lrow-folder").first();
  await expect(file).toBeVisible({ timeout: 10_000 });
  const src = await file.getAttribute("data-path");
  const dest = await folder.getAttribute("data-drop");

  await page.keyboard.down("Alt");
  const from = centre((await file.boundingBox())!);
  const to = centre((await folder.boundingBox())!);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 8 });
  // The ghost says which act this is, before the drop commits.
  await expect(page.locator(".cp-card-ghost")).toHaveText(/^Copy /);
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Alt");

  await expect.poll(() => copies(page)).toEqual([{ srcPath: src, destDir: dest }]);
  expect(await moves(page), "an Option-drag moved the file as well").toEqual([]);
});

test("a plain drag still moves, and the ghost does not say Copy", async ({ page }) => {
  await bootLibrary(page, "list");
  const file = page.locator(".cp-lib-pane .cp-lib-lrow:not(.cp-lib-lrow-folder)").first();
  const folder = page.locator(".cp-lib-pane .cp-lib-lrow-folder").first();
  await expect(file).toBeVisible({ timeout: 10_000 });

  const from = centre((await file.boundingBox())!);
  const to = centre((await folder.boundingBox())!);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 8 });
  await expect(page.locator(".cp-card-ghost")).not.toHaveText(/Copy/);
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();

  expect(await copies(page), "a plain drag copied").toEqual([]);
  expect((await moves(page)).length).toBe(1);
});

/**
 * Finder's Path Bar is a documented drop target — "you can move items into the
 * appropriate folder in the Path Bar" — and it is the only gesture that moves a
 * file UP the tree without navigating away from it first.
 */
test("a breadcrumb ancestor takes a drop", async ({ page }) => {
  await bootLibrary(page, "list");
  // Go one level down so there IS an ancestor crumb.
  await page.locator(".cp-lib-pane .cp-lib-lrow-folder").first().click();
  const crumb = page.locator(".cp-lib-bcrumbs button[data-drop]").first();
  await expect(crumb).toBeVisible({ timeout: 10_000 });
  const dest = await crumb.getAttribute("data-drop");

  const file = page.locator(".cp-lib-pane .cp-lib-lrow:not(.cp-lib-lrow-folder)").first();
  await expect(file).toBeVisible();
  const src = await file.getAttribute("data-path");

  await dragTo(page, centre((await file.boundingBox())!), centre((await crumb.boundingBox())!));
  await expect(crumb).toHaveClass(/dropping/);
  await page.mouse.up();
  await expect.poll(() => moves(page)).toEqual([{ srcPath: src, destDir: dest }]);
});

test("the folder you are already in is not a drop target", async ({ page }) => {
  // Dropping a file where it already lives is a no-op, and a target that
  // lights up to do nothing is a lie.
  await bootLibrary(page, "list");
  await page.locator(".cp-lib-pane .cp-lib-lrow-folder").first().click();
  await expect(page.locator(".cp-lib-bcrumbs .cur")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".cp-lib-bcrumbs .cur")).not.toHaveAttribute("data-drop", /.+/);
});

/**
 * Spring-loaded folders: hold a drag over a folder and it opens, so a
 * destination two levels down is reachable without dropping the files
 * somewhere else first and dragging them again. On by default in Finder.
 */
test("holding a drag over a folder springs it open", async ({ page }) => {
  await bootLibrary(page, "list");
  const file = page.locator(".cp-lib-pane .cp-lib-lrow:not(.cp-lib-lrow-folder)").first();
  const folder = page.locator(".cp-lib-pane .cp-lib-lrow-folder").first();
  await expect(file).toBeVisible({ timeout: 10_000 });
  const folderName = (await folder.getAttribute("title")) ?? "";

  const from = centre((await file.boundingBox())!);
  const to = centre((await folder.boundingBox())!);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });

  // Hold. The breadcrumb gains the folder without the mouse coming up.
  await expect(page.locator(".cp-lib-bcrumbs .cur"), "the folder never sprang open")
    .toHaveText(folderName, { timeout: 4000 });
  await page.mouse.up();
});

test("crossing a folder on the way somewhere else does not spring it", async ({ page }) => {
  // The delay is the whole point: a folder that opened on contact would make
  // the pane rearrange itself under every drag that passed over one.
  await bootLibrary(page, "list");
  const file = page.locator(".cp-lib-pane .cp-lib-lrow:not(.cp-lib-lrow-folder)").first();
  const folder = page.locator(".cp-lib-pane .cp-lib-lrow-folder").first();
  await expect(file).toBeVisible({ timeout: 10_000 });
  const before = await page.locator(".cp-lib-bcrumbs").textContent();

  const from = centre((await file.boundingBox())!);
  const fb = (await folder.boundingBox())!;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2, { steps: 4 });
  await page.mouse.move(from.x, from.y, { steps: 4 });   // straight back off
  await page.waitForTimeout(900);
  expect(await page.locator(".cp-lib-bcrumbs").textContent()).toBe(before);
  await page.mouse.up();
});
