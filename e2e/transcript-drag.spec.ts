import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * Filing a transcript by dragging its row onto a group heading.
 *
 * The picker already had "Move to folder…" in the row's context menu, so
 * this is a faster way to do something the app could already do - which is
 * also what keeps it off the accessibility ledger: the drag is an addition
 * to a menu item, never the only route.
 *
 * BOTH kinds of heading take a drop, because both are real directories: a
 * project at the library root, and the dated YYYY-MM bucket a transcript came
 * from. The second is what lets a filed transcript be dragged back OUT of a
 * project, rather than the gesture being one-way.
 */
async function bootReader(page: Page): Promise<void> {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    // Opt in to the seeded transcript library (see tauri-mock).
    localStorage.setItem("e2e.transcripts", "1");
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+5");
  await expect(page.locator(".cp-view-reader")).toBeVisible();
  await expect(page.locator(".cp-reader-row").first()).toBeVisible({ timeout: 10_000 });
}

const movesFor = (page: Page) => page.evaluate(() =>
  ((window as unknown as { __TAURI_MOCK__: { invoked: () => { cmd: string; args: unknown }[] } })
    .__TAURI_MOCK__.invoked())
    .filter((c) => c.cmd === "move_transcript_to_folder")
    .map((c) => c.args as { srtPath: string; destDir: string }));

const centre = (b: { x: number; y: number; width: number; height: number }) =>
  ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

async function dragTo(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}

const projectHead = (page: Page) => page.locator(".cp-reader-project").first();
const monthHead = (page: Page) => page.locator(".cp-reader-group-label").first();

test("every row and every heading carries the identity the drag needs", async ({ page }) => {
  await bootReader(page);
  const rows = await page.locator(".cp-reader-row")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-path")));
  expect(rows.length).toBeGreaterThan(1);
  expect(rows.every((p) => !!p), "a row has no data-path, so it cannot be dragged").toBe(true);

  const drops = await page.locator("[data-drop]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-drop")));
  expect(drops).toContain("Marry Harry");
  expect(drops).toContain("2026-08");
});

test("dragging a row onto a project files it there", async ({ page }) => {
  await bootReader(page);
  const row = page.locator(".cp-reader-row").first();
  const srtPath = await row.getAttribute("data-path");

  await dragTo(page, centre((await row.boundingBox())!), centre((await projectHead(page).boundingBox())!));

  await expect.poll(() => movesFor(page)).toEqual([{
    srtPath,
    destDir: "/e2e-mock/Documents/Sauce Bunny/Transcripts/Marry Harry",
  }]);
});

test("a filed transcript can be dragged back out onto its dated bucket", async ({ page }) => {
  // The reverse gesture. Without the month bucket as a destination the drag
  // would be a one-way trip and the row menu the only way back.
  await bootReader(page);
  const filed = page.locator(".cp-reader-row").filter({ hasText: "already-filed" }).first();
  const srtPath = await filed.getAttribute("data-path");

  await dragTo(page, centre((await filed.boundingBox())!), centre((await monthHead(page).boundingBox())!));

  await expect.poll(() => movesFor(page)).toEqual([{
    srtPath,
    destDir: "/e2e-mock/Documents/Sauce Bunny/Transcripts/2026-08",
  }]);
});

test("dropping a row on the group it already lives in does nothing", async ({ page }) => {
  await bootReader(page);
  const row = page.locator(".cp-reader-row").first();
  await dragTo(page, centre((await row.boundingBox())!), centre((await monthHead(page).boundingBox())!));
  await page.waitForTimeout(200);
  expect(await movesFor(page)).toEqual([]);
});

test("a collapsed project is still a target, which is when it matters most", async ({ page }) => {
  await bootReader(page);
  const head = projectHead(page);
  // Fold it. The heading stays; its rows go.
  await head.getByRole("button", { name: /Collapse/ }).click();
  await expect(page.locator(".cp-reader-row").filter({ hasText: "already-filed" })).toHaveCount(0);

  const row = page.locator(".cp-reader-row").first();
  const srtPath = await row.getAttribute("data-path");
  await dragTo(page, centre((await row.boundingBox())!), centre((await head.boundingBox())!));

  await expect.poll(() => movesFor(page)).toEqual([{
    srtPath,
    destDir: "/e2e-mock/Documents/Sauce Bunny/Transcripts/Marry Harry",
  }]);
});

test("the heading highlights and the ghost names what is moving", async ({ page }) => {
  await bootReader(page);
  const row = page.locator(".cp-reader-row").first();
  const head = projectHead(page);
  const start = centre((await row.boundingBox())!);
  const end = centre((await head.boundingBox())!);

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 6 });
  await expect(page.locator(".cp-card-ghost")).toHaveText("1 transcript");
  await page.mouse.move(end.x, end.y, { steps: 6 });
  await expect(head).toHaveClass(/dropping/);
  await page.mouse.up();
  await expect(page.locator(".cp-card-ghost")).toHaveCount(0);
});

test("an ordinary click still opens the transcript", async ({ page }) => {
  // The threshold again: the row is a button first and a drag handle second.
  await bootReader(page);
  const row = page.locator(".cp-reader-row").first();
  const c = centre((await row.boundingBox())!);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 2, c.y + 1);
  await page.mouse.up();

  await expect(page.locator(".cp-card-ghost")).toHaveCount(0);
  expect(await movesFor(page)).toEqual([]);
  await expect(row).toHaveAttribute("aria-current", "true");
});
