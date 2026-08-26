import { describe, expect, it } from "vitest";
import { rebuildLogLine } from "./seek-log";

/**
 * The line that sent a whole investigation after a player that was behaving.
 *
 * A user reported "a major regression in seeking and scrubbing for web clips"
 * and produced this, which is damning until you know how the two lines are
 * emitted:
 *
 *     seek req 2666.0 → target 2666.0
 *     seek out-of-buffer → rebuilding from 3855.5s
 *
 * `seek req` fires once per GESTURE and `rebuilding from` fires once the
 * gesture settles, so the pair is start-of-drag and end-of-drag. Every seek in
 * that log landed exactly where it was asked. Nothing in the player was wrong.
 *
 * These tests pin the distinction that was missing, because the cost of losing
 * it again is not a cosmetic one: it is hours spent reading a correct
 * implementation looking for a fault that is not in it.
 */
describe("a rebuild says which gesture it belongs to", () => {
  it("calls a single-seek gesture a click, and says it landed as asked", () => {
    expect(rebuildLogLine(1298.8, 1298.8, 1)).toContain("click, landed as asked");
  });

  it("calls a moved gesture a drag, with both ends and the seek count", () => {
    const line = rebuildLogLine(3855.5, 2666.0, 61);
    expect(line).toContain("began 2666.0s");
    expect(line).toContain("released 3855.5s");
    expect(line).toContain("61 seeks");
    expect(line, "a drag must never read as a click").not.toContain("click");
  });

  it("still reports where the pipeline will open, which is the load-bearing number", () => {
    // Whatever else the line says, the rebuild point has to be in it: that is
    // the one value a reader can check against the pipeline-open line below.
    for (const [t, from] of [[3855.5, 2666.0], [0, 4928.8], [1298.8, 1298.8]] as const) {
      expect(rebuildLogLine(t, from, 3)).toContain(`rebuilding from ${t.toFixed(1)}s`);
    }
  });

  it("says nothing about a gesture it does not know", () => {
    // A rebuild with no recorded gesture (a programmatic seek, a resume) must
    // not invent one. Claiming "click, landed as asked" there would be the
    // same class of lie in the other direction.
    const line = rebuildLogLine(120, null, 0);
    expect(line).toBe("seek out-of-buffer → rebuilding from 120.0s");
  });

  it("treats a sub-frame difference as the same place", () => {
    // A drag that ends where it began is a click as far as the reader is
    // concerned, and float noise must not turn it into a suspicious drag.
    expect(rebuildLogLine(1298.84, 1298.8, 9)).toContain("click");
  });

  it("reports a drag to the very start as a drag, not as a mystery jump to zero", () => {
    // The line in the report that looked worst: `req 4928.8` then
    // `rebuilding from 0.0`. It was somebody dragging to the beginning.
    const line = rebuildLogLine(0, 4928.8, 40);
    expect(line).toContain("began 4928.8s");
    expect(line).toContain("released 0.0s");
  });
});
