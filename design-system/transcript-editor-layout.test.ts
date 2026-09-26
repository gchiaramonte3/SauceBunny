import { describe, expect, it } from "vitest";
import { clampTimeline, layoutPanes, tePaneLimits, TE_RECORD_MIN, type TePane } from "./transcript-editor-layout";

const open = { sidebar: true, source: true, inspector: true };
const ideal = { sidebar: 220, source: 320, inspector: 270 };
const byDefault: TePane[] = ["source", "inspector", "sidebar"];

describe("transcript editor pane layout", () => {
  it("shows every open pane at its ideal width when the window has room", () => {
    const layout = layoutPanes(1680, open, ideal, byDefault);
    expect(layout.shown).toEqual(open);
    expect(layout.widths).toEqual(ideal);
    expect(layout.record).toBe(1680 - 220 - 320 - 270 - 3);
    expect(layout.folded).toBe(false);
  });

  it("at the app's minimum window the sidebar leaves first and the edit keeps its reading width", () => {
    const layout = layoutPanes(1100, open, ideal, byDefault);
    expect(layout.shown).toEqual({ sidebar: false, source: true, inspector: true });
    expect(layout.record).toBeGreaterThanOrEqual(TE_RECORD_MIN);
  });

  it("shrinks the lowest-priority pane toward its minimum before dropping anything", () => {
    const layout = layoutPanes(1240, open, ideal, byDefault);
    expect(layout.shown).toEqual(open);
    expect(layout.widths.source).toBe(320);
    expect(layout.widths.inspector).toBe(270);
    expect(layout.widths.sidebar).toBeLessThan(220);
    expect(layout.widths.sidebar).toBeGreaterThanOrEqual(tePaneLimits.sidebar.min);
    expect(layout.record).toBe(TE_RECORD_MIN);
    expect(layout.widths.sidebar + layout.widths.source + layout.widths.inspector + layout.record + 3).toBe(1240);
  });

  it("the pane opened last wins, and a source pane with no room folds rather than vanishing", () => {
    const layout = layoutPanes(1100, open, ideal, ["inspector", "sidebar", "source"]);
    expect(layout.shown).toEqual({ sidebar: true, source: false, inspector: true });
    expect(layout.folded).toBe(true);
  });

  it("a closed pane takes no room and is not reported as folded", () => {
    const layout = layoutPanes(1100, { sidebar: false, source: false, inspector: false }, ideal, byDefault);
    expect(layout.record).toBe(1100);
    expect(layout.folded).toBe(false);
  });

  it("clamps stored sizes to each pane's limits", () => {
    const layout = layoutPanes(2400, open, { sidebar: 10, source: 9000, inspector: 300 }, byDefault);
    expect(layout.widths).toEqual({ sidebar: 180, source: 480, inspector: 300 });
  });

  it("keeps the timeline between its minimum and half the window", () => {
    expect(clampTimeline(40, 800)).toBe(160);
    expect(clampTimeline(700, 800)).toBe(400);
    expect(clampTimeline(260, 800)).toBe(260);
  });
});
