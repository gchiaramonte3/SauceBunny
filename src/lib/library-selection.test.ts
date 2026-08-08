import { describe, expect, it } from "vitest";
import {
  clickSelect, EMPTY_SELECTION, pruneSelection, selectAll, selectedInOrder,
  type SelectionState,
} from "./library-selection";

/**
 * The anchor is the part with no visual representation, so it is the part that
 * ships broken. Most of these tests are about where it ends up.
 */

const P = ["a", "b", "c", "d", "e", "f"];
const plain = { shift: false, meta: false };
const shift = { shift: true, meta: false };
const meta = { shift: false, meta: true };
const both = { shift: true, meta: true };

const sel = (state: SelectionState) => [...state.selected].sort().join("");
const at = (paths: readonly string[], ...clicks: [string, typeof plain][]) =>
  clicks.reduce((s, [p, m]) => clickSelect(s, paths, p, m), EMPTY_SELECTION);

describe("plain click", () => {
  it("selects exactly one thing and anchors there", () => {
    const s = clickSelect(EMPTY_SELECTION, P, "c", plain);
    expect(sel(s)).toBe("c");
    expect(s.anchor).toBe("c");
  });

  it("replaces a multi-selection rather than adding to it", () => {
    const s = at(P, ["b", plain], ["e", shift], ["a", plain]);
    expect(sel(s)).toBe("a");
  });

  it("is a no-op when it lands on the only selected item", () => {
    // Identity is preserved so a re-render can be skipped.
    const one = clickSelect(EMPTY_SELECTION, P, "c", plain);
    expect(clickSelect(one, P, "c", plain)).toBe(one);
  });
});

describe("command click", () => {
  it("adds without disturbing the rest", () => {
    const s = at(P, ["b", plain], ["d", meta], ["f", meta]);
    expect(sel(s)).toBe("bdf");
  });

  it("toggles an already-selected item back off", () => {
    const s = at(P, ["b", plain], ["d", meta], ["d", meta]);
    expect(sel(s)).toBe("b");
  });

  it("can empty the selection entirely", () => {
    const s = at(P, ["b", plain], ["b", meta]);
    expect(s.selected.size).toBe(0);
  });

  it("moves the anchor, so a following shift extends from what was just touched", () => {
    const s = at(P, ["a", plain], ["d", meta]);
    expect(s.anchor).toBe("d");
    expect(sel(clickSelect(s, P, "f", shift))).toBe("def");
  });
});

describe("shift click", () => {
  it("selects the span between anchor and click, inclusive", () => {
    expect(sel(at(P, ["b", plain], ["e", shift]))).toBe("bcde");
  });

  it("works backwards", () => {
    expect(sel(at(P, ["e", plain], ["b", shift]))).toBe("bcde");
  });

  it("DOES NOT MOVE THE ANCHOR, so the range can be resized", () => {
    // The rule the whole file exists for. Moving the anchor makes the second
    // shift-click start a fresh range at the first one's end, so the selection
    // crawls down the window instead of growing and shrinking in place.
    const first = at(P, ["b", plain], ["e", shift]);
    expect(first.anchor).toBe("b");
    const grown = clickSelect(first, P, "f", shift);
    expect(sel(grown)).toBe("bcdef");
    const shrunk = clickSelect(grown, P, "c", shift);
    expect(sel(shrunk)).toBe("bc"); // resized from the ORIGINAL anchor, not from f
    expect(shrunk.anchor).toBe("b");
  });

  it("replaces the previous selection rather than accumulating", () => {
    const s = at(P, ["a", plain], ["b", shift], ["e", plain], ["f", shift]);
    expect(sel(s)).toBe("ef");
  });

  it("degrades to a plain click when there is no anchor", () => {
    const s = clickSelect(EMPTY_SELECTION, P, "d", shift);
    expect(sel(s)).toBe("d");
    expect(s.anchor).toBe("d");
  });

  it("degrades to a plain click when the anchor has been sorted away", () => {
    // Anchored on "b", then the view re-sorts and "b" is no longer present.
    const anchored = at(P, ["b", plain]);
    const s = clickSelect(anchored, ["x", "y", "z"], "y", shift);
    expect(sel(s)).toBe("y");
  });

  it("selects a single item when clicking the anchor itself", () => {
    expect(sel(at(P, ["c", plain], ["c", shift]))).toBe("c");
  });
});

describe("command+shift", () => {
  it("adds a span to the existing selection instead of replacing it", () => {
    const s = at(P, ["a", plain], ["e", meta], ["f", both]);
    expect(sel(s)).toBe("aef"); // "a" survives; e..f added
  });
});

describe("ranges follow DISPLAY order", () => {
  it("spans what the user sees, not the underlying order", () => {
    // Same files, sorted differently. The span between two clicks must be what
    // lies between them ON SCREEN, or sorting by size makes selection look
    // arbitrary.
    const byDate = ["f", "a", "d", "b", "e", "c"];
    expect(sel(at(byDate, ["a", plain], ["b", shift]))).toBe("abd");
    expect(sel(at(P, ["a", plain], ["b", shift]))).toBe("ab");
  });
});

describe("a click on something not on screen", () => {
  it("changes nothing at all", () => {
    // A stale card clicked mid-rescan must not wipe the selection.
    const s = at(P, ["b", plain], ["c", meta]);
    expect(clickSelect(s, P, "zzz", plain)).toBe(s);
  });
});

describe("pruneSelection", () => {
  it("drops paths that are no longer listed", () => {
    // A batch action must never run over files the user cannot see.
    const s = at(P, ["b", plain], ["e", shift]); // b c d e
    const pruned = pruneSelection(s, ["a", "b", "c"]);
    expect(sel(pruned)).toBe("bc");
  });

  it("clears an anchor that vanished, leaving the rest alone", () => {
    const s = at(P, ["b", plain], ["d", meta]);
    const pruned = pruneSelection(s, ["a", "b", "c"]); // "d" gone, it was the anchor
    expect(sel(pruned)).toBe("b");
    expect(pruned.anchor).toBeNull();
  });

  it("keeps identity when everything still exists", () => {
    const s = at(P, ["b", plain], ["d", meta]);
    expect(pruneSelection(s, P)).toBe(s);
  });
});

describe("selectAll / selectedInOrder", () => {
  it("selects everything and anchors at the top", () => {
    const s = selectAll(P);
    expect(s.selected.size).toBe(6);
    expect(s.anchor).toBe("a");
  });

  it("returns selected paths in DISPLAY order, not click order", () => {
    // What a batch action iterates. Set insertion order is click order, which
    // is not what "these three" means to the person who picked them.
    const s = at(P, ["e", plain], ["a", meta], ["c", meta]);
    expect(selectedInOrder(s, P)).toEqual(["a", "c", "e"]);
  });

  it("survives an empty list", () => {
    expect(selectAll([]).anchor).toBeNull();
    expect(selectedInOrder(EMPTY_SELECTION, [])).toEqual([]);
  });
});
