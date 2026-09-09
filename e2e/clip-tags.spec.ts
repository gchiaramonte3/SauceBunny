import { expect, test, type Page } from "@playwright/test";
import { tauriMockInit } from "./tauri-mock";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";

const path = "/e2e-mock/Footage/clip-a.mp4";
async function boot(page: Page) {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.permissioned", "1");
    localStorage.setItem("saucebunny.libraryRoots", JSON.stringify(["/e2e-mock/Footage"]));
    localStorage.setItem("saucebunny.recentSources", JSON.stringify([
      { kind: "file", value: "/e2e-mock/Footage/clip-a.mp4", title: "Local recent clip", lastOpenedAt: 2 },
      { kind: "url", value: "https://youtube.com/watch?v=2", title: "Downloaded recent clip", lastOpenedAt: 1 },
    ]));
    localStorage.setItem("e2e.finderTags", JSON.stringify({
      "/e2e-mock/Footage/clip-a.mp4": [{ name: "Red", color: 6 }, { name: "Purple", color: 1 }, { name: "Archive", color: 0 }],
      "/e2e-mock/cache/2.mp4": [{ name: "Yellow", color: 5 }],
    }));
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible();
}
const visibleClip = (page: Page, view: "grid" | "list") => page.locator(`${view === "grid" ? ".cp-lib-card" : ".cp-lib-lrow"}[data-path="${path}"]:visible`).first();

for (const width of [1100, 1680]) for (const enlarged of [false, true]) {
  test(`Finder indicators keep geometry at ${width}px / ${enlarged ? 125 : 100}% text`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 1100 ? 700 : 1020 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await boot(page);
    if (enlarged) await page.addStyleTag({ content: ":root { --text-base: 13.75px; --text-md: 15px; }" });
    await expect(page.locator('.cp-view-home .cp-lib-card[aria-description="Finder tags: Red, Purple, Archive"]')).toHaveCount(2);
    await expect(page.locator('.cp-view-home .cp-lib-card[aria-description="Finder tags: Yellow"]')).toHaveCount(1);
    await page.keyboard.press("Meta+2");
    await page.getByRole("button", { name: /Grid view/i }).click();
    const card = visibleClip(page, "grid");
    const dot = card.locator(".cp-clip-tag-dot");
    await expect(dot).toBeVisible();
    expect((await dot.boundingBox())!.width).toBe(8);
    expect((await dot.boundingBox())!.height).toBe(8);
    expect(await card.locator(".cp-lib-card-art .cp-clip-tag").count()).toBe(0);
    await expect(card).toHaveAttribute("aria-description", "Finder tags: Red, Purple, Archive");
    await page.getByRole("button", { name: /List view/i }).click();
    const row = visibleClip(page, "list");
    await row.click(); await row.focus();
    await expect(row).toHaveClass(/selected/);
    const stripe = row.locator(".cp-clip-tag-stripe");
    const rb = (await row.boundingBox())!, sb = (await stripe.boundingBox())!;
    expect(sb.x).toBeCloseTo(rb.x, 1); expect(sb.width).toBe(2);
    expect(sb.y - rb.y).toBe(4); expect(rb.height - sb.height).toBe(8);
    await expect(stripe).toHaveCSS("pointer-events", "none");
    await expect(stripe).toHaveCSS("background-color", "rgb(203, 107, 217)");
    const name = (await row.locator(".cp-lib-lrow-name").boundingBox())!;
    const head = page.locator(".cp-lib-list-head:visible .cp-lib-lrow-name").first();
    expect(name.x).toBeCloseTo((await head.boundingBox())!.x, 1);
    await page.screenshot({ path: info.outputPath("finder-list.png") });
  });
}

test("native write route, external refresh and rollback keep grid and Home consistent", async ({ page }) => {
  await boot(page); await page.keyboard.press("Meta+2");
  await page.getByRole("button", { name: /Grid view/i }).click();
  const card = visibleClip(page, "grid");
  await card.click({ button: "right" });
  await page.getByRole("button", { name: "Blue", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(card).toHaveAttribute("aria-description", "Finder tags: Red, Purple, Archive, Blue");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("e2e.finderTags")!));
  expect(saved[path].at(-1)).toEqual({ name: "Blue", color: 4 });
  await expect(page.locator('.cp-view-home .cp-lib-card[aria-description="Finder tags: Red, Purple, Archive, Blue"]')).toHaveCount(2);
  await page.evaluate(() => {
    localStorage.setItem("e2e.finderTags", JSON.stringify({ "/e2e-mock/Footage/clip-a.mp4": [{ name: "Green", color: 2 }] }));
    localStorage.setItem("e2e.refuseTagWrite", "1");
    window.dispatchEvent(new Event("focus"));
  });
  await expect(card).toHaveAttribute("aria-description", "Finder tags: Green");
  await card.press("Shift+F10");
  await page.getByRole("button", { name: "Orange", exact: true }).click();
  await expect(card).toHaveAttribute("aria-description", "Finder tags: Green");
});

test("downloaded web grids and lists use the file tag; remote-only entries stay blank", async ({ page }) => {
  await boot(page); await page.keyboard.press("Meta+2");
  await page.getByRole("treeitem", { name: "From the web", exact: true }).click();
  const grid = page.locator('.cp-lib-card[data-path="https://youtube.com/watch?v=2"]:visible');
  await expect(grid.locator(".cp-clip-tag-dot")).toBeVisible();
  await expect(grid).toHaveAttribute("aria-description", "Finder tags: Yellow");
  await page.getByRole("button", { name: /List view/i }).click();
  const rows = page.locator(".cp-web-lrow-wrap:visible .cp-lib-lrow");
  await expect(rows).toHaveCount(3);
  await expect(rows.locator(".cp-clip-tag-stripe")).toHaveCount(1);
});
