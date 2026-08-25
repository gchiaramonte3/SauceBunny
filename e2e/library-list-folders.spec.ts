import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * List view is a different SPELLING of the file wall, not a smaller one.
 *
 * The list branch rendered `items` only. Three defects came out of that one
 * omission:
 *
 *  - a folder holding nothing but folders was a completely blank pane (the
 *    empty note is suppressed whenever folders exist, so it did not even say
 *    "nothing here"), and an ordinary folder simply vanished from its parent;
 *  - `names` for type-ahead lists folders FIRST to match the grid, while the
 *    roving grid reads its elements from `.cp-lib-lrow` - so every row was
 *    offset by the folder count and typing a name selected the wrong file;
 *  - and the row's context menu never got the Trash verb the card has, so
 *    switching to List view removed the only way to delete a file.
 */
async function bootLibrary(page: Page, opts: { nested?: boolean } = {}): Promise<void> {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript((nested) => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.libraryRoots", JSON.stringify(["/e2e-mock/Footage"]));
    if (nested) localStorage.setItem("e2e.nestedFolders", "1");
  }, opts.nested === true);
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+2");
  await expect(page.locator(".cp-lib-pane")).toBeVisible({ timeout: 10_000 });
}

/** Switch the browser to list mode through its own control. */
async function toList(page: Page) {
  await page.getByRole("button", { name: /List view/i }).click();
  await expect(page.locator(".cp-lib-list")).toBeVisible();
}

async function openRoot(page: Page) {
  await page.getByRole("treeitem", { name: "Footage" }).first().click();
  await expect(page.locator(".cp-lib-pane")).toBeVisible();
}

test("a folder is a row in list view, the way it is a tile in grid view", async ({ page }) => {
  await bootLibrary(page);
  await openRoot(page);
  // Grid first, as the reference: one container + two files.
  await expect(page.locator(".cp-lib-foldercard")).toHaveCount(1);

  await toList(page);
  await expect(page.locator(".cp-lib-lrow-folder")).toHaveCount(1);
  await expect(page.locator(".cp-lib-lrow-folder")).toContainText("Interviews");
  // Folders above files, exactly as the grid orders them.
  const first = page.locator(".cp-lib-lrow").first();
  await expect(first).toHaveClass(/cp-lib-lrow-folder/);
});

test("a folder holding only folders is not a blank pane", async ({ page }) => {
  await bootLibrary(page, { nested: true });
  await openRoot(page);
  await toList(page);

  await page.locator(".cp-lib-lrow-folder").filter({ hasText: "Archive" }).click();
  // Archive holds one folder and no files. The pane must show that folder
  // rather than nothing at all.
  await expect(page.locator(".cp-lib-lrow")).toHaveCount(1);
  await expect(page.locator(".cp-lib-lrow-folder")).toContainText("2019");
});

test("a folder row opens the folder", async ({ page }) => {
  await bootLibrary(page);
  await openRoot(page);
  await toList(page);
  await page.locator(".cp-lib-lrow-folder").click();
  await expect(page.locator(".cp-lib-lrow").filter({ hasText: "intro.mp4" })).toHaveCount(1);
});

test("type-ahead lands on the name it was given", async ({ page }) => {
  // The index bug: `names` is [Interviews, clip-a.mp4, voice-memo.m4a] while
  // the rows were [clip-a.mp4, voice-memo.m4a]. Typing "v" resolved to
  // names[2] and focused rows[2], which did not exist; typing "c" resolved to
  // names[1] and focused voice-memo. Off by the folder count, silently.
  await bootLibrary(page);
  await openRoot(page);
  await toList(page);

  await page.locator(".cp-lib-lrow").first().focus();
  await page.keyboard.type("voice");
  await expect(page.locator(".cp-lib-lrow:focus")).toContainText("voice-memo.m4a");

  // A pause ends the word (the roving grid resets its buffer after 700ms);
  // without it "clip" appends to "voice" and matches nothing.
  await page.waitForTimeout(800);
  await page.keyboard.type("clip");
  await expect(page.locator(".cp-lib-lrow:focus")).toContainText("clip-a.mp4");
});

test("a list row can be moved to the Trash, same as a card", async ({ page }) => {
  await bootLibrary(page);
  await openRoot(page);
  await toList(page);

  const row = page.locator(".cp-lib-lrow").filter({ hasText: "clip-a.mp4" });
  await row.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: /Move to Trash/ })).toBeVisible();
});
