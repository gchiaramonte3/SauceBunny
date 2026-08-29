import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * "Make a container here", in the same place on every shelf that has one.
 *
 * It was built once, for the frames shelf, and put in that pane's COUNT LINE
 * - an organising verb inside a status readout - while the Library had no way
 * to make a folder at all and the transcripts picker offered a bare "+" with
 * no name on it. Three shelves, three answers, one of them missing.
 *
 * The control now lives in LibraryBrowserBar, which the folder pane, the
 * frames shelf and the web shelf already share, and the reader mounts the
 * same class. This pins that: same class, same toolbar, everywhere.
 */
const BTN = ".cp-newfolder-btn";

async function boot(page: Page): Promise<void> {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.permissioned", "1");
    localStorage.setItem("saucebunny.libraryRoots", JSON.stringify(["/e2e-mock/Footage"]));
    localStorage.setItem("e2e.transcripts", "1");
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
}

test("the frames shelf offers it in the toolbar, not in its count line", async ({ page }) => {
  await boot(page);
  await page.keyboard.press("Meta+2");
  await page.getByRole("treeitem", { name: "Frames" }).first().click();
  await expect(page.locator(".cp-lib-bar " + BTN)).toBeVisible();
  // ...and no longer beside the "N frames · N KB on disk" readout.
  await expect(page.locator(".cp-web-summary " + BTN)).toHaveCount(0);
});

test("the web shelf offers it too, named for what it makes", async ({ page }) => {
  await boot(page);
  await page.keyboard.press("Meta+2");
  await page.getByRole("treeitem", { name: "From the web" }).first().click();
  const btn = page.locator(".cp-lib-bar " + BTN);
  await expect(btn).toBeVisible();
  // A collection is a tag, not a directory, so it does not claim to be one.
  await expect(btn).toHaveText(/New collection/);
});

test("the Library offers it inside a folder, and not at All", async ({ page }) => {
  await boot(page);
  await page.keyboard.press("Meta+2");
  await expect(page.locator(".cp-view-library")).toBeVisible();
  await page.locator(".cp-lib-statusbar").first().waitFor({ timeout: 10_000 });

  // "All" is a union of every root: there is no single directory a new folder
  // would belong to, so the control is honestly absent.
  await expect(page.locator(".cp-lib-bar " + BTN)).toHaveCount(0);

  await page.getByRole("treeitem", { name: "Footage" }).first().click();
  await expect(page.locator(".cp-lib-bar " + BTN)).toBeVisible();
});

test("the transcripts picker mounts the same control, with a name on it", async ({ page }) => {
  await boot(page);
  await page.keyboard.press("Meta+5");
  await expect(page.locator(".cp-view-reader")).toBeVisible();
  const btn = page.locator(".cp-reader-picker " + BTN);
  await expect(btn).toBeVisible();
  await expect(btn).toHaveText(/New project/);
});

test("it names the folder inline rather than opening a dialog", async ({ page }) => {
  // Making a folder is a mkdir. A modal in front of that is ceremony, and the
  // behaviour has to be the same on every shelf, which is why the bar owns it.
  await boot(page);
  await page.keyboard.press("Meta+2");
  await page.getByRole("treeitem", { name: "Frames" }).first().click();
  await page.locator(".cp-lib-bar " + BTN).click();

  const input = page.getByLabel("New folder name");
  await expect(input).toBeFocused();
  await expect(page.locator("[role=dialog]")).toHaveCount(0);

  await input.fill("Selects 2");
  await input.press("Enter");
  await expect.poll(() => page.evaluate(() =>
    ((window as unknown as { __TAURI_MOCK__: { invoked: () => { cmd: string; args: unknown }[] } })
      .__TAURI_MOCK__.invoked()).filter((c) => c.cmd === "create_frames_folder")
      .map((c) => (c.args as { parent: string; name: string })),
  )).toEqual([{ parent: "", name: "Selects 2" }]);
});

test("Escape abandons the naming without creating anything", async ({ page }) => {
  await boot(page);
  await page.keyboard.press("Meta+2");
  await page.getByRole("treeitem", { name: "Frames" }).first().click();
  await page.locator(".cp-lib-bar " + BTN).click();
  const input = page.getByLabel("New folder name");
  await input.fill("Nope");
  await input.press("Escape");
  await expect(page.locator(".cp-lib-bar " + BTN)).toBeVisible();
  expect(await page.evaluate(() =>
    ((window as unknown as { __TAURI_MOCK__: { invoked: () => { cmd: string }[] } })
      .__TAURI_MOCK__.invoked()).filter((c) => c.cmd === "create_frames_folder").length)).toBe(0);
});

test("a folder that has just been made APPEARS, which is the whole bug", async ({ page }) => {
  // list_frames only ever reports FILES, and the shelf derived its folder
  // list from those, so a folder holding nothing could not be shown at all.
  // It was created on disk and the screen did not change - which is
  // indistinguishable from a broken button.
  await boot(page);
  await page.keyboard.press("Meta+2");
  await page.getByRole("treeitem", { name: "Frames" }).first().click();
  await expect(page.locator(".cp-lib-foldercard")).toHaveCount(1); // the seeded one

  await page.locator(".cp-lib-bar " + BTN).click();
  const input = page.getByLabel("New folder name");
  await input.fill("Keepers");
  await input.press("Enter");

  const tile = page.locator(".cp-lib-foldercard").filter({ hasText: "Keepers" });
  await expect(tile).toBeVisible();
  await expect(tile).toContainText("0 items");
  // The naming field closes on success.
  await expect(page.getByLabel("New folder name")).toHaveCount(0);
});

test("a refused name is reported instead of silently doing nothing", async ({ page }) => {
  // createFolder used to catch every error and discard it, so a duplicate
  // name and a broken command looked identical - and both looked like
  // nothing happening.
  await boot(page);
  await page.keyboard.press("Meta+2");
  await page.getByRole("treeitem", { name: "Frames" }).first().click();
  await page.locator(".cp-lib-bar " + BTN).click();
  const input = page.getByLabel("New folder name");
  await input.fill("Dupe");
  await input.press("Enter");
  await expect(page.locator(".cp-lib-foldercard").filter({ hasText: "Dupe" })).toBeVisible();

  // Same name again: the mock's real command refuses a duplicate.
  await page.locator(".cp-lib-bar " + BTN).click();
  const again = page.getByLabel("New folder name");
  await again.fill("Dupe");
  await again.press("Enter");
  await expect(page.locator(".cp-newfolder-err")).toBeVisible();
});
