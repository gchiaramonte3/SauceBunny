import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * Getting rid of a file from the library.
 *
 * The frames shelf and the web shelf have always had a removal verb; the
 * file wall had none, so the one shelf holding somebody's actual footage was
 * the only one you could not remove anything from.
 *
 * It is the TRASH rather than a delete, and that distinction is the whole
 * reason it is allowed to ship: this app has no undo, and macOS already
 * offers Put Back on anything in there.
 */
async function boot(page: Page): Promise<void> {
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
  await expect(page.locator(".cp-view-library .cp-lib-card").first())
    .toBeVisible({ timeout: 10_000 });
}

const calls = (page: Page, cmd: string) => page.evaluate((c) =>
  ((window as unknown as { __TAURI_MOCK__: { invoked: () => { cmd: string; args: unknown }[] } })
    .__TAURI_MOCK__.invoked()).filter((x) => x.cmd === c).map((x) => x.args), cmd);

async function openMenu(page: Page) {
  await page.locator(".cp-view-library .cp-lib-card:not(.cp-lib-foldercard)").first().hover();
  await page.getByRole("button", { name: "More actions" }).first().click();
}

test("the file card offers Move to Trash, which it never did before", async ({ page }) => {
  await boot(page);
  await openMenu(page);
  await expect(page.getByRole("menuitem", { name: /Move to Trash/ })).toBeVisible();
});

test("it asks first, and declining moves nothing", async ({ page }) => {
  await boot(page);
  page.on("dialog", (d) => d.dismiss());
  await openMenu(page);
  await page.getByRole("menuitem", { name: /Move to Trash/ }).click();
  await page.waitForTimeout(200);
  expect(await calls(page, "move_to_trash")).toEqual([]);
});

test("accepting moves that file to the Trash and rescans", async ({ page }) => {
  await boot(page);
  page.on("dialog", (d) => d.accept());
  const path = await page.locator(".cp-view-library .cp-lib-card:not(.cp-lib-foldercard)")
    .first().getAttribute("data-path");
  await openMenu(page);
  await page.getByRole("menuitem", { name: /Move to Trash/ }).click();

  await expect.poll(() => calls(page, "move_to_trash")).toEqual([{ path }]);
  // The wall has to re-read, or the row stays on screen pointing at nothing.
  expect((await calls(page, "scan_library_folder")).length).toBeGreaterThan(1);
});

test("it never reaches for a plain delete", async ({ page }) => {
  // The distinction that makes this shippable. A recoverable removal and an
  // unrecoverable one are different features.
  await boot(page);
  page.on("dialog", (d) => d.accept());
  await openMenu(page);
  await page.getByRole("menuitem", { name: /Move to Trash/ }).click();
  await expect.poll(async () => (await calls(page, "move_to_trash")).length).toBe(1);
  expect(await calls(page, "delete_frame")).toEqual([]);
  expect(await calls(page, "remove_file")).toEqual([]);
});
