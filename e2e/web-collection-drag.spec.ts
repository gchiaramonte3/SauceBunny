import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * Dragging cached clips into a collection.
 *
 * The frames shelf files a still into a FOLDER, which is a real directory
 * and therefore a move. A web collection is a TAG: a clip may sit in several
 * at once and its cached file never goes anywhere. So the same gesture has
 * to mean "add", and dropping a clip into a second collection must not take
 * it out of the first - which is the promise the card's + menu already makes
 * with checkboxes, and the reason this is not modelled as a move.
 */
const SHELF = ".cp-web-view";
const LIB = "/e2e-mock/Documents/Sauce Bunny";

async function bootWeb(page: Page): Promise<void> {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript((lib: string) => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.libraryRoots", JSON.stringify(["/e2e-mock/Footage"]));
    // Two collections on disk, so a drop has somewhere to land and a second
    // somewhere to prove membership is additive.
    localStorage.setItem("e2e.files", JSON.stringify({
      [`${lib}/Collections/collections.json`]: JSON.stringify({
        version: 1,
        collections: [
          { id: "col-keep", name: "Keepers", urls: [], created_at: 1 },
          { id: "col-later", name: "Later", urls: [], created_at: 2 },
        ],
      }),
    }));
  }, LIB);
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+2");
  await page.getByRole("treeitem", { name: "From the web" }).first().click();
  await expect(page.locator(SHELF + " .cp-web-shelf.collection").first())
    .toBeVisible({ timeout: 10_000 });
}

const centre = (b: { x: number; y: number; width: number; height: number }) =>
  ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/** The clip cards NOT already filed into a collection. */
const loose = (page: Page) =>
  page.locator(SHELF + " .cp-web-shelf:not(.collection) .cp-lib-card");

async function dragTo(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}

const shelfFor = (page: Page, name: string) =>
  page.locator(SHELF + " .cp-web-shelf.collection").filter({ hasText: name });

test("dropping a clip on a collection files it there", async ({ page }) => {
  await bootWeb(page);
  const keepers = shelfFor(page, "Keepers");
  const card = loose(page).first();
  const title = await card.locator(".cp-lib-card-title").textContent();

  await dragTo(page, centre((await card.boundingBox())!), centre((await keepers.boundingBox())!));

  // It now appears under the collection...
  await expect(keepers.locator(".cp-lib-card")).toHaveCount(1);
  await expect(keepers.locator(".cp-lib-card-title")).toHaveText(title!);
  // ...and has left the site shelf, because showing it in both places would
  // make the fold read as a search result rather than an organisation.
  await expect(loose(page).locator(`text=${title}`)).toHaveCount(0);
});

test("the collection highlights before the drop, so the target is never a guess", async ({ page }) => {
  await bootWeb(page);
  const keepers = shelfFor(page, "Keepers");
  const card = loose(page).first();
  const start = centre((await card.boundingBox())!);
  const end = centre((await keepers.boundingBox())!);

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 6 });
  await expect(page.locator(".cp-card-ghost")).toHaveText("1 clip");
  await page.mouse.move(end.x, end.y, { steps: 6 });
  await expect(keepers).toHaveClass(/dropping/);
  await page.mouse.up();
  await expect(page.locator(".cp-card-ghost")).toHaveCount(0);
});

test("a clip can belong to two collections at once", async ({ page }) => {
  // The difference between a tag and a directory, stated as a test. If the
  // drop were modelled as a move this would empty Keepers.
  await bootWeb(page);
  const card = loose(page).first();
  await dragTo(page, centre((await card.boundingBox())!),
    centre((await shelfFor(page, "Keepers").boundingBox())!));
  await expect(shelfFor(page, "Keepers").locator(".cp-lib-card")).toHaveCount(1);

  const filed = shelfFor(page, "Keepers").locator(".cp-lib-card").first();
  await dragTo(page, centre((await filed.boundingBox())!),
    centre((await shelfFor(page, "Later").boundingBox())!));

  await expect(shelfFor(page, "Later").locator(".cp-lib-card")).toHaveCount(1);
  await expect(shelfFor(page, "Keepers").locator(".cp-lib-card")).toHaveCount(1);
});

test("a selection drags into a collection whole", async ({ page }) => {
  await bootWeb(page);
  const cards = loose(page);
  await cards.nth(0).click();
  await cards.nth(1).click({ modifiers: ["Shift"] });
  await expect(page.locator(SHELF + " .cp-lib-card.selected")).toHaveCount(2);

  await dragTo(page, centre((await cards.nth(0).boundingBox())!),
    centre((await shelfFor(page, "Keepers").boundingBox())!));

  await expect(shelfFor(page, "Keepers").locator(".cp-lib-card")).toHaveCount(2);
});
