import { describe, expect, it } from "vitest";
import {
  intersects, isDrag, MARQUEE_THRESHOLD, marqueeRect, marqueeSelection, pathsInRect, edgeScrollStep,
  type Rect,
} from "./marquee";

const r = (left: number, top: number, right: number, bottom: number): Rect =>
  ({ left, top, right, bottom });

/** Three stacked rows, list-view shaped: wide and short. */
const ROWS = [
  { path: "a", rect: r(0, 0, 400, 30) },
  { path: "b", rect: r(0, 30, 400, 60) },
  { path: "c", rect: r(0, 60, 400, 90) },
];

describe("the click threshold", () => {
  it("calls a still pointer a click, not a band", () => {
    // THE rule. Without it every click is a zero-area marquee that selects
    // nothing, so clicking a file would clear the selection you just made —
    // and only sometimes, depending on whether the hand twitched a pixel.
    expect(isDrag({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(false);
  });

  it("calls a sub-threshold twitch a click", () => {
    const d = MARQUEE_THRESHOLD - 1;
    expect(isDrag({ x: 10, y: 10 }, { x: 10 + d, y: 10 + d })).toBe(false);
  });

  it("calls real travel a band, on either axis alone", () => {
    expect(isDrag({ x: 10, y: 10 }, { x: 10 + MARQUEE_THRESHOLD, y: 10 })).toBe(true);
    expect(isDrag({ x: 10, y: 10 }, { x: 10, y: 10 + MARQUEE_THRESHOLD })).toBe(true);
  });

  it("counts travel in any direction", () => {
    expect(isDrag({ x: 50, y: 50 }, { x: 50 - MARQUEE_THRESHOLD, y: 50 })).toBe(true);
  });
});

describe("marqueeRect", () => {
  it("normalises a drag made in any direction", () => {
    const down = marqueeRect({ x: 10, y: 10 }, { x: 40, y: 80 });
    const up = marqueeRect({ x: 40, y: 80 }, { x: 10, y: 10 });
    expect(down).toEqual(r(10, 10, 40, 80));
    expect(up).toEqual(down); // dragging up-left is the same band
  });
});

describe("intersects", () => {
  it("is TOUCHES, not contains", () => {
    // A thin band swept down a column must take the whole column; requiring
    // containment means the band has to swallow a full-width row, which at
    // list widths is never what the hand did.
    expect(intersects(r(0, 0, 5, 100), r(0, 0, 400, 30))).toBe(true);
  });

  it("treats a shared edge as a miss", () => {
    expect(intersects(r(0, 0, 10, 10), r(10, 0, 20, 10))).toBe(false);
    expect(intersects(r(0, 0, 10, 10), r(0, 10, 10, 20))).toBe(false);
  });

  it("misses a rect entirely outside", () => {
    expect(intersects(r(0, 0, 10, 10), r(50, 50, 60, 60))).toBe(false);
  });
});

describe("pathsInRect", () => {
  it("takes every row the band crosses", () => {
    expect(pathsInRect(r(0, 20, 300, 70), ROWS)).toEqual(["a", "b", "c"]);
  });

  it("takes only what it actually touches", () => {
    expect(pathsInRect(r(0, 35, 300, 55), ROWS)).toEqual(["b"]);
  });

  it("takes nothing from a band in empty space", () => {
    expect(pathsInRect(r(0, 200, 300, 260), ROWS)).toEqual([]);
  });

  it("returns them in display order, not the order swept", () => {
    // A batch action iterates this, and "these three" means what the user sees.
    expect(pathsInRect(r(0, 0, 400, 90), ROWS)).toEqual(["a", "b", "c"]);
  });

  it("works on a grid, where a band can straddle two columns", () => {
    const grid = [
      { path: "tl", rect: r(0, 0, 100, 100) },
      { path: "tr", rect: r(110, 0, 210, 100) },
      { path: "bl", rect: r(0, 110, 100, 210) },
      { path: "br", rect: r(110, 110, 210, 210) },
    ];
    expect(pathsInRect(r(90, 90, 120, 120), grid)).toEqual(["tl", "tr", "bl", "br"]);
    expect(pathsInRect(r(0, 0, 105, 105), grid)).toEqual(["tl"]);
  });
});

describe("composing with the existing selection", () => {
  const base = new Set(["x", "y"]);

  it("replaces on a plain drag", () => {
    const out = marqueeSelection(base, ["a", "b"], { shift: false, meta: false });
    expect([...out].sort()).toEqual(["a", "b"]);
  });

  it("adds to what was there when shift or command is held", () => {
    const s = marqueeSelection(base, ["a"], { shift: true, meta: false });
    expect([...s].sort()).toEqual(["a", "x", "y"]);
    const m = marqueeSelection(base, ["a"], { shift: false, meta: true });
    expect([...m].sort()).toEqual(["a", "x", "y"]);
  });

  it("does not double-count a path already in the base", () => {
    const out = marqueeSelection(base, ["x"], { shift: true, meta: false });
    expect([...out].sort()).toEqual(["x", "y"]);
  });

  it("is computed from the PRE-DRAG selection, so a band can shrink", () => {
    // Dragging back and forth must keep answering the same thing rather than
    // accumulating everything the band ever swept across.
    const big = marqueeSelection(base, ["a", "b", "c"], { shift: false, meta: false });
    const small = marqueeSelection(base, ["a"], { shift: false, meta: false });
    expect([...big].sort()).toEqual(["a", "b", "c"]);
    expect([...small].sort()).toEqual(["a"]); // NOT a,b,c
  });

  it("an empty band clears a plain drag but keeps a modified one", () => {
    expect([...marqueeSelection(base, [], { shift: false, meta: false })]).toEqual([]);
    expect([...marqueeSelection(base, [], { shift: true, meta: false })].sort()).toEqual(["x", "y"]);
  });
});

describe("Shift and Command are different gestures during a band", () => {
  // Both used to union, which made ⌘ a slower Shift and left no way to take
  // something OUT of a selection with a band. Finder: Shift = union with the
  // pre-drag selection, Command = toggle.
  const base = new Set(["a", "b"]);

  it("Shift unions with what was already selected", () => {
    expect([...marqueeSelection(base, ["c"], { shift: true, meta: false })].sort())
      .toEqual(["a", "b", "c"]);
  });

  it("Command REMOVES an already-selected item the band sweeps", () => {
    // The point of ⌘: sweep back over a mistake to undo it.
    expect([...marqueeSelection(base, ["b"], { shift: false, meta: true })])
      .toEqual(["a"]);
  });

  it("Command adds one that was not selected, in the same sweep", () => {
    expect([...marqueeSelection(base, ["b", "c"], { shift: false, meta: true })].sort())
      .toEqual(["a", "c"]);
  });

  it("no modifier still replaces, so a plain band is not additive", () => {
    expect([...marqueeSelection(base, ["c"], { shift: false, meta: false })])
      .toEqual(["c"]);
  });
});

describe("edgeScrollStep", () => {
  // Without autoscroll the largest selection a band can make is whatever is
  // visible — in a folder of a few hundred files, a fraction of it.
  const TOP = 100, BOTTOM = 500;

  it("is zero well inside the container", () => {
    expect(edgeScrollStep(300, TOP, BOTTOM)).toBe(0);
    expect(edgeScrollStep(TOP + 60, TOP, BOTTOM)).toBe(0);
    expect(edgeScrollStep(BOTTOM - 60, TOP, BOTTOM)).toBe(0);
  });

  it("scrolls UP near the top edge and DOWN near the bottom", () => {
    expect(edgeScrollStep(TOP + 10, TOP, BOTTOM)).toBeLessThan(0);
    expect(edgeScrollStep(BOTTOM - 10, TOP, BOTTOM)).toBeGreaterThan(0);
  });

  it("ramps: further past the edge scrolls faster", () => {
    const near = edgeScrollStep(BOTTOM - 40, TOP, BOTTOM);
    const far = edgeScrollStep(BOTTOM - 4, TOP, BOTTOM);
    expect(far).toBeGreaterThan(near);
  });

  it("caps the step, so a pointer far outside does not teleport the list", () => {
    expect(edgeScrollStep(BOTTOM + 5000, TOP, BOTTOM)).toBe(24);
    expect(edgeScrollStep(TOP - 5000, TOP, BOTTOM)).toBe(-24);
  });

  it("is symmetric about the two edges", () => {
    expect(edgeScrollStep(TOP + 8, TOP, BOTTOM)).toBe(-edgeScrollStep(BOTTOM - 8, TOP, BOTTOM));
  });
});
