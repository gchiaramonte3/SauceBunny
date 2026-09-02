import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The zebra rule, and the fact that it did not come back alongside hairlines.
 *
 * `.cp-lib-lrow:nth-child(even)` stripes the list. Finder draws
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
/* The selection FILL is declared in tokens.css, not here. Read both, or the
   "is it a hue" assertion below looks in the wrong file and reports the rule
   broken while it holds. */
const TOKENS = readFileSync(join(__dirname, "../styles/tokens.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

describe("list zebra", () => {
  it("stripes on nth-child(even)", () => {
    expect(CSS.length, "library.css did not load").toBeGreaterThan(1000);
    expect(CSS).toMatch(/^\.cp-lib-lrow:nth-child\(even\) \{/m);
    // The web and frames lists wrap each row (the forget button sits beside
    // the row BUTTON), so their parity has to live on the wrap.
    expect(CSS, "the wrapped lists lost their stripe").toMatch(/^\.cp-web-lrow-wrap:nth-child\(even\) \{/m);
    // Scoping the stripe under an ancestor raises it to (0,3,0) against the
    // (0,2,0) hover/focus/selected rules, and specificity is decided BEFORE
    // source order - so the order rule below stops meaning anything. Every
    // even row then refuses hover and paints its selection as white cells on
    // a grey stripe, which shipped and was found by measuring.
    expect(CSS, "the stripe is scoped under an ancestor and outranks hover/selection").not.toMatch(
      /\.cp-lib-list \.cp-lib-lrow:nth-child\(even\)/,
    );
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
    const stripe = pct(/^\.cp-lib-lrow:nth-child\(even\) \{ background: rgba\(255, 255, 255, ([\d.]+)\)/m);
    const hover = pct(/\.cp-lib-lrow:hover \{ background: rgba\(255, 255, 255, ([\d.]+)\)/);
    const focus = pct(/\.cp-lib-lrow:focus-visible \{[^}]*rgba\(255, 255, 255, ([\d.]+)\)/);
    for (const [name, v] of [["stripe", stripe], ["hover", hover], ["focus", focus]] as const) {
      expect(Number.isFinite(v), `could not read the ${name} value`).toBe(true);
    }
    expect(stripe, "the stripe is not the quietest rung").toBeLessThan(hover);
    expect(hover, "hover is not quieter than focus").toBeLessThan(focus);
    // Selection is NOT on this ladder any more, and that is the point.
    //
    // It used to be `--bg-4`, one grey step above focus, on a list that also
    // carries a stripe and a hover shade - four neutrals inside a few percent
    // of each other. The ladder was monotonic and the selection was still
    // invisible, which is a rule passing while the thing it protects fails.
    //
    // So the rule changed rather than the number: selection must be a HUE.
    // That also makes the original hazard - hover reading as more selected
    // than the selection - unreachable, because they are no longer on one
    // scale to be compared on.
    expect(CSS, "selection fell back onto the neutral ladder").toMatch(
      /\.cp-lib-lrow\.selected \{ background: var\(--sel-fill\)/,
    );
    expect(TOKENS, "the selection fill is not a distinct hue").toMatch(
      /--sel-fill:\s*var\(--novella-violet\)/,
    );
  });

  it("a selected row's secondary cells come up with the fill", () => {
    // The cells that are --fg-3 / --fg-4 measure 2.0:1 and worse against the
    // fill. Legible on a grey row, unreadable the instant it is selected -
    // and nothing else in the suite looks at a cell's colour in a state.
    for (const cell of ["kind", "date", "size", "custom"]) {
      expect(CSS, `a selected row leaves its ${cell} cell dim`).toMatch(
        new RegExp(`\\.cp-lib-lrow\\.selected \\.cp-lib-lrow-${cell}`),
      );
    }
  });

  it("a selected web/frame row lifts the marks inside its name cell too", () => {
    // Duration and the have-a-copy mark live INSIDE the name cell on the web
    // and frames rows, so the kind/date/size lift above never reached them:
    // --fg-4 on the violet fill measured 1.43:1.
    for (const mark of ["cp-web-lrow-dur", "cp-web-lrow-have"]) {
      expect(CSS, `a selected row leaves ${mark} dim`).toMatch(
        new RegExp(`\\.cp-lib-lrow\\.selected \\.${mark}`),
      );
    }
  });

  it("the wrapped lists draw no hairline either", () => {
    expect(CSS, "the web/frames wrap re-created the per-row hairline").not.toMatch(
      /\.cp-web-lrow-wrap \+ \.cp-web-lrow-wrap \{[^}]*border-top/,
    );
  });

  it("the grid card's selection ring is on the card, never on the art", () => {
    // The card clips its overflow and the art fills its padding box exactly,
    // so a ring drawn on the art lost its top, left and right and rendered as
    // a 2px underline. Measured in the harness before it was moved.
    expect(CSS).toMatch(/\.cp-lib-card\.selected \{[^}]*box-shadow: 0 0 0 2px var\(--sel-fill\)/);
    expect(CSS, "the ring went back onto the art").not.toMatch(/\.cp-lib-card\.selected \.cp-lib-card-art \{[^}]*box-shadow/);
  });

  it("the transcripts picker selects in the same hue", () => {
    // Same shift/cmd/lasso gesture, same useGridSelection - it painted the
    // retired one-grey-step (--bg-4 over --bg-1 is 1.30:1) while the three
    // library lists painted violet.
    const SHELL = readFileSync(join(__dirname, "../styles/shell.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(SHELL).toMatch(/\.cp-reader-row\.selected \{[^}]*background: var\(--sel-fill\)/);
  });

  it("hover and selection still outrank the stripe", () => {
    // Equal specificity, so source order decides. If the stripe is declared
    // last it wins on every second row and the list stops responding to the
    // pointer -- silently, and only on half the rows.
    const stripe = CSS.indexOf("\n.cp-lib-lrow:nth-child(even)");
    const hover = CSS.indexOf(".cp-lib-lrow:hover");
    const selected = CSS.indexOf(".cp-lib-lrow.selected");
    expect(stripe).toBeGreaterThan(-1);
    expect(hover, "hover is declared before the stripe and loses to it").toBeGreaterThan(stripe);
    expect(selected, "selection is declared before the stripe and loses to it").toBeGreaterThan(stripe);
  });
});
