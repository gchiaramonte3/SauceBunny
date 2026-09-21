import { expect, test } from "@playwright/test";

test.use({ browserName: process.env.SCENE_BROWSER === "webkit" ? "webkit" : "chromium" });

test("cut adoption is separate from chapters, precise and keyboard accessible", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 360, height: 700 });
  await page.route("**/shot-cuts-test", route => route.fulfill({ contentType: "text/html", body:
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/e2e/fixtures/shot-cuts.tsx"></script></body></html>' }));
  await page.goto("/shot-cuts-test");
  const action = page.getByRole("button", { name: "Add cut markers" });
  await expect(action).toBeVisible();
  await expect(page.locator(".cp-track-chapter")).toHaveCount(1);
  await expect(page.locator(".cp-track-cut")).toHaveCount(0);
  const countBox = (await page.locator(".cp-shot-count").boundingBox())!;
  const actionBox = (await action.boundingBox())!;
  expect(Math.abs(countBox.y + countBox.height / 2 - actionBox.y - actionBox.height / 2)).toBeLessThan(1);
  await action.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toContainText("Added 1 cut marker");
  await expect(page.locator(".cp-track-chapter")).toHaveCount(1);
  const cut = page.getByRole("button", { name: "Cut at 1.500 seconds" });
  await expect(cut).toBeVisible();
  await page.keyboard.press("Space");
  await expect(page.getByRole("status")).toContainText("already on the timeline");
  expect(await page.locator("html").getAttribute("data-notifications")).toBe("1");
  const saved = await page.evaluate(() => ({
    chapters: JSON.parse(localStorage.getItem("saucebunny.chapters.fixture-source")!),
    cuts: JSON.parse(localStorage.getItem("saucebunny.cutMarkers.fixture-source")!),
  }));
  expect(saved.chapters).toEqual([{ time: 1.500002, title: "Creator chapter", origin: "creator" }]);
  expect(saved.cuts).toEqual([{ time: 1.500002 }]);

  // Same-time chapter remains top-anchored; the cut's visible hash rises from
  // the bottom. Mouse and keyboard use exact seconds, never rounded frames.
  const geometry = await cut.evaluate(element => {
    const tick = getComputedStyle(element, "::after");
    const chapter = getComputedStyle(document.querySelector(".cp-track-chapter")!);
    return { bottom: getComputedStyle(element).bottom, tickBottom: tick.bottom,
      tickHeight: tick.height, chapterTop: chapter.top };
  });
  expect(geometry).toEqual({ bottom: "0px", tickBottom: "0px", tickHeight: "9px", chapterTop: "0px" });
  const box = (await cut.boundingBox())!;
  await cut.click({ position: { x: box.width / 2, y: box.height - 3 } });
  await expect(page.locator("html")).toHaveAttribute("data-cut-seek", "1.500002");
  expect(await page.locator("html").getAttribute("data-frame-seek")).toBeNull();
  await cut.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-cut-seek", "1.500002");
  await page.reload();
  await expect(cut).toBeVisible();
  await page.evaluate(() => document.documentElement.style.setProperty("--text-base", "14px"));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `/private/tmp/sauce-cut-markers-${process.env.SCENE_BROWSER ?? "chromium"}.png` });
  expect(errors).toEqual([]);
});
