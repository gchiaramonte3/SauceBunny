import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * An in/out mark wears its wing.
 *
 * DESIGN.md defines one in/out mark: a stem with a chevron wing at the waist,
 * pointing away from the marked region, drawn from --mark-wing-l/-r so it is
 * the same glyph as IconMarkIn and IconMarkOut. Clip's track and the reader's
 * pins drew it. AAF Audio's ruler and String Outs' ruler did not: each drew a
 * violet band with 1px sides and no wing, and nothing at all for a lone In or
 * Out, so the owner's note read "we need our in and out marker system to be
 * consistent throughout the app visually".
 *
 * Nothing about either band was wrong on its own; each was a plausible way to
 * shade a range. That is why this is a scan: a stem in the marker colour, the
 * thing that says "a mark starts here", must belong to a class that also draws
 * the wing, or be named below as a region that sits under a winged mark
 * somewhere else. A new flat band fails here instead of in a screenshot.
 */

// The design catalog draws the same marks from its own stylesheets, which
// load after production's and win, so a flat band there escaped this check.
const STYLES = [resolve(__dirname, "../styles"), resolve(__dirname, "../../design-system")];

type Rule = { file: string; selectors: string[]; body: string };

function rules(): Rule[] {
  const out: Rule[] = [];
  for (const [dir, file] of STYLES.flatMap((dir) => readdirSync(dir).filter((name) => name.endsWith(".css")).map((name) => [dir, name]))) {
    const css = readFileSync(join(dir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    // Innermost blocks only: an @media wrapper never reaches the capture.
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      out.push({ file, selectors: match[1].split(",").map((s) => s.trim()).filter(Boolean), body: match[2] });
    }
  }
  return out;
}

/** The class a selector is about: `.cp-reader-pin.in::after` is `cp-reader-pin`. */
const baseClass = (selector: string) => selector.match(/\.([\w-]+)/)?.[1] ?? selector;

/** A side edge in the marker colour: a border, or an inset shadow standing in for one. */
const STEM = /border-(?:left|right)\s*:[^;]*var\(--marker\)|box-shadow\s*:[^;]*inset\s+-?1px\s+0\s+0\s+var\(--marker\)/;
const WING = /clip-path\s*:\s*var\(--mark-wing-[lr]\)/;

/**
 * Regions, not marks: each shades the span between two marks that are drawn,
 * with their wings, somewhere right beside it. Every entry must still match a
 * stem, so a region that is removed cannot leave a licence behind.
 */
const REGIONS: Record<string, string> = {
  "cp-reader-scrub-band": "the in/out span under the reader's scrub fill; its pins carry the wings",
  "cp-te-tl-marked-lane": "the marked span on String Outs' selected lanes; the ruler above carries the wings",
};

const all = rules();
const stems = all.filter((rule) => STEM.test(rule.body)).flatMap((rule) => rule.selectors.map((selector) => ({ file: rule.file, selector, base: baseClass(selector) })));
const winged = new Set(all.filter((rule) => WING.test(rule.body)).flatMap((rule) => rule.selectors.map(baseClass)));

describe("the in/out mark", () => {
  it("is being looked for in real stylesheets", () => {
    // Canary: Clip's selection, the shared ruler mark and the two regions.
    expect(stems.length).toBeGreaterThanOrEqual(4);
    expect(winged.has("cp-track-selection")).toBe(true);
    expect(winged.has("cp-mark-range")).toBe(true);
  });

  it("draws a wing wherever it draws a stem in the marker colour", () => {
    const bare = stems.filter((stem) => !winged.has(stem.base) && !(stem.base in REGIONS)).map((stem) => `${stem.file}: ${stem.selector}`);
    expect(bare, "a marker-coloured edge with no chevron wing: use .cp-mark-range / .cp-mark (marks.css)").toEqual([]);
  });

  it("lists no region that no longer exists", () => {
    const found = new Set(stems.map((stem) => stem.base));
    expect(Object.keys(REGIONS).filter((name) => !found.has(name))).toEqual([]);
  });
});
