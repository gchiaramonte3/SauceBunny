import { test, expect } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * A list row is one line tall, whatever is in it.
 *
 * The frames shelf puts a SOURCE TITLE in the kind column, and for a web
 * clip that is the whole video title. The name cell had been clamped since
 * it was written; this one never was - so a 90-character title wrapped onto
 * six lines and took the row with it, and five frames filled the window.
 */
async function bootFramesList(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.libraryRoots", JSON.stringify(["/e2e-mock/Footage"]));
    // List view, so the table is what renders.
    localStorage.setItem("saucebunny.framesBrowser", JSON.stringify({ view: "list", sort: "date", dir: "desc" }));
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+2");
  await page.getByRole("treeitem", { name: "Frames" }).first().click();
  await expect(page.locator(".cp-lib-lrow").first()).toBeVisible({ timeout: 10_000 });
}

test("a long source title does not grow the row", async ({ page }) => {
  await bootFramesList(page);

  // A ROW cell, not `.cp-lib-lrow-kind[0]`. The header carries the same class
  // and renders FIRST, so index [0] is the header - which is not a
  // `.cp-lib-lrow` and cannot affect the heights measured below. The first
  // version of this test planted its punishing title there and proved
  // nothing at all.
  await page.evaluate(() => {
    const cell = document.querySelector(".cp-lib-lrow .cp-lib-lrow-kind") as HTMLElement;
    cell.textContent =
      "Ex-Oil-Engineer-Turned-Climate-Whistleblower_-We-Face-COLLAPSE-_-Aaron-Bastani-Meets-Kevin-Anderson-1.Mp4";
  });

  const heights = await page.locator(".cp-lib-lrow")
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  const tallest = Math.max(...heights);
  const shortest = Math.min(...heights);
  expect(tallest, `a row grew to ${tallest}px`).toBeLessThan(56);
  // Every row the same height: that is what makes a list scannable.
  expect(tallest - shortest).toBeLessThanOrEqual(1);

  // And the value is still reachable.
  const cell = page.locator(".cp-lib-lrow .cp-lib-lrow-kind").first();
  expect(await cell.evaluate((el) => getComputedStyle(el).textOverflow)).toBe("ellipsis");
  expect(await cell.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe("nowrap");
});

test("clamping the rows does not clip the header's resize handles", async ({ page }) => {
  // The header carries the same cell classes AND the column-resize handle,
  // which sits at `right: -5px; width: 10px`. An unscoped `overflow: hidden`
  // clipped half its grab area away - and had done so on the Name column
  // since that clamp was written.
  await bootFramesList(page);
  for (const col of [".cp-lib-list-head .cp-lib-lrow-name", ".cp-lib-list-head .cp-lib-lrow-kind"]) {
    const head = page.locator(col).first();
    if (await head.count() === 0) continue;
    expect(await head.evaluate((el) => getComputedStyle(el).overflow),
      `${col} clips its resize handle`).not.toBe("hidden");
    const div = head.locator(".cp-lib-coldiv");
    if (await div.count() === 0) continue;
    const box = (await div.boundingBox())!;
    // The handle is 10px wide; a clipped one measures about half that.
    expect(box.width, `${col}'s handle is clipped to ${box.width}px`).toBeGreaterThanOrEqual(9);
  }
});
