import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * Looking at what someone else drew is not a decision to throw away what you
 * were drawing.
 *
 * Clicking a comment's "✎ drawing" badge leaves draw mode to pin that
 * annotation on the frame. It used to null the in-progress draft and wipe its
 * undo history in the same handler - a half-finished markup gone with no undo
 * - and because the draft undo stack is only routed while draw mode is live,
 * the ⌘Z that followed fell through to the APP stack and deleted the very
 * comment being looked at.
 */
async function bootReview(page: Page): Promise<void> {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.review.author", JSON.stringify("Nika"));
    localStorage.setItem("e2e.files", "{}");
    localStorage.setItem("saucebunny.queueDrawerActiveTab", "review");
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+3");
  await page.locator("input[placeholder^='Paste a video URL']").fill("https://youtube.com/watch?v=aaaa");
  await page.getByRole("button", { name: /^Fetch/ }).click();
  await expect(page.locator(".cp-timeline-hint")).toContainText("No marks set", { timeout: 10_000 });
  await page.locator(".cp-pane-tabs button, [role=tab]").filter({ hasText: "Review" }).first().click();
  await expect(page.locator(".cp-review")).toBeVisible({ timeout: 10_000 });
}

const penBtn = (page: Page) => page.getByRole("button", { name: /Draw on the frame|Stop drawing/ });

/** How much ink is on the annotation canvas. The draft, made observable. */
const inkedPixels = (page: Page) => page.evaluate(() => {
  const c = document.querySelector(".cp-annot-canvas") as HTMLCanvasElement | null;
  if (!c) return -1;
  const ctx = c.getContext("2d");
  if (!ctx) return -1;
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 8) n++;
  return n;
});

/** Draw one stroke across the middle of the frame. */
async function drawStroke(page: Page, dy = 0) {
  const box = (await page.locator(".cp-annot-canvas").boundingBox())!;
  const y = box.y + box.height / 2 + dy;
  await page.mouse.move(box.x + box.width * 0.3, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, y + 12, { steps: 8 });
  await page.mouse.move(box.x + box.width * 0.7, y, { steps: 8 });
  await page.mouse.up();
}

/** Draw a stroke and post it as a comment, so it becomes a saved annotation. */
async function postDrawnComment(page: Page, body: string) {
  await penBtn(page).click();
  await expect(page.locator(".cp-annot.drawing")).toBeVisible();
  await drawStroke(page);
  await expect.poll(() => inkedPixels(page)).toBeGreaterThan(0);
  const field = page.getByRole("textbox", { name: /Describe the drawing|Comment/ });
  await field.fill(body);
  await field.press("Enter");
  await expect(page.locator(".cp-review-drawbadge").filter({ hasText: "drawing" }).first())
    .toBeVisible({ timeout: 10_000 });
}

test("peeking at a saved drawing keeps the one you are making", async ({ page }) => {
  await bootReview(page);
  await postDrawnComment(page, "look at this edge");

  // A NEW drawing, half-made.
  await penBtn(page).click();
  await expect(page.locator(".cp-annot.drawing")).toBeVisible();
  await drawStroke(page, -40);
  const mine = await inkedPixels(page);
  expect(mine, "the new stroke did not draw").toBeGreaterThan(0);

  // Peek at the saved one. Draw mode ends, which is correct - the frame is
  // showing someone else's annotation now.
  await page.locator(".cp-review-drawbadge").first().click();
  await expect(page.locator(".cp-annot.drawing")).toHaveCount(0);

  // Back to the pen: the half-made drawing is still there.
  await penBtn(page).click();
  await expect(page.locator(".cp-annot.drawing")).toBeVisible();
  await expect.poll(() => inkedPixels(page), { timeout: 5000 })
    .toBeGreaterThan(0);
});

test("undo during a peek brings the drawing back instead of deleting the comment", async ({ page }) => {
  await bootReview(page);
  await postDrawnComment(page, "look at this edge");
  const comments = page.locator(".cp-review-comment");
  await expect(comments).toHaveCount(1);

  await penBtn(page).click();
  await drawStroke(page, -40);
  await expect.poll(() => inkedPixels(page)).toBeGreaterThan(0);

  await page.locator(".cp-review-drawbadge").first().click();
  await expect(page.locator(".cp-annot.drawing")).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+z");
  // The comment survives - it used to be what ⌘Z destroyed - and the drawing
  // is back on the frame.
  await expect(comments).toHaveCount(1);
  await expect(page.locator(".cp-annot.drawing")).toBeVisible();
  await expect.poll(() => inkedPixels(page)).toBeGreaterThan(0);
});

test("putting the pen down is still a decision to discard", async ({ page }) => {
  // The stash must not resurrect a draft the user deliberately abandoned.
  await bootReview(page);
  await penBtn(page).click();
  await drawStroke(page);
  await expect.poll(() => inkedPixels(page)).toBeGreaterThan(0);

  await penBtn(page).click();   // pen off = discard
  await penBtn(page).click();   // and on again
  await expect(page.locator(".cp-annot.drawing")).toBeVisible();
  expect(await inkedPixels(page)).toBe(0);
});
