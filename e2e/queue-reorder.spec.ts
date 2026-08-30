import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * Reordering the export queue.
 *
 * The order here is load-bearing and was unsettable by any means: the export
 * walks the queued clips in array order one at a time, "Rename all" numbers
 * them base-1..N in that same order, and each row paints its position on
 * screen. Three promises about an order with nothing to change it.
 *
 * The index arithmetic is unit-tested in src/lib/reorder.test.ts. What can
 * only be tested here is the part made of real geometry: that dragging a row
 * past another row's MIDPOINT is what moves it, and that the number painted
 * on each row follows.
 */
const ROWS = ".cp-queue-item";

async function bootQueue(page: Page): Promise<void> {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.permissioned", "1");
    const clip = (id: string, filename: string) => ({
      id, filename, fps: 25, inFrames: 0, outFrames: 250,
      source: { kind: "file", path: `/e2e-mock/${id}.mp4` },
      status: "queued",
    });
    // Seed ONLY on a fresh profile. addInitScript re-runs on every
    // navigation, so seeding unconditionally would overwrite the reordered
    // queue on reload and the persistence test would be testing the seed.
    if (localStorage.getItem("saucebunny.clipQueue") === null) {
      localStorage.setItem("saucebunny.clipQueue", JSON.stringify([
        clip("a", "alpha"), clip("b", "bravo"), clip("c", "charlie"),
      ]));
    }
    localStorage.setItem("saucebunny.queueDrawerActiveTab", "queue");
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+3");
  await expect(page.locator(".cp-queue-drawer.open")).toBeVisible();
  await expect(page.locator(ROWS)).toHaveCount(3);
}

/** The queue as displayed: position number + name, in order. */
const shown = (page: Page) => page.locator(ROWS).evaluateAll((els) => els.map((e) => ({
  num: e.querySelector(".cp-queue-num")?.textContent?.trim(),
  name: e.textContent?.match(/alpha|bravo|charlie/)?.[0],
})));

/** Drag row `from` so the pointer ends at `y`. */
async function dragRow(page: Page, from: number, y: number) {
  const box = (await page.locator(ROWS).nth(from).boundingBox())!;
  const handle = { x: box.x + 12, y: box.y + box.height / 2 };
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(handle.x, (handle.y + y) / 2, { steps: 5 });
  await page.mouse.move(handle.x, y, { steps: 5 });
  await page.mouse.up();
}

test("the queue starts in its seeded order, numbered from one", async ({ page }) => {
  await bootQueue(page);
  expect(await shown(page)).toEqual([
    { num: "1", name: "alpha" },
    { num: "2", name: "bravo" },
    { num: "3", name: "charlie" },
  ]);
});

test("dragging a row past the last midpoint moves it to the end", async ({ page }) => {
  await bootQueue(page);
  const last = (await page.locator(ROWS).nth(2).boundingBox())!;
  // Below the last row's midpoint = after everything.
  await dragRow(page, 0, last.y + last.height - 2);

  await expect.poll(() => shown(page)).toEqual([
    { num: "1", name: "bravo" },
    { num: "2", name: "charlie" },
    { num: "3", name: "alpha" },
  ]);
});

test("dragging up puts the row before the one it passed", async ({ page }) => {
  await bootQueue(page);
  const first = (await page.locator(ROWS).nth(0).boundingBox())!;
  await dragRow(page, 2, first.y + 2);

  await expect.poll(() => shown(page)).toEqual([
    { num: "1", name: "charlie" },
    { num: "2", name: "alpha" },
    { num: "3", name: "bravo" },
  ]);
});

test("a drag that does not cross a midpoint changes nothing", async ({ page }) => {
  // The midpoint rule, from the other side: a row nudged within its own half
  // has not passed anything, so it stays put.
  await bootQueue(page);
  const box = (await page.locator(ROWS).nth(1).boundingBox())!;
  await dragRow(page, 1, box.y + box.height / 2 + 3);
  await page.waitForTimeout(150);
  expect(await shown(page)).toEqual([
    { num: "1", name: "alpha" },
    { num: "2", name: "bravo" },
    { num: "3", name: "charlie" },
  ]);
});

test("the new order survives a reload, because it is the persisted order", async ({ page }) => {
  await bootQueue(page);
  const last = (await page.locator(ROWS).nth(2).boundingBox())!;
  await dragRow(page, 0, last.y + last.height - 2);
  await expect.poll(async () => (await shown(page))[0].name).toBe("bravo");

  await page.reload();
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+3");
  await expect(page.locator(ROWS)).toHaveCount(3);
  expect((await shown(page)).map((r) => r.name)).toEqual(["bravo", "charlie", "alpha"]);
});

test("Move earlier / Move later do the same thing without a pointer", async ({ page }) => {
  // A reorder that exists only as a drag is unreachable by keyboard, and this
  // list decides what the export actually does.
  await bootQueue(page);
  await page.getByRole("button", { name: /Move charlie earlier/ }).click();
  await expect.poll(async () => (await shown(page)).map((r) => r.name))
    .toEqual(["alpha", "charlie", "bravo"]);

  await page.getByRole("button", { name: /Move alpha later/ }).click();
  await expect.poll(async () => (await shown(page)).map((r) => r.name))
    .toEqual(["charlie", "alpha", "bravo"]);
});

test("the ends are disabled rather than silently doing nothing", async ({ page }) => {
  await bootQueue(page);
  await expect(page.getByRole("button", { name: /Move alpha earlier/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: /Move charlie later/ })).toBeDisabled();
});

test("a sloppy press on Move later still moves it, and does not become a drag", async ({ page }) => {
  // The guard that keeps a row from swallowing its own controls. A still
  // click never exercises it - no pointermove, so the row never captures the
  // pointer - which is why the first version of these tests survived deleting
  // the guard entirely. A real hand moves while it clicks.
  await bootQueue(page);
  const btn = page.getByRole("button", { name: /Move alpha later/ });
  const b = (await btn.boundingBox())!;
  const c = { x: b.x + b.width / 2, y: b.y + b.height / 2 };

  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  // Well past the 6px threshold, still over the button.
  await page.mouse.move(c.x, c.y + 9, { steps: 3 });
  await page.mouse.move(c.x, c.y, { steps: 3 });
  await page.mouse.up();

  await expect.poll(async () => (await shown(page)).map((r) => r.name))
    .toEqual(["bravo", "alpha", "charlie"]);
});

test("a wobble on a row is not a drag", async ({ page }) => {
  // The threshold itself. Below it the row must not enter the dragging state
  // at all - no dimmed row, no captured pointer, no drop indicator.
  await bootQueue(page);
  const box = (await page.locator(ROWS).nth(1).boundingBox())!;
  const handle = { x: box.x + 12, y: box.y + box.height / 2 };

  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(handle.x, handle.y + 3, { steps: 2 });
  await expect(page.locator(ROWS + ".dragging")).toHaveCount(0);
  await page.mouse.up();

  expect((await shown(page)).map((r) => r.name)).toEqual(["alpha", "bravo", "charlie"]);
});

/**
 * A QUEUE ROW COMES BACK.
 *
 * use-clip-queue's own comment on handleQueueRetry calls a row "a range
 * somebody marked by hand ... the one thing in the workspace that cannot be
 * recreated by pressing a button again". Removing one was a single click on a
 * trash icon, with no confirm and no way back: you re-found the moment and
 * re-marked in and out.
 *
 * The data model needed nothing. QueuedClip is immutable and id-keyed, so the
 * removed object plus its index is a complete inverse.
 */
test("cmd+Z brings back a removed queue row, in its place", async ({ page }) => {
  await bootQueue(page);
  expect(await shown(page)).toEqual([
    { num: "1", name: "alpha" }, { num: "2", name: "bravo" }, { num: "3", name: "charlie" },
  ]);

  // Remove the MIDDLE row, so "restored at its index" is distinguishable from
  // "appended" - which is a different plan, not the same queue.
  await page.locator(ROWS).nth(1).locator('button[aria-label*="Remove" i], button[title*="Remove" i]').first().click();
  await expect(page.locator(ROWS)).toHaveCount(2);

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Meta+z");

  await expect(page.locator(ROWS)).toHaveCount(3);
  expect(await shown(page), "bravo must return to position 2, not to the end").toEqual([
    { num: "1", name: "alpha" }, { num: "2", name: "bravo" }, { num: "3", name: "charlie" },
  ]);
});
