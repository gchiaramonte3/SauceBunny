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
test("a long source title does not grow the row", async ({ page }) => {
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

  // Give one row a punishing source title, exactly the shape that broke it.
  await page.evaluate(() => {
    const cell = document.querySelectorAll(".cp-lib-lrow-kind")[0] as HTMLElement;
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
  const cell = page.locator(".cp-lib-lrow-kind").first();
  expect(await cell.evaluate((el) => getComputedStyle(el).textOverflow)).toBe("ellipsis");
  expect(await cell.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe("nowrap");
});
