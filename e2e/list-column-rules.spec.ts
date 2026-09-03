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

/**
 * BOTH pane types. The library list sits in `.cp-lib-pane`; frames, the web
 * shelf and review sessions sit in `.cp-web-pane`, which is a different
 * element with its own layout. Only .cp-lib-pane was made a flex column at
 * first, so the stripes and the full-height rules worked in the library and
 * nowhere else - review sessions measured 277.9px short - while this file
 * asserted the property of the library alone. A test that certifies four
 * tables by measuring the one that was fixed is worse than no test.
 */
const VIEWS = [
  { name: "library", pref: "saucebunny.libraryBrowser", cols: "saucebunny.libraryListCols", tree: null },
  { name: "frames", pref: "saucebunny.framesBrowser", cols: "saucebunny.frameListCols", tree: "Frames" },
] as const;

async function openList(page: Page, view: typeof VIEWS[number], nameWidth?: number) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(([pref, nameW, colsKey]: [string, string, string]) => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.permissioned", "1");
    localStorage.setItem("saucebunny.libraryRoots", JSON.stringify(["/e2e-mock/Footage"]));
    localStorage.setItem("e2e.manyFiles", "5");
    localStorage.setItem(pref, JSON.stringify({ view: "list" }));
    // An explicit Name width is the state that used to append a filler track,
    // and nothing covered it.
    if (nameW) localStorage.setItem(colsKey,
      JSON.stringify({ w: {}, order: null, hidden: [], name: Number(nameW) }));
  }, [view.pref, nameWidth ? String(nameWidth) : "", view.cols] as [string, string, string]);
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+2");
  if (view.tree) await page.getByRole("treeitem", { name: view.tree }).first().click();
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
    const pane = list.closest(".cp-lib-pane, .cp-web-pane") as HTMLElement;
    const pb = pane.getBoundingClientRect();
    const rb = rules.getBoundingClientRect();
    return {
      handles, ruleXs,
      shortBy: pb.bottom - parseFloat(getComputedStyle(pane).paddingBottom) - rb.bottom,
      // How far the table's trailing line stops short of where its rows end.
      // A filler track put a WHOLE COLUMN between them.
      trailingGap: (() => {
        const rowEl = list.querySelector(".cp-lib-lrow") as HTMLElement;
        const last = [...rules.children].find((sp) => parseFloat(getComputedStyle(sp).borderRightWidth) > 0);
        if (!last) return null;
        return {
          gap: rowEl.getBoundingClientRect().right - last.getBoundingClientRect().right,
          pad: parseFloat(getComputedStyle(rowEl).paddingRight),
        };
      })(),
      template: getComputedStyle(list).getPropertyValue("--lrow-cols").trim(),
    };
  });
}

for (const view of VIEWS) {
test(`${view.name}: every header divider sits exactly on a body rule`, async ({ page }) => {
  await openList(page, view);
  const m = await lines(page);
  // Canary: no dividers means every assertion below is vacuous.
  expect(m.handles.length, "no column dividers found").toBeGreaterThanOrEqual(3);
  expect(m.ruleXs.length, "no body rules found").toBeGreaterThanOrEqual(3);

  const orphans = m.handles.filter((h) => !m.ruleXs.includes(h.x))
    .map((h) => `a divider paints at ${h.x} with no body rule there (rules: ${m.ruleXs.join(", ")})`);
  expect(orphans, orphans.join("\n")).toEqual([]);
});

test(`${view.name}: the rule runs to the bottom of the pane, not just to the last row`, async ({ page }) => {
  await openList(page, view);
  const m = await lines(page);
  // "A line all the way down from the top so there's no separation." Stopping
  // at the last row is what leaves the columns looking cut off half way.
  expect(Math.abs(m.shortBy), `the column rules stop ${m.shortBy.toFixed(0)}px above the pane's floor`)
    .toBeLessThanOrEqual(1);
});

test(`${view.name}: a boundary is drawn once, so it is one weight all the way down`, async ({ page }) => {
  await openList(page, view);
  const m = await lines(page);
  expect(m.handles.length).toBeGreaterThanOrEqual(3);
  // Two lines on one pixel composite brighter than either, which is what made
  // the header stub read as a different line.
  const doubled = m.handles
    .filter((h) => h.bg !== "rgba(0, 0, 0, 0)" && h.bg !== "transparent")
    .map((h) => `the divider at ${h.x} paints ${h.bg} on top of the body rule`);
  expect(doubled, doubled.join("\n")).toEqual([]);
});

test(`${view.name}: the table's last line ends where its rows end, with Name pinned`, async ({ page }) => {
  // The reported symptom: "the position line is not where it should be". With
  // an explicit Name width nothing flexed, so a trailing filler track absorbed
  // the slack - and the row fill, the zebra stripe and the header underline all
  // ran a whole track further right than the table's own right-hand line.
  // Measured at 350px against the 28px of row padding that is correct.
  await openList(page, view, 400);
  const m = await lines(page);
  expect(m.trailingGap, "no trailing line found, so this asserted nothing").not.toBeNull();
  // Canary. Seeding the wrong table's column key leaves Name flexible, and
  // then every assertion below is about a state this test never built.
  expect(m.template, `Name was not pinned for ${view.name}; template is ${m.template}`)
    .toContain("400px");
  expect(m.template, "an explicit Name width still appends a filler track")
    .not.toContain("minmax(0, 1fr)");
  expect(m.trailingGap!.gap,
    `the table's line stops ${m.trailingGap!.gap.toFixed(0)}px short of its rows (padding is ${m.trailingGap!.pad})`)
    .toBeLessThanOrEqual(m.trailingGap!.pad + 1);
});

test(`${view.name}: a long value in the last cells is clipped, not painted over the rule`, async ({ page }) => {
  // Size and Date sit either side of the table's right-hand line and were the
  // two cells with no clamp: `white-space: nowrap` and nothing else, so a
  // value wider than its column overflowed the track and painted across the
  // rule. Measured at scrollWidth 210 in a 120px cell.
  await openList(page, view);
  const m = await page.evaluate(() => {
    const cells = [...document.querySelectorAll(".cp-lib-lrow > .cp-lib-lrow-date, .cp-lib-lrow > .cp-lib-lrow-size")] as HTMLElement[];
    if (!cells.length) return null;
    return cells.slice(0, 2).map((cell) => {
      const before = cell.getBoundingClientRect().width;
      const keep = cell.textContent;
      cell.textContent = "Wednesday 31 August 2026 at 4:43:59 PM Pacific Daylight Time";
      const after = cell.getBoundingClientRect().width;
      const cs = getComputedStyle(cell);
      cell.textContent = keep;
      return { cls: cell.className, before: Math.round(before), after: Math.round(after), overflow: cs.overflow, ellipsis: cs.textOverflow };
    });
  });
  // Canary: no such cells means this asserted nothing.
  expect(m, "no size/date cells found").not.toBeNull();
  expect(m!.length).toBeGreaterThanOrEqual(1);
  for (const c of m!) {
    expect(c.after, `${c.cls} grew from ${c.before} to ${c.after} to fit its text`).toBe(c.before);
    expect(c.overflow, `${c.cls} does not clip`).toBe("hidden");
    expect(c.ellipsis, `${c.cls} truncates with no ellipsis`).toBe("ellipsis");
  }
});
}
