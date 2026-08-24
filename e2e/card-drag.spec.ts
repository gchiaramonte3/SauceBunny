import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * Dragging frames onto a folder tile to file them.
 *
 * The app had no card dragging anywhere - `onDragStart` appeared zero times
 * in the whole frontend - so this is new behaviour rather than parity, and
 * it is built on POINTER events rather than HTML5 drag-and-drop: the app
 * needs Tauri's `dragDropEnabled` for importing files from Finder, which
 * installs an OS drag handler over the webview, and pointer events stay well
 * clear of it. That decision is also why this test can exist at all.
 *
 * Only reachable in a real browser: a drag is a threshold, a hit-test
 * against measured rectangles, and a click that must NOT arrive afterwards.
 * jsdom has no layout, so none of the three are observable there.
 */
const SHELF = ".cp-web-view";

async function bootFrames(page: Page): Promise<void> {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.libraryRoots", JSON.stringify(["/e2e-mock/Footage"]));
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+2");
  await page.getByRole("treeitem", { name: "Frames" }).first().click();
  await expect(page.locator(SHELF + " .cp-lib-foldercard")).toBeVisible({ timeout: 10_000 });
}

const moves = (page: Page) => page.evaluate(() =>
  ((window as unknown as { __TAURI_MOCK__: { invoked: () => { cmd: string; args: unknown }[] } })
    .__TAURI_MOCK__.invoked())
    .filter((c) => c.cmd === "move_frame_to_folder")
    .map((c) => c.args as { path: string; dest: string }));

/** Press on `from`, travel to `to`, release. */
async function dragTo(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}

const centre = (b: { x: number; y: number; width: number; height: number }) =>
  ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

test("dragging one frame onto a folder files it there", async ({ page }) => {
  await bootFrames(page);
  const card = page.locator(SHELF + " .cp-lib-card:not(.cp-lib-foldercard)").first();
  const folder = page.locator(SHELF + " .cp-lib-foldercard").first();
  const path = await card.getAttribute("data-path");
  const dest = await folder.getAttribute("data-drop");
  expect(path, "the card has no identity to drag").toBeTruthy();
  expect(dest, "the folder tile is not a drop container").toBeTruthy();

  await dragTo(page, centre((await card.boundingBox())!), centre((await folder.boundingBox())!));

  await expect.poll(() => moves(page)).toEqual([{ path, dest }]);
});

test("the ghost follows the pointer and names the count", async ({ page }) => {
  await bootFrames(page);
  const card = page.locator(SHELF + " .cp-lib-card:not(.cp-lib-foldercard)").first();
  const folder = page.locator(SHELF + " .cp-lib-foldercard").first();
  const start = centre((await card.boundingBox())!);
  const end = centre((await folder.boundingBox())!);

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 6 });
  await expect(page.locator(".cp-card-ghost")).toHaveText("1 frame");
  // The tile under the pointer says so before the drop, so the target is
  // never a guess.
  await page.mouse.move(end.x, end.y, { steps: 6 });
  await expect(folder).toHaveClass(/dropping/);

  await page.mouse.up();
  await expect(page.locator(".cp-card-ghost")).toHaveCount(0);
});

test("dragging a card that is IN the selection takes the whole selection", async ({ page }) => {
  await bootFrames(page);
  const cards = page.locator(SHELF + " .cp-lib-card:not(.cp-lib-foldercard)");
  const folder = page.locator(SHELF + " .cp-lib-foldercard").first();
  const dest = await folder.getAttribute("data-drop");

  await cards.nth(0).click();
  await cards.nth(2).click({ modifiers: ["Shift"] });
  await expect(page.locator(SHELF + " .cp-lib-card.selected")).toHaveCount(3);
  const selected = await page.locator(SHELF + " .cp-lib-card.selected")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-path")));

  await dragTo(page, centre((await cards.nth(1).boundingBox())!), centre((await folder.boundingBox())!));

  await expect.poll(() => moves(page)).toEqual(selected.map((path) => ({ path, dest })));
});

test("dragging a card OUTSIDE the selection takes only that card", async ({ page }) => {
  // Finder's rule, and the same rule the batch verbs use - one press must
  // not mean two different sets depending on which control you reach for.
  await bootFrames(page);
  const cards = page.locator(SHELF + " .cp-lib-card:not(.cp-lib-foldercard)");
  const folder = page.locator(SHELF + " .cp-lib-foldercard").first();
  const dest = await folder.getAttribute("data-drop");

  await cards.nth(0).click();
  await cards.nth(1).click({ modifiers: ["Shift"] });
  const loner = cards.nth(3);
  const lonerPath = await loner.getAttribute("data-path");

  await dragTo(page, centre((await loner.boundingBox())!), centre((await folder.boundingBox())!));
  await expect.poll(() => moves(page)).toEqual([{ path: lonerPath, dest }]);
});

test("a drag that ends on open space files nothing", async ({ page }) => {
  await bootFrames(page);
  const card = page.locator(SHELF + " .cp-lib-card:not(.cp-lib-foldercard)").first();
  const pane = (await page.locator(SHELF + " .cp-web-pane").boundingBox())!;

  await dragTo(page, centre((await card.boundingBox())!),
    { x: pane.x + pane.width - 8, y: pane.y + pane.height - 8 });

  await page.waitForTimeout(150);
  expect(await moves(page)).toEqual([]);
});

test("a finished drag does not also re-select the card it started on", async ({ page }) => {
  // The browser delivers a click after the pointerup that ended the drag. If
  // it is allowed to land it lands ON the dragged card and selects it, so a
  // drop that just cleared the selection leaves one card selected again.
  //
  // Asserting the MOVE COUNT here would prove nothing: the moves are sent
  // during pointerup, before that click exists. The selection afterwards is
  // the only place the stray click shows up.
  await bootFrames(page);
  const cards = page.locator(SHELF + " .cp-lib-card:not(.cp-lib-foldercard)");
  const folder = page.locator(SHELF + " .cp-lib-foldercard").first();

  await cards.nth(0).click();
  await cards.nth(2).click({ modifiers: ["Shift"] });
  await expect(page.locator(SHELF + " .cp-lib-card.selected")).toHaveCount(3);

  await dragTo(page, centre((await cards.nth(1).boundingBox())!), centre((await folder.boundingBox())!));

  await expect.poll(async () => (await moves(page)).length).toBe(3);
  // The drop cleared the selection; nothing may have put one back.
  await expect(page.locator(SHELF + " .cp-lib-card.selected")).toHaveCount(0);
});

test("an ordinary click still selects, because a press is not yet a drag", async ({ page }) => {
  await bootFrames(page);
  const card = page.locator(SHELF + " .cp-lib-card:not(.cp-lib-foldercard)").first();
  await card.click();
  await expect(card).toHaveClass(/selected/);
  expect(await moves(page)).toEqual([]);
});

test("a click with a hand's worth of jitter is still a click", async ({ page }) => {
  // The threshold is the whole reason a card remains clickable. A perfectly
  // still click never exercises it - no pointermove is ever delivered - so
  // it has to be pressed with the couple of pixels a real hand contributes.
  await bootFrames(page);
  const card = page.locator(SHELF + " .cp-lib-card:not(.cp-lib-foldercard)").first();
  const c = centre((await card.boundingBox())!);

  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 2, c.y + 1);
  await page.mouse.move(c.x + 1, c.y + 2);
  await page.mouse.up();

  // No ghost was ever raised, and the click was allowed through.
  await expect(page.locator(".cp-card-ghost")).toHaveCount(0);
  await expect(card).toHaveClass(/selected/);
  expect(await moves(page)).toEqual([]);
});

test("a drag that starts and ends on the same card changes nothing", async ({ page }) => {
  // This is the ONLY shape in which the swallowed click is observable. A
  // drag that ends somewhere else fires its click on the nearest common
  // ancestor, so the card never sees one; a drag that returns to the card it
  // started on delivers a real click to it, and letting that through would
  // select the card the user just decided not to move.
  await bootFrames(page);
  const cards = page.locator(SHELF + " .cp-lib-card:not(.cp-lib-foldercard)");
  const target = cards.nth(1);
  const c = centre((await target.boundingBox())!);

  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  // Well past the threshold, then back where it began.
  await page.mouse.move(c.x + 40, c.y + 24, { steps: 6 });
  await expect(page.locator(".cp-card-ghost")).toBeVisible();
  await page.mouse.move(c.x, c.y, { steps: 6 });
  await page.mouse.up();

  await expect(page.locator(".cp-card-ghost")).toHaveCount(0);
  expect(await moves(page)).toEqual([]);
  await expect(page.locator(SHELF + " .cp-lib-card.selected")).toHaveCount(0);
});

test("a drag released OUTSIDE the pane ends, rather than leaving a stuck ghost", async ({ page }) => {
  // Without setPointerCapture the handlers live on the pane, so the moment
  // the pointer leaves it the moves stop arriving and the pointerup lands
  // somewhere else entirely. The drag never ends: the ghost stays painted on
  // screen and the next click is swallowed by a gesture that is still
  // notionally running.
  await bootFrames(page);
  const card = page.locator(SHELF + " .cp-lib-card:not(.cp-lib-foldercard)").first();
  const c = centre((await card.boundingBox())!);

  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x - 30, c.y - 30, { steps: 4 });
  await expect(page.locator(".cp-card-ghost")).toBeVisible();
  // Out over the nav rail, well clear of the shelf.
  await page.mouse.move(8, 8, { steps: 8 });
  await page.mouse.up();

  await expect(page.locator(".cp-card-ghost")).toHaveCount(0);
  expect(await moves(page)).toEqual([]);
});
