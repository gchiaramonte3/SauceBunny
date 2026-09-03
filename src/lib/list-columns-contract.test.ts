import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every list header comes from ListColumnHeaders, and no list writes its own
 * grid tracks.
 *
 * The three lists (library, web, frames) each used to hand-write their header
 * row: four cells in source order, each carrying the resize divider for the
 * column AFTER it, against five literal grid tracks in library.css with three
 * --col-* variables poked into the middle. That arrangement cannot express a
 * hidden or a reordered column - the width stays reserved and the cells stay
 * in source order - and it was copied twice before anyone noticed it would
 * have to be.
 *
 * So the rule is not "use the helper because it is tidier". It is: the grid
 * template, the header cells and the row cells must be derived from ONE
 * column model, because three literals that have to agree will not.
 *
 * e2e/list-columns.spec.ts checks that they DO agree once rendered. This
 * checks that a fourth list cannot quietly opt out.
 */

const DIR = join(__dirname, "../components");

/** Component sources, comments stripped so this file's prose cannot match. */
function components(): Array<[name: string, src: string]> {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
    .map((f) => [f, readFileSync(join(DIR, f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/^\s*\/\/.*$/gm, "")] as [string, string]);
}

const ALL = components();
const heads = ALL.filter(([, src]) => src.includes('className="cp-lib-list-head"'));

describe("list columns", () => {
  it("found the list components", () => {
    // The canary. Rename the header class and every check below passes over
    // an empty set, which is the failure mode this repo keeps meeting.
    expect(ALL.length, "no components were read").toBeGreaterThan(20);
    expect(heads.map(([n]) => n).sort(), "the set of list views changed").toEqual([
      "FrameListRows.tsx", "LibraryBrowserPane.tsx", "ReviewSessionsPane.tsx", "WebListRows.tsx",
    ]);
  });

  it("every one renders its optional headers through the shared component", () => {
    for (const [name, src] of heads) {
      expect(src, `${name} builds a header row without ListColumnHeaders`).toContain(
        "<ListColumnHeaders",
      );
    }
  });

  it("every one gets its Name header from the shared component", () => {
    // Name is resizable now, and the reason it was not for so long is exactly
    // what this forbids: all three lists wrote their own bare
    // `<SortHeader label="Name">`, so giving Name a divider would have meant
    // making the same change in three files, and it was made in none.
    //
    // A fourth list that hand-writes this header gets a Name column that
    // silently cannot be resized, which looks like the feature not existing
    // rather than like a bug.
    for (const [name, src] of heads) {
      expect(src, `${name} builds its own Name header`).toContain("<NameHeader");
      expect(src, `${name} still hand-writes a Name SortHeader`)
        .not.toMatch(/<SortHeader[^>]*label="Name"/);
    }
  });

  it("none places a resize divider by hand any more", () => {
    // A ColDivider outside ListColumnHeaders is a header cell resizing a
    // column the model does not know it owns -- which is how the divider
    // ended up on the previous cell, widening the column to its right.
    for (const [name, src] of heads) {
      expect(src, `${name} still places a ColDivider itself`).not.toContain("<ColDivider");
    }
  });

  it("none writes its own grid tracks", () => {
    for (const [name, src] of heads) {
      expect(src, `${name} sets a --col-* track instead of using the model's template`)
        .not.toMatch(/--col-(kind|size|date|site|source)/);
      expect(src, `${name} does not read the model's template`).toContain("--lrow-cols");
    }
  });

  it("the stylesheet reads the template rather than naming tracks", () => {
    const css = readFileSync(join(__dirname, "../styles/library.css"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/grid-template-columns: var\(--lrow-cols/);
    expect(css, "a --col-* variable is still consulted").not.toMatch(/var\(--col-(kind|size|date)/);
  });
});
