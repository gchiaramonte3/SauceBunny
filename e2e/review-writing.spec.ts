import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

async function bootReview(page: Page, enlarged: boolean) {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.permissioned", "1");
    localStorage.setItem("saucebunny.review.author", JSON.stringify("Editor"));
    localStorage.setItem("saucebunny.queueDrawerActiveTab", "review");
    localStorage.setItem("saucebunny.queueDrawerWidth", "320");
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible();
  await page.keyboard.press("Meta+3");
  await page.locator("input[placeholder^='Paste a video URL']").fill("https://youtube.com/watch?v=aaaa");
  await page.getByRole("button", { name: /^Fetch/ }).click();
  await expect(page.locator(".cp-timeline-hint")).toContainText("No marks set");
  await page.locator(".cp-nav-item").filter({ hasText: "Review" }).click();
  await expect(page.locator(".cp-review-composer")).toBeVisible();
  if (enlarged) await page.evaluate(() => {
    const root = document.documentElement, css = getComputedStyle(root);
    for (const name of ["--text-sm", "--text-base", "--text-md", "--text-lg"])
      root.style.setProperty(name, `${parseFloat(css.getPropertyValue(name)) * 1.25}px`);
  });
  for (const text of ["First paragraph\nSecond paragraph", "Another note"]) {
    const composer = page.getByRole("textbox", { name: "Comment", exact: true });
    await composer.fill(text);
    await composer.press("Enter");
  }
  await expect(page.locator(".cp-review-comment")).toHaveCount(2);
}

for (const enlarged of [false, true]) {
  test(`Review editing preserves paragraphs, fits and returns focus at ${enlarged ? 125 : 100}% text`, async ({ page }, info) => {
    await bootReview(page, enlarged);
    const row = page.locator(".cp-review-comment").first();
    const editButton = row.getByRole("button", { name: "Edit", exact: true });
    await editButton.click();
    const editor = row.getByRole("textbox", { name: "Edit comment" });
    await expect(editor).toHaveValue("First paragraph\nSecond paragraph");
    await editor.evaluate(element => {
      const field = element as HTMLTextAreaElement;
      field.setSelectionRange(field.value.length, field.value.length);
    });
    await editor.press("Shift+Enter");
    await editor.pressSequentially("Third paragraph");
    await row.getByRole("button", { name: "Save", exact: true }).click();
    await expect(row.locator(".cp-review-body")).toHaveText("First paragraph\nSecond paragraph\nThird paragraph");
    await expect(editButton).toBeFocused();
    await editButton.click();
    await editor.fill("Do not save this");
    await row.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(row.locator(".cp-review-body")).toContainText("Third paragraph");
    await expect(editButton).toBeFocused();
    await editButton.click();
    const panel = (await page.locator(".cp-queue-drawer.room").boundingBox())!;
    for (const control of await row.locator("textarea, .cp-review-writing-actions button").all()) {
      if (!await control.isVisible()) continue;
      const bounds = (await control.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(panel.x);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(panel.x + panel.width);
    }
    await page.screenshot({ path: info.outputPath("review-editing.png") });
  });

  test(`Review reply drafts survive thread navigation at ${enlarged ? 125 : 100}% text`, async ({ page }) => {
    await bootReview(page, enlarged);
    const rows = page.locator(".cp-review-comment");
    await rows.nth(0).getByRole("button", { name: "Reply", exact: true }).click();
    await page.getByRole("textbox", { name: "Reply to Editor" }).fill("Draft A\nSecond line");
    await rows.nth(1).getByRole("button", { name: "Reply", exact: true }).click();
    const input = page.getByRole("textbox", { name: "Reply to Editor" });
    await input.fill("Draft B");
    await input.press("Escape");
    await expect(rows.nth(1).getByRole("button", { name: "Resume reply" })).toBeFocused();
    await rows.nth(0).getByRole("button", { name: "Resume reply" }).click();
    await expect(input).toHaveValue("Draft A\nSecond line");
    await rows.nth(0).getByRole("button", { name: "Post", exact: true }).click();
    await expect(rows.nth(0).locator(".cp-review-reply .cp-review-body")).toHaveText("Draft A\nSecond line");
    await rows.nth(1).getByRole("button", { name: "Resume reply" }).click();
    await expect(input).toHaveValue("Draft B");
    await rows.nth(1).getByRole("button", { name: "Discard draft" }).click();
    await rows.nth(1).getByRole("button", { name: "Reply", exact: true }).click();
    await expect(input).toBeEmpty();
  });
}

test("Review search remains active while selecting results and sorting", async ({ page }) => {
  await bootReview(page, false);
  const searchButton = page.getByRole("button", { name: "Search comments", exact: true });
  await searchButton.click();
  const search = page.getByRole("textbox", { name: "Search comments" });
  await search.fill("Another");
  await expect(page.locator(".cp-review-comment")).toHaveCount(1);
  await page.locator(".cp-review-comment .cp-review-tc").click();
  await expect(search).toHaveValue("Another");
  await page.getByRole("combobox", { name: "Sort comments" }).selectOption("newest");
  await expect(page.locator(".cp-review-comment")).toHaveCount(1);
  await expect(search).toHaveValue("Another");
  await search.press("Escape");
  await expect(searchButton).toBeFocused();
  await expect(page.locator(".cp-review-comment")).toHaveCount(2);
});
