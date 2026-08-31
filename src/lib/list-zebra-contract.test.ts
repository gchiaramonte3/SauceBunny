import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The zebra rule, and the fact that it did not come back alongside hairlines.
 *
 * `.cp-lib-list .cp-lib-lrow:nth-child(even)` stripes the list. Finder draws
 * stripes OR rules, never both, and two separators per boundary is noise, so
 * the per-row `border-top` this replaced must stay gone.
 *
 * The other half of the rule -- that nth-child counts the header as child 1,
 * so `even` lands on the first data row -- cannot be checked here. Two of the
 * three lists render their rows through child components, so the class never
 * appears in the file that owns the container. e2e/list-zebra.spec.ts checks
 * it in the rendered DOM instead, which is where the question actually lives.
 * An earlier draft did try to check it from source and passed only because a
 * `.cp-lib-lrow-art` spacer inside the header matched the row probe.
 */

const CSS = readFileSync(join(__dirname, "../styles/library.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

describe("list zebra", () => {
  it("stripes on nth-child(even)", () => {
    expect(CSS.length, "library.css did not load").toBeGreaterThan(1000);
    expect(CSS).toMatch(/\.cp-lib-list \.cp-lib-lrow:nth-child\(even\)/);
  });

  it("draws no per-row hairline as well", () => {
    expect(CSS, "hairlines came back alongside the stripes").not.toMatch(
      /\.cp-lib-lrow \+ \.cp-lib-lrow \{[^}]*border-top/,
    );
  });

  it("the row ladder is monotonic", () => {
    // plain < stripe < hover < focus < selected, composited over --bg-1.
    // Adding the stripe compressed the bottom of this ramp, and the first
    // attempt put hover ABOVE selection: a hovered row looked more selected
    // than the selected one, which nothing else would have caught.
    const pct = (re: RegExp) => {
      const m = CSS.match(re);
      return m ? Number(m[1]) : NaN;
    };
    const stripe = pct(/\.cp-lib-list \.cp-lib-lrow:nth-child\(even\) \{ background: rgba\(255, 255, 255, ([\d.]+)\)/);
    const hover = pct(/\.cp-lib-lrow:hover \{ background: rgba\(255, 255, 255, ([\d.]+)\)/);
    const focus = pct(/\.cp-lib-lrow:focus-visible \{[^}]*rgba\(255, 255, 255, ([\d.]+)\)/);
    for (const [name, v] of [["stripe", stripe], ["hover", hover], ["focus", focus]] as const) {
      expect(Number.isFinite(v), `could not read the ${name} value`).toBe(true);
    }
    expect(stripe, "the stripe is not the quietest rung").toBeLessThan(hover);
    expect(hover, "hover is not quieter than focus").toBeLessThan(focus);
    // Selection is a token, not a percentage; --bg-4 sits above focus's 0.075
    // over --bg-1 (40 vs 32). Assert the token rather than recompute it.
    expect(CSS, "selection dropped below the focus rung").toMatch(
      /\.cp-lib-lrow\.selected \{ background: var\(--bg-4\)/,
    );
  });

  it("hover and selection still outrank the stripe", () => {
    // Equal specificity, so source order decides. If the stripe is declared
    // last it wins on every second row and the list stops responding to the
    // pointer -- silently, and only on half the rows.
    const stripe = CSS.indexOf(".cp-lib-list .cp-lib-lrow:nth-child(even)");
    const hover = CSS.indexOf(".cp-lib-lrow:hover");
    const selected = CSS.indexOf(".cp-lib-lrow.selected");
    expect(stripe).toBeGreaterThan(-1);
    expect(hover, "hover is declared before the stripe and loses to it").toBeGreaterThan(stripe);
    expect(selected, "selection is declared before the stripe and loses to it").toBeGreaterThan(stripe);
  });
});
