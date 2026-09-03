import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Every list view draws its column lines, and they land on the same tracks.
 *
 * Two separate ways this broke while being built, both of them invisible to
 * tsc and to every other test:
 *
 * 1. A table renders the header (with its resizable dividers) and rows, and
 *    simply never renders the rules - so that one table reads as a labelled
 *    strip on top of an undivided field while its siblings have columns.
 * 2. The rules ARE rendered but sit on different tracks from the rows. The
 *    gutter rule gave the header and the rows `padding-right: 40px` and left
 *    the overlay at var(--s-2), which put every body line 32px to the right
 *    of the header divider it belongs to. It looks like a rendering bug and
 *    is a stylesheet one.
 *
 * The second is pinned by requiring the three boxes to be listed in ONE rule
 * rather than by re-measuring: if a future gutter applies to only some of
 * them, the shape of this selector is where it will show.
 */

const COMPONENTS = join(__dirname, "../components");
const CSS = join(__dirname, "../styles/library.css");

describe("list-rules-contract", () => {
  const files = readdirSync(COMPONENTS)
    .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
    .map((f) => [f, readFileSync(join(COMPONENTS, f), "utf8")] as const);

  const tables = files.filter(([, t]) => t.includes('className="cp-lib-list-head'));

  it("finds the tables it is policing", () => {
    // Without this the filters below pass by matching nothing at all.
    expect(files.length, "no components scanned - the walk broke").toBeGreaterThan(50);
    expect(
      tables.map(([f]) => f).sort(),
      "no list-view tables found - the marker class was renamed and this test went blind",
    ).toEqual(["FrameListRows.tsx", "LibraryBrowserPane.tsx", "ReviewSessionsPane.tsx", "WebListRows.tsx"]);
  });

  it("every table uses the SHARED header, rather than hand-rolling one", () => {
    // The Review sessions table shipped with its own four-track grid and bare
    // <button> headings, so it read as a different product sitting inside the
    // library: "Session" in sentence case beside "PEOPLE" in caps, no column
    // dividers, no resize, no reorder, no right-click. Same table, same
    // chrome - the header components ARE the design.
    const missing = tables
      .filter(([, t]) => !(t.includes("<NameHeader") && t.includes("<ListColumnHeaders")))
      .map(([f]) => f);
    expect(
      missing,
      "a list view builds its own column headings instead of the shared ones, so it will not match:",
    ).toEqual([]);
  });

  it("every table's rows are the shared row, so selection and lasso behave alike", () => {
    const missing = tables.filter(([, t]) => !t.includes('"cp-lib-lrow')).map(([f]) => f);
    expect(missing, "a list view rolls its own row class:").toEqual([]);
  });

  it("every table draws the column lines", () => {
    const missing = tables.filter(([, t]) => !t.includes("<ListColumnRules")).map(([f]) => f);
    expect(
      missing,
      "a list view renders a column header but no rules, so its columns stop at the header:",
    ).toEqual([]);
  });

  it("the bleed moves the header, the rows and the rules together", () => {
    // Was the 40px gutter, which existed to reserve room for a hover button
    // that has since been removed. The rule that replaced it is the same
    // shape and the same hazard: these three boxes share one track geometry,
    // and horizontal padding applied to only some of them puts every body
    // line out of step with the header divider above it.
    const css = readFileSync(CSS, "utf8");
    const rule = css.match(/\.cp-lib-list \.cp-lib-list-head[^{]*\{[^}]*padding-right[^}]*\}/);
    expect(rule, "the shared row-padding rule is gone or was reshaped").toBeTruthy();
    for (const sel of ["cp-lib-list-head", "cp-lib-lrow", "cp-lib-colrules"]) {
      expect(
        rule![0],
        `the shared padding no longer applies to .${sel}, so its tracks are offset from the others`,
      ).toContain(sel);
    }
    expect(rule![0], "the rows no longer reach the pane's edges").toContain("--lib-bleed");
  });

  it("the rules and the rows read ONE track list", () => {
    const css = readFileSync(CSS, "utf8");
    // Anchored to the start of a line: `.cp-lib-list .cp-lib-colrules` also
    // contains this class name, and an unanchored match finds that padding
    // rule instead of the one declaring the tracks.
    const rules = css.match(/(?:^|\n)\.cp-lib-colrules\s*\{[^}]*\}/);
    expect(rules, ".cp-lib-colrules is gone").toBeTruthy();
    expect(
      rules![0],
      "the rules declare their own columns instead of reading the shared --lrow-cols",
    ).toContain("var(--lrow-cols)");
  });
});
