import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Layout guard for the library's multi-select bar.
 *
 * The bug this pins: `.cp-lib-selbar` is rendered as a child of
 * `.cp-lib-browse-body`, which is `display: flex` in the ROW direction. An
 * in-flow bar there is not a bar - it becomes a second COLUMN beside the
 * grid, stretched to the full height of the pane, with its buttons floating
 * at the vertical middle of a tall empty box. It shipped that way and read
 * as a rendering fault rather than a feature.
 *
 * Both halves of the fix are asserted, because either one alone is broken:
 * the bar must be out of flow, AND the body must be a positioning context
 * (without it the bar escapes to the nearest positioned ancestor and anchors
 * to the wrong box entirely, which looks fine until the window is resized).
 *
 * This is a CSS contract in the manner of focus-contract.test.ts: it reads
 * the stylesheet as text, because the thing being guarded IS the stylesheet.
 */

const CSS = path.resolve(__dirname, "../styles/library.css");

/** The declaration block for an EXACT selector, comments stripped. */
function declsFor(css: string, selector: string): string | null {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const chunk of stripped.split("}")) {
    const brace = chunk.lastIndexOf("{");
    if (brace < 0) continue;
    const sel = chunk.slice(0, brace).trim();
    // Split a grouped selector so `.a, .b { }` still matches `.a`.
    if (!sel.split(",").some((s) => s.trim() === selector)) continue;
    return chunk.slice(brace + 1);
  }
  return null;
}

describe("the multi-select bar is taken out of the browse row's flow", () => {
  const css = fs.readFileSync(CSS, "utf8");

  it("floats rather than sitting in the flex row as a full-height column", () => {
    const decls = declsFor(css, ".cp-lib-selbar");
    expect(decls, ".cp-lib-selbar has no rule in library.css").not.toBeNull();
    expect(
      /position:\s*(absolute|fixed)\b/.test(decls!),
      "the selection bar is in flow inside a `display: flex` row, so it renders " +
        "as a full-height column beside the grid instead of as a bar",
    ).toBe(true);
  });

  it("anchors to the browse body, which must therefore be positioned", () => {
    const decls = declsFor(css, ".cp-lib-browse-body");
    expect(decls, ".cp-lib-browse-body has no rule in library.css").not.toBeNull();
    expect(
      /position:\s*relative\b/.test(decls!),
      "the selection bar is absolutely positioned against .cp-lib-browse-body; " +
        "without `position: relative` it anchors to some further ancestor",
    ).toBe(true);
  });

  it("does not also carry the in-flow margin the old bar used", () => {
    // A leftover `margin-bottom` on an absolutely positioned pill is dead
    // weight that reads, to the next person, as if the bar were still in
    // flow. Cheap to assert, and it caught the real leftover once.
    const decls = declsFor(css, ".cp-lib-selbar")!;
    expect(/margin:\s*0\s+0\s+6px/.test(decls)).toBe(false);
  });
});
