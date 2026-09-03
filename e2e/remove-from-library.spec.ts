import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * "Remove from Library" takes a clip off the shelf and leaves the file alone.
 *
 * Requested because the only way to get something out of the Library was
 * "Move to Trash…", which conflates two different acts: one is a statement
 * about this app's view, the other is a statement about someone's footage.
 *
 * The Library is a LIVE SCAN, so this can only be an exclusion the scan
 * filters through - there is no curated list to delete a row from. That is
 * also why this is an end-to-end test rather than a unit one: the store is
 * covered in src/lib/library-hidden.test.ts, and the thing that kept being
 * wrong is the WIRING - the menu item existing but reaching nothing.
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
  // Switch EXPLICITLY, both ways. The view is a persisted preference, so a
  // test that only switches for one case inherits whatever the last run left
  // and silently measures the wrong view.
  await page.getByRole("button", { name: view === "list" ? /List view/i : /Grid view/i }).click();
  await expect(rows(page, view).first()).toBeVisible();
}

/**
 * Scoped to the VISIBLE library.
 *
 * The app mounts a library in the Home view and another in the Library view,
 * and keeps the loser alive behind `display: none` rather than unmounting it -
 * the same keep-alive that hidden-instance-contract exists for elsewhere. A
 * bare `.cp-lib-card` therefore resolves to a card in the hidden Home copy,
 * with a zero-sized box that can never be clicked, and the failure reads as
 * "the feature is broken" rather than "the selector is wrong".
 */
const rows = (page: Page, view: "grid" | "list") =>
  page.locator(view === "list" ? ".cp-lib-list .cp-lib-lrow" : ".cp-lib-card")
    .locator("visible=true");

for (const view of ["grid", "list"] as const) {
  test(`the ${view} view removes a clip without deleting it`, async ({ page }) => {
    await bootLibrary(page, view);

    const before = await rows(page, view).count();
    // CANARY. A shelf that failed to seed has zero rows, and "one fewer than
    // zero" is a comparison that never runs.
    expect(before, "the library did not seed").toBeGreaterThan(2);

    await rows(page, view).first().click({ button: "right" });
    const item = page.getByRole("menuitem", { name: "Remove from Library" });
    await expect(item, "the menu item is missing in this view").toBeVisible();

    // It must NOT be the destructive one, and both must be offered.
    // "Move to Trash" is gone: the app no longer deletes anyone's media, so
    // removal is the only verb and this asserts nothing destructive returned.
    await expect(page.getByRole("menuitem", { name: /Move to Trash|Delete/ })).toHaveCount(0);

    // Nothing may reach the backend: this touches no file.
    const calls: string[] = [];
    page.on("console", (m) => { if (m.text().startsWith("[tauri-mock]")) calls.push(m.text()); });

    await item.click();
    await expect(rows(page, view)).toHaveCount(before - 1);
    expect(
      calls.filter((c) => /move_to_trash|delete/i.test(c)),
      "removing from the Library reached the filesystem",
    ).toEqual([]);
  });
}

test("undo puts it back", async ({ page }) => {
  await bootLibrary(page, "list");
  const before = await rows(page, "list").count();
  expect(before, "the library did not seed").toBeGreaterThan(2);

  await rows(page, "list").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove from Library" }).click();
  await expect(rows(page, "list")).toHaveCount(before - 1);

  await page.keyboard.press("Meta+z");
  await expect(rows(page, "list"), "undo did not restore the clip").toHaveCount(before);
});

test("it survives a restart, and Settings is the way back", async ({ page }) => {
  await bootLibrary(page, "list");
  const before = await rows(page, "list").count();
  await rows(page, "list").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove from Library" }).click();
  await expect(rows(page, "list")).toHaveCount(before - 1);

  // A removal that did not persist would silently come back on next launch,
  // which is the failure this whole feature is meant to avoid.
  const stored = await page.evaluate(() => localStorage.getItem("saucebunny.libraryHidden"));
  expect(stored, "the removal was not persisted").toBeTruthy();
  expect(JSON.parse(stored!).length).toBe(1);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const restore = page.getByRole("button", { name: /Show 1 again/ });
  await expect(restore, "Settings offers no way back").toBeVisible();
  await restore.click();
  await expect(page.getByRole("button", { name: /Nothing removed|Restored/ })).toBeVisible();
});
