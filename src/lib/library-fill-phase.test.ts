import { describe, expect, it } from "vitest";
import { listFillPhase } from "./library";

/**
 * The stripes carry on below the last row, Finder-style, and this is the one
 * part of that which CSS cannot do for itself.
 *
 * `.cp-lib-list-head` is child 1, so rows are children 2..n+1 and the stripe
 * falls on the EVEN children - rows 1, 3, 5. Whether the band immediately
 * under the last row must be plain or striped therefore depends on the row
 * count, and a `repeating-linear-gradient` cannot count rows. The four lists
 * pass this phase in beside the column template they already set.
 *
 * Verified once against rendered pixels rather than only reasoned about: with
 * 8 rows the last row samples at luminance 10 (plain) and the bands below it
 * run 17 / 10 / 17 in exact 27px steps, so the filler starts striped.
 */
describe("listFillPhase", () => {
  it("starts the filler STRIPED after an even number of rows", () => {
    // n even -> last row is child n+1, odd, unstriped -> the filler continues
    // the alternation by striping.
    for (const n of [0, 2, 4, 8, 100]) expect(listFillPhase(n), `${n} rows`).toBe(1);
  });

  it("starts the filler PLAIN after an odd number of rows", () => {
    for (const n of [1, 3, 5, 9, 101]) expect(listFillPhase(n), `${n} rows`).toBe(0);
  });

  it("alternates on every single added row, with no repeats", () => {
    // The failure this guards is an off-by-one that only shows on some lists:
    // a phase that is right for 5 rows and wrong for 6 looks like a rendering
    // glitch rather than a rule, and would be chased in the CSS.
    const seq = Array.from({ length: 12 }, (_, i) => listFillPhase(i));
    expect(seq).toEqual([1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0]);
  });
});
