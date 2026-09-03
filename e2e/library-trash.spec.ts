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
 * It REMOVES rather than deletes: the card leaves the shelf and the file is
 * untouched. This used to be a Move to Trash, and the header used to argue
 * that the Trash was what made it shippable. The rule changed - the app does
 * not delete anyone's media at all now - and the removal is undoable, which
 * the Trash never was from inside the app.
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

/**
 * THE LIBRARY NEVER DELETES ANYONE'S FILE.
 *
 * This file used to prove the opposite: that the card menu offered "Move to
 * Trash", asked first, and invoked `move_to_trash`. That verb is gone, along
 * with the frames shelf's `delete_frame` - the app removes things from its own
 * shelves and leaves the media alone. Both Rust commands were deleted rather
 * than left registered, so the only way this could regress is by someone
 * writing them again, which is what these assertions are for.
 */
test("the card menu offers removal, and nothing destructive", async ({ page }) => {
  await boot(page);
  await openMenu(page);
  await expect(page.getByRole("menuitem", { name: /Remove from Library/ })).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: /Move to Trash|Delete/ }),
    "a destructive verb is back in the Library's card menu",
  ).toHaveCount(0);
});

test("removing takes the card off the shelf without touching the file", async ({ page }) => {
  await boot(page);
  const before = await page.locator(".cp-lib-pane .cp-lib-card:not(.cp-lib-foldercard)").count();
  expect(before, "no cards to remove").toBeGreaterThan(0);

  await openMenu(page);
  await page.getByRole("menuitem", { name: /Remove from Library/ }).click();

  await expect
    .poll(() => page.locator(".cp-lib-pane .cp-lib-card:not(.cp-lib-foldercard)").count())
    .toBe(before - 1);
  // The point of the whole change: no command that destroys a file ran.
  expect(await calls(page, "move_to_trash")).toEqual([]);
  expect(await calls(page, "delete_frame")).toEqual([]);
});
