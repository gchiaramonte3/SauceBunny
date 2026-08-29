import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * The transcripts picker: draggable width, and a compact list.
 *
 * The picker was a fixed 300px column - a long project name truncated and
 * there was nothing to do about it - and its only row was a 52px poster plus
 * two lines, which is right for recognising footage by its frame and wrong
 * for a hundred named episodes.
 *
 * The resizer is the SAME hook the Library tree mounts, so the two panes
 * cannot drift apart; that is the part worth pinning, along with the
 * keyboard route, since a drag-only resize is unreachable without one.
 */
async function bootReader(page: Page): Promise<void> {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.permissioned", "1");
    localStorage.setItem("e2e.transcripts", "1");
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+5");
  await expect(page.locator(".cp-reader-picker")).toBeVisible({ timeout: 10_000 });
}

const pickerWidth = async (page: Page) =>
  (await page.locator(".cp-reader-picker").boundingBox())!.width;

test("dragging the edge makes the picker wider, and it stays", async ({ page }) => {
  await bootReader(page);
  const before = await pickerWidth(page);
  const handle = (await page.locator(".cp-reader-picker-resize").boundingBox())!;

  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + 120, handle.y + handle.height / 2, { steps: 8 });
  await page.mouse.up();

  const after = await pickerWidth(page);
  expect(after).toBeGreaterThan(before + 60);

  // A workspace decision, not a scroll position: it survives a relaunch.
  await page.reload();
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+5");
  await expect(page.locator(".cp-reader-picker")).toBeVisible({ timeout: 10_000 });
  expect(Math.abs(await pickerWidth(page) - after)).toBeLessThan(4);
});

test("it clamps rather than letting the pane swallow the page", async ({ page }) => {
  await bootReader(page);
  const handle = (await page.locator(".cp-reader-picker-resize").boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + 3000, handle.y + handle.height / 2, { steps: 6 });
  await page.mouse.up();
  expect(await pickerWidth(page)).toBeLessThanOrEqual(520);

  const h2 = (await page.locator(".cp-reader-picker-resize").boundingBox())!;
  await page.mouse.move(h2.x + h2.width / 2, h2.y + h2.height / 2);
  await page.mouse.down();
  await page.mouse.move(h2.x - 3000, h2.y + h2.height / 2, { steps: 6 });
  await page.mouse.up();
  expect(await pickerWidth(page)).toBeGreaterThanOrEqual(232);
});

test("the keyboard resizes it too, because a drag-only control is unreachable", async ({ page }) => {
  await bootReader(page);
  const before = await pickerWidth(page);
  await page.locator(".cp-reader-picker-resize").focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
  expect(await pickerWidth(page)).toBeGreaterThan(before);

  await page.keyboard.press("Home");
  expect(Math.abs(await pickerWidth(page) - 300)).toBeLessThan(4);
});

test("compact drops the posters and keeps the names", async ({ page }) => {
  await bootReader(page);
  // Open a group so there are rows to look at.
  await page.locator(".cp-reader-group-label button").first().click();
  await expect(page.locator(".cp-reader-row").first()).toBeVisible();
  await expect(page.locator(".cp-reader-row-thumb").first()).toBeVisible();
  const tall = (await page.locator(".cp-reader-row").first().boundingBox())!.height;

  await page.getByRole("button", { name: "Compact list" }).click();
  await expect(page.locator(".cp-reader-row-thumb").first()).toBeHidden();
  const short = (await page.locator(".cp-reader-row").first().boundingBox())!.height;
  expect(short).toBeLessThan(tall);
  // The name is what a compact list is for; it must still be there.
  await expect(page.locator(".cp-reader-row-title").first()).toBeVisible();
});

test("the compact choice is remembered", async ({ page }) => {
  await bootReader(page);
  await page.getByRole("button", { name: "Compact list" }).click();
  await expect(page.locator(".cp-reader-picker.compact")).toBeVisible();

  await page.reload();
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+5");
  await expect(page.locator(".cp-reader-picker.compact")).toBeVisible({ timeout: 10_000 });
});
