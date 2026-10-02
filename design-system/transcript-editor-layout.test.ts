import { describe, expect, it } from "vitest";
import { clampTimeline, layoutPanes, tePaneLimits, TE_RECORD_MIN, type TePane } from "./transcript-editor-layout";

const open = { left: true, source: true, right: true };
const ideal = { left: 220, source: 320, right: 270 };
const byDefault: TePane[] = ["source", "right", "left"];

describe("transcript editor pane layout", () => {
  it("shows every open pane at its ideal width when the window has room", () => {
    const layout = layoutPanes(1680, open, ideal, byDefault);
    expect(layout.shown).toEqual(open);
    expect(layout.widths).toEqual(ideal);
    expect(layout.record).toBe(1680 - 220 - 320 - 270 - 3);
    expect(layout.folded).toEqual([]);
  });

  it("at the app's minimum window the left column leaves first and the edit keeps its reading width", () => {
    const layout = layoutPanes(1100, open, ideal, byDefault);
    expect(layout.shown).toEqual({ left: false, source: true, right: true });
    expect(layout.record).toBeGreaterThanOrEqual(TE_RECORD_MIN);
  });

  it("shrinks the lowest-priority pane toward its minimum before dropping anything", () => {
    const layout = layoutPanes(1240, open, ideal, byDefault);
    expect(layout.shown).toEqual(open);
    expect(layout.widths.source).toBe(320);
    expect(layout.widths.right).toBe(270);
    expect(layout.widths.left).toBeLessThan(220);
    expect(layout.widths.left).toBeGreaterThanOrEqual(tePaneLimits.left.min);
    expect(layout.record).toBe(TE_RECORD_MIN);
    expect(layout.widths.left + layout.widths.source + layout.widths.right + layout.record + 3).toBe(1240);
  });

  it("the pane opened last wins, and a source pane with no room folds rather than vanishing", () => {
    const layout = layoutPanes(1100, open, ideal, ["right", "left", "source"]);
    expect(layout.shown).toEqual({ left: true, source: false, right: true });
    expect(layout.folded).toEqual(["source"]);
  });

  it("a closed pane takes no room and is not reported as folded", () => {
    const layout = layoutPanes(1100, { left: false, source: false, right: false }, ideal, byDefault);
    expect(layout.record).toBe(1100);
    expect(layout.folded).toEqual([]);
  });

  it("clamps stored sizes to each pane's limits", () => {
    const layout = layoutPanes(2400, open, { left: 10, source: 9000, right: 300 }, byDefault);
    expect(layout.widths).toEqual({ left: 180, source: 480, right: 300 });
  });

  it("keeps the timeline between its minimum and half the window", () => {
    expect(clampTimeline(40, 800)).toBe(160);
    expect(clampTimeline(700, 800)).toBe(400);
    expect(clampTimeline(260, 800)).toBe(260);
  });
});
