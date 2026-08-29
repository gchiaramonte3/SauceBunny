import { test, expect } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * A card is one object.
 *
 * The art used to be a rounded tile on a transparent card, with the title
 * floating below it on the page background. A shelf then read as a row of
 * pictures with unrelated text between them - and on a dark frame it was
 * genuinely unclear which label belonged to which clip.
 *
 * Geometry is the only place this is observable, so it is measured here.
 */
test("the label is attached to the picture, with no gap and a shared surface", async ({ page }) => {
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
  await expect(page.locator(".cp-view-library")).toBeVisible();
  const card = page.locator(".cp-view-library .cp-lib-card:not(.cp-lib-foldercard)").first();
  await expect(card).toBeVisible({ timeout: 10_000 });

  const art = (await card.locator(".cp-lib-card-art").boundingBox())!;
  const title = (await card.locator(".cp-lib-card-title").boundingBox())!;
  const box = (await card.boundingBox())!;

  // The label starts where the picture ends. A gap here is the old look.
  expect(title.y - (art.y + art.height)).toBeLessThanOrEqual(1);
  // Both are inside one card, and the card is what has edges.
  expect(art.y).toBeGreaterThanOrEqual(box.y - 1);
  expect(title.x).toBeGreaterThan(box.x);

  // The card carries a surface of its own, rather than being a transparent
  // wrapper around a picture.
  const bg = await card.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).not.toBe("rgba(0, 0, 0, 0)");
  // ...and the rounding lives on the card, so the two halves cannot show a
  // notch between them.
  const artRadius = await card.locator(".cp-lib-card-art")
    .evaluate((el) => getComputedStyle(el).borderBottomLeftRadius);
  expect(artRadius).toBe("0px");
});
