import { test, expect } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * The stripes actually alternate, and the header is what makes them start in
 * the right place.
 *
 * `.cp-lib-list .cp-lib-lrow:nth-child(even)` counts every child, and child 1
 * is `.cp-lib-list-head`. If a list ever puts something else first, or drops
 * the header, every stripe in that list inverts: nothing throws, nothing
 * looks broken, and it disagrees with the list beside it.
 *
 * This reads computed backgrounds off the real rows rather than the
 * stylesheet, so it also catches the case where the rule exists but something
 * later overrides it.
 */
test("library rows alternate, starting from the header", async ({ page }) => {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.permissioned", "1");
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });

  const result = await page.evaluate(() => {
    // Build a list from the shipped classes: the harness has no seeded
    // library, and the rule under test is a stylesheet one about child order.
    const list = document.createElement("div");
    list.className = "cp-lib-list";
    list.innerHTML =
      '<div class="cp-lib-list-head"><span class="cp-lib-lrow-name">Name</span></div>' +
      Array.from({ length: 6 }, (_, i) => `<div class="cp-lib-lrow"><span class="cp-lib-lrow-name">row ${i}</span></div>`).join("");
    document.body.append(list);
    const rows = Array.from(list.querySelectorAll(".cp-lib-lrow"));
    const bgs = rows.map((r) => getComputedStyle(r).backgroundColor);
    const firstChildIsHead = list.firstElementChild?.className === "cp-lib-list-head";
    // Any row drawing a top border would mean hairlines returned.
    const borders = rows.map((r) => getComputedStyle(r).borderTopWidth);
    list.remove();
    return { bgs, firstChildIsHead, borders, count: rows.length };
  });

  expect(result.count, "no rows were built").toBe(6);
  expect(result.firstChildIsHead, "the header is not the list's first child").toBe(true);

  // Rows 1,3,5 (children 2,4,6) carry the stripe; 2,4,6 do not.
  const striped = result.bgs.filter((_, i) => i % 2 === 0);
  const plain = result.bgs.filter((_, i) => i % 2 === 1);
  expect(new Set(striped).size, `striped rows disagree: ${striped.join(", ")}`).toBe(1);
  expect(new Set(plain).size, `plain rows disagree: ${plain.join(", ")}`).toBe(1);
  expect(striped[0], "the stripe and the gap are the same colour").not.toBe(plain[0]);
  // And the stripe is a real fill, not transparent-on-transparent.
  expect(striped[0], "the striped rows are transparent").not.toMatch(/rgba\(0, 0, 0, 0\)/);

  expect(new Set(result.borders), "a per-row hairline is drawn as well as the stripe").toEqual(new Set(["0px"]));
});
