import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * The viewer's caption bar is always narrower than the picture.
 *
 * The dialog was a full-width column, so the bar stretched the whole way
 * across while the image sat centred and narrower - the label ran wider than
 * the thing it describes, which reads as chrome laid over the viewer rather
 * than something belonging to the frame.
 *
 * Measured at several window shapes, because the image's rendered width
 * depends on the aspect ratio AND the viewport, and the bar has to stay
 * inside it in every one of them.
 */
async function openViewer(page: Page): Promise<void> {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.permissioned", "1");
    localStorage.setItem("saucebunny.libraryRoots", JSON.stringify(["/e2e-mock/Footage"]));
  });
  // The mock mints `asset://localhost/...`, a scheme Playwright cannot route
  // and the browser cannot load - the viewer then correctly shows its "could
  // not be read" state and there is no <img> to measure. Hand back a real
  // 16:9 image instead, so the layout under test is the real one.
  await page.addInitScript(() => {
    const internals = (window as unknown as Record<string, Record<string, unknown>>).__TAURI_INTERNALS__;
    if (internals) {
      internals.convertFileSrc = () =>
        "data:image/svg+xml," +
        encodeURIComponent(
          "<svg xmlns='http://www.w3.org/2000/svg' width='1600' height='900'>" +
          "<rect width='100%' height='100%' fill='#2b6'/></svg>",
        );
    }
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+2");
  await page.getByRole("treeitem", { name: "Frames" }).first().click();
  const card = page.locator(".cp-web-view .cp-lib-card:not(.cp-lib-foldercard)").first();
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.dblclick();
  await expect(page.locator(".cp-framepv")).toBeVisible();
}

test("the caption bar stays inside the picture's edges at every window size", async ({ page }) => {
  await openViewer(page);
  await expect(page.locator(".cp-framepv-img")).toBeVisible();

  // A LONG name is the case that breaks it. With a short one the bar is
  // content-sized and narrow whatever the rules say, so a short fixture
  // proves nothing - the first version of this test passed with the cap
  // deleted entirely.
  await page.evaluate(() => {
    const name = document.querySelector(".cp-framepv-name") as HTMLElement;
    name.textContent =
      "Ex-Oil-Engineer-Turned-Climate-Whistleblower_-We-Face-COLLAPSE-_-Aaron-Bastani-Meets-Kevin-Anderson-1.mp4_00033001.jpg";
  });

  for (const [w, h] of [[1440, 900], [1180, 820], [1024, 768], [820, 700]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(60);

    const img = (await page.locator(".cp-framepv-img").boundingBox())!;
    const foot = (await page.locator(".cp-framepv-foot").boundingBox())!;

    expect(foot.width, `the bar is wider than the picture at ${w}x${h}`)
      .toBeLessThan(img.width);
    // ...and inside its edges, not merely narrower and offset.
    expect(foot.x).toBeGreaterThanOrEqual(img.x - 1);
    expect(foot.x + foot.width).toBeLessThanOrEqual(img.x + img.width + 1);
  }
});
