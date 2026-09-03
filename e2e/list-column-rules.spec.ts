import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * A column boundary is ONE line, at one weight, from the top of the header to
 * the bottom of the pane.
 *
 * It is drawn by two things: `.cp-lib-coldiv` (the resize handle, a short
 * segment inside the header) and `.cp-lib-colrules` (a continuous full-height
 * overlay). They are on the same pixel - that part was always right - but the
 * handle painted at `--line-2` while the rule paints at `--line-1`, so a
 * boundary rendered as a bright stub sitting on a faint line with a visible
 * step at the header's edge.
 *
 * Reported twice: "I would like to see a line go all the way down from the top
 * so there's no separation for the columns... that line has to be persistent
 * throughout all the applications where this kind of UI of list view is
 * present", and later "the column line is fucking up with the held column".
 *
 * Matching the weight was not enough - two 10% whites on one pixel composite
 * to about 19%, measured at luminance 56 against the rule's 34. The handle
 * now paints nothing at rest, since the rule is already there, and announces
 * itself on hover, focus and drag instead.
 */

async function libraryList(page: Page) {
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
}

/** Where each mechanism actually paints, in viewport x. */
async function lines(page: Page) {
  return page.evaluate(() => {
    const list = document.querySelector(".cp-lib-list") as HTMLElement;
    const head = list.querySelector(".cp-lib-list-head") as HTMLElement;
    const rules = list.querySelector(".cp-lib-colrules") as HTMLElement;
    const r2 = (n: number) => Math.round(n * 2) / 2;

    // The handle's visible line is its ::after, inset by `left`. Measuring the
    // handle's own BOX instead reports a position 4px off and invents a
    // misalignment that is not there.
    const handles = [...head.querySelectorAll(".cp-lib-coldiv")].map((d) => {
      const box = d.getBoundingClientRect();
      const after = getComputedStyle(d, "::after");
      return { x: r2(box.left + parseFloat(after.left)), bg: after.backgroundColor };
    });

    const ruleXs: number[] = [];
    for (const span of [...rules.children]) {
      const cs = getComputedStyle(span);
      const b = span.getBoundingClientRect();
      if (parseFloat(cs.borderLeftWidth) > 0) ruleXs.push(r2(b.left));
      if (parseFloat(cs.borderRightWidth) > 0) ruleXs.push(r2(b.right - 1));
    }
    // Measured against the PANE, not the list. `.cp-lib-colrules` is
    // `inset: 0` on the list, so "does the overlay match the list" is true by
    // construction and cannot fail - the first version of this asserted
    // exactly that and passed under a mutation that shortened the list.
    const pane = list.closest(".cp-lib-pane") as HTMLElement;
    const pb = pane.getBoundingClientRect();
    const rb = rules.getBoundingClientRect();
    return {
      handles, ruleXs,
      shortBy: pb.bottom - parseFloat(getComputedStyle(pane).paddingBottom) - rb.bottom,
    };
  });
}

test("every header divider sits exactly on a body rule", async ({ page }) => {
  await libraryList(page);
  const m = await lines(page);
  // Canary: no dividers means every assertion below is vacuous.
  expect(m.handles.length, "no column dividers found").toBeGreaterThanOrEqual(3);
  expect(m.ruleXs.length, "no body rules found").toBeGreaterThanOrEqual(3);

  const orphans = m.handles.filter((h) => !m.ruleXs.includes(h.x))
    .map((h) => `a divider paints at ${h.x} with no body rule there (rules: ${m.ruleXs.join(", ")})`);
  expect(orphans, orphans.join("\n")).toEqual([]);
});

test("the rule runs to the bottom of the pane, not just to the last row", async ({ page }) => {
  await libraryList(page);
  const m = await lines(page);
  // "A line all the way down from the top so there's no separation." Stopping
  // at the last row is what leaves the columns looking cut off half way.
  expect(Math.abs(m.shortBy), `the column rules stop ${m.shortBy.toFixed(0)}px above the pane's floor`)
    .toBeLessThanOrEqual(1);
});

test("a boundary is drawn once, so it is one weight all the way down", async ({ page }) => {
  await libraryList(page);
  const m = await lines(page);
  expect(m.handles.length).toBeGreaterThanOrEqual(3);
  // Two lines on one pixel composite brighter than either, which is what made
  // the header stub read as a different line.
  const doubled = m.handles
    .filter((h) => h.bg !== "rgba(0, 0, 0, 0)" && h.bg !== "transparent")
    .map((h) => `the divider at ${h.x} paints ${h.bg} on top of the body rule`);
  expect(doubled, doubled.join("\n")).toEqual([]);
});
