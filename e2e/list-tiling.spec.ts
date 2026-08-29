import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * List rows must TILE: each one directly under the last, no overlap, no void.
 *
 * Written to settle a report that the list view at full size was "all over
 * the place" — rows apparently printed on top of each other with a blank
 * band above them. A screenshot cannot tell a layout fault from a capture
 * artifact, so this measures the rendered geometry instead of looking at it.
 */
async function bigList(page: Page): Promise<void> {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.permissioned", "1");
    localStorage.setItem("saucebunny.libraryRoots", JSON.stringify(["/e2e-mock/Footage"]));
    // Past the browser's 300-row render cap, as the reported library was.
    localStorage.setItem("e2e.manyFiles", "400");
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+2");
  await expect(page.locator(".cp-lib-pane")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /List view/i }).click();
  await expect(page.locator(".cp-lib-list")).toBeVisible();
}

/** Row boxes in document order, header excluded (it is not a .cp-lib-lrow). */
async function rowBoxes(page: Page) {
  return page.locator(".cp-lib-list .cp-lib-lrow").evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height, left: r.left, width: r.width };
    }));
}

test("300 rows tile without overlapping or leaving a void", async ({ page }) => {
  await bigList(page);
  const boxes = await rowBoxes(page);
  // Canary: an empty measurement passes every assertion below.
  expect(boxes.length, "no rows were measured").toBeGreaterThan(100);

  const overlaps: string[] = [];
  const voids: string[] = [];
  for (let i = 1; i < boxes.length; i++) {
    const gap = boxes[i].top - boxes[i - 1].bottom;
    // A 1px separator is a border on the row, so the true gap is ~0. Allow a
    // pixel of sub-pixel rounding in either direction.
    if (gap < -1.5) overlaps.push(`row ${i}: ${gap.toFixed(1)}px into row ${i - 1}`);
    if (gap > 1.5) voids.push(`row ${i}: ${gap.toFixed(1)}px of nothing above it`);
  }
  expect(overlaps, "rows printed on top of each other").toEqual([]);
  expect(voids, "blank bands between rows").toEqual([]);
});

test("every row is one line tall and full width", async ({ page }) => {
  await bigList(page);
  const boxes = await rowBoxes(page);
  expect(boxes.length).toBeGreaterThan(100);

  // The FIRST row is legitimately 1px shorter: the separator is a border-top
  // drawn by `.cp-lib-lrow + .cp-lib-lrow`, so row one has none. Comparing
  // raw heights reports that correct behaviour as a fault, which is what the
  // first version of this test did.
  const heights = boxes.map((b) => b.height);
  const spread = Math.max(...heights) - Math.min(...heights);
  expect(spread, `rows disagree on height by ${spread.toFixed(1)}px`).toBeLessThanOrEqual(1.5);

  // A row narrower than its neighbours means the grid track collapsed, which
  // is how a "second column" of names would appear.
  const widths = [...new Set(boxes.map((b) => Math.round(b.width)))];
  expect(widths.length, `rows disagree on width: ${widths.join(", ")}`).toBe(1);
  const lefts = [...new Set(boxes.map((b) => Math.round(b.left)))];
  expect(lefts.length, `rows start at different x: ${lefts.join(", ")}`).toBe(1);
});

test("the pane scrolls vertically only", async ({ page }) => {
  await bigList(page);
  const overflow = await page.locator(".cp-lib-pane").evaluate((el) => ({
    x: el.scrollWidth - el.clientWidth,
    y: el.scrollHeight - el.clientHeight,
  }));
  expect(overflow.y, "300 rows should overflow vertically").toBeGreaterThan(0);
  expect(overflow.x, "the list must never scroll sideways").toBeLessThanOrEqual(1);
});

test("overlapping roots do not list the same file twice", async ({ page }) => {
  // Roots are picked by hand and nothing stops one sitting inside another, or
  // being added twice. "All" aggregates every root, so the inner one's files
  // appeared twice — and because rows are keyed by path, a duplicate is a
  // duplicate REACT KEY. React then warns and is free to reuse the wrong DOM
  // node for the wrong item, which is how a long list starts looking shuffled.
  const noise: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") noise.push(m.text()); });

  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.permissioned", "1");
    // A root and a folder INSIDE it. Exact duplicates are already collapsed
    // by sanitizeLibraryRoots, so seeding the same path twice proves nothing;
    // nesting is the shape that actually duplicates a file.
    localStorage.setItem("saucebunny.libraryRoots",
      JSON.stringify(["/e2e-mock/Footage", "/e2e-mock/Footage/Interviews"]));
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+2");
  await expect(page.locator(".cp-lib-pane")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /List view/i }).click();
  await expect(page.locator(".cp-lib-list")).toBeVisible();

  const names = await page.locator(".cp-lib-list .cp-lib-lrow .cp-lib-lrow-name")
    .evaluateAll((els) => els.map((e) => (e.textContent ?? "").trim()));
  expect(names.length, "no rows were measured").toBeGreaterThan(0);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  expect([...new Set(dupes)], "the same file is listed more than once").toEqual([]);

  const keyWarnings = noise.filter((t) => /same key|unique .?key/i.test(t));
  expect(keyWarnings, "React duplicate-key warnings").toEqual([]);
});
