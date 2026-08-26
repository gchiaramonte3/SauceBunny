import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * Finder's arrow keys move the SELECTION, not just a focus ring, and Shift
 * extends it. The Library moved focus and left the selection where it was, so
 * the keyboard could walk the wall without ever choosing anything — and ⌘Delete
 * did nothing at all, though the Trash verb existed in two menus.
 *
 * Apple: "arrow keys move the selection", "Shift-arrow extends the selection",
 * "Command-Delete: Move the selected item to the Trash."
 */
async function bootLibrary(page: Page): Promise<void> {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.libraryRoots", JSON.stringify(["/e2e-mock/Footage"]));
    localStorage.setItem("saucebunny.libraryBrowser", JSON.stringify({ view: "list", sort: "name", dir: "asc" }));
    localStorage.setItem("e2e.manyFiles", "6");
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+2");
  await page.getByRole("treeitem", { name: "Footage" }).first().click();
  await expect(page.locator(".cp-lib-pane .cp-lib-lrow").first()).toBeVisible({ timeout: 10_000 });
}

const rows = (page: Page) => page.locator(".cp-lib-pane .cp-lib-lrow:not(.cp-lib-lrow-folder)");
const selected = (page: Page) =>
  page.locator(".cp-lib-pane .cp-lib-lrow.selected, .cp-lib-pane .cp-lib-lrow[aria-current='true']");

test("an arrow key moves the selection, not just the focus ring", async ({ page }) => {
  await bootLibrary(page);
  const first = rows(page).first();
  await first.focus();
  await page.keyboard.press("ArrowDown");

  // Exactly one selected, and it is where the keyboard now is.
  await expect(selected(page)).toHaveCount(1);
  const focusedName = await page.evaluate(() =>
    document.activeElement?.getAttribute("title") ?? null);
  await expect(selected(page).first()).toHaveAttribute("title", focusedName!);
});

test("Shift+Arrow extends the selection", async ({ page }) => {
  await bootLibrary(page);
  await rows(page).first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(selected(page)).toHaveCount(1);

  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  // A range, not a single move.
  await expect(selected(page)).toHaveCount(3);
});

test("a bare arrow after a range collapses back to one", async ({ page }) => {
  // Finder: an unmodified arrow replaces the selection rather than adding.
  await bootLibrary(page);
  await rows(page).first().focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(selected(page)).toHaveCount(2);

  await page.keyboard.press("ArrowDown");
  await expect(selected(page)).toHaveCount(1);
});

test("⌘Delete moves the selection to the Trash", async ({ page }) => {
  await bootLibrary(page);
  page.on("dialog", (d) => void d.accept());
  await rows(page).first().focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(selected(page)).toHaveCount(2);

  await page.keyboard.press("Meta+Backspace");
  await expect.poll(() => page.evaluate(() =>
    ((window as unknown as { __TAURI_MOCK__: { invoked: () => { cmd: string }[] } })
      .__TAURI_MOCK__.invoked()).filter((c) => c.cmd === "move_to_trash").length
  )).toBe(2);
});

test("⌘Delete with nothing selected does nothing", async ({ page }) => {
  let dialogs = 0;
  await bootLibrary(page);
  page.on("dialog", (d) => { dialogs += 1; void d.dismiss(); });
  await page.locator(".cp-lib-pane").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Meta+Backspace");
  await page.waitForTimeout(200);
  expect(dialogs, "asked to trash an empty selection").toBe(0);
});
