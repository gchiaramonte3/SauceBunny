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

/**
 * The stripes carry on BELOW the last row, the way Finder's do.
 *
 * Reported as "I like the checkerboarding throughout the library even when
 * clips aren't present, see the reference of Finder". A table that stops
 * striping where its data stops leaves a hard edge across the pane.
 *
 * The phase is the part that can silently be wrong, so it is asserted against
 * the same rule the four lists compute it from rather than hardcoded here.
 */
test("the zebra fills the empty space under the last row", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.permissioned", "1");
    localStorage.setItem("saucebunny.libraryRoots", JSON.stringify(["/e2e-mock/Footage"]));
    localStorage.setItem("e2e.manyFiles", "5");
    localStorage.setItem("saucebunny.libraryBrowser", JSON.stringify({ view: "list" }));
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+2");
  await expect(page.locator(".cp-lib-lrow").first()).toBeVisible({ timeout: 15_000 });

  const m = await page.evaluate(() => {
    const list = document.querySelector(".cp-lib-list") as HTMLElement;
    const pane = list.closest(".cp-lib-pane") as HTMLElement;
    const rows = [...list.querySelectorAll(".cp-lib-lrow")] as HTMLElement[];
    const after = getComputedStyle(list, "::after");
    const paneStyle = getComputedStyle(pane);
    return {
      rowCount: rows.length,
      rowHeights: [...new Set(rows.map((r) => +r.getBoundingClientRect().height.toFixed(2)))],
      declaredRowH: getComputedStyle(list).getPropertyValue("--lrow-h").trim(),
      fillerH: parseFloat(after.height),
      gradient: after.backgroundImage,
      phase: list.style.getPropertyValue("--lrow-fill-phase"),
      slack: pane.getBoundingClientRect().bottom
        - list.getBoundingClientRect().bottom - parseFloat(paneStyle.paddingBottom),
    };
  });

  // Canary: with no rows and no leftover height there is nothing to get wrong.
  expect(m.rowCount, "no rows were rendered").toBeGreaterThan(1);

  // The period and the row height must be the SAME number, or the filler
  // drifts a whole row out of phase over a long list.
  expect(m.rowHeights, "rows are not a single exact height").toHaveLength(1);
  expect(`${m.rowHeights[0]}px`).toBe(m.declaredRowH);
  expect(m.gradient, "the filler draws no stripes").toContain("gradient");
  expect(m.gradient).toContain(m.declaredRowH);

  // It reaches the bottom of the pane: that is what "fills" means.
  expect(m.fillerH, "the filler has no height, so nothing is painted").toBeGreaterThan(100);
  expect(Math.abs(m.slack), `the list stops ${m.slack.toFixed(0)}px short of the pane`)
    .toBeLessThanOrEqual(1);

  // Phase: an even row count ends on a plain row, so the filler starts striped.
  expect(m.phase).toBe(m.rowCount % 2 === 0 ? "1" : "0");
});
