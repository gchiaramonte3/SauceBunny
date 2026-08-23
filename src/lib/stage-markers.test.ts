import { describe, expect, it } from "vitest";
import { markerSummary, stageMarkers } from "./stage-markers";

const base = {
  duration: 100,
  markIn: null as number | null,
  markOut: null as number | null,
  chapters: [] as { time: number; title: string }[],
  comments: [] as { time: number; resolved: boolean }[],
};

describe("stageMarkers — positioning", () => {
  it("places a chapter at its fraction of the duration", () => {
    const { pins } = stageMarkers({ ...base, chapters: [{ time: 25, title: "Act two" }] });
    expect(pins).toHaveLength(1);
    expect(pins[0].pct).toBe(25);
    expect(pins[0].label).toBe("Act two");
  });

  it("draws nothing before the duration is known", () => {
    // Duration arrives on the player's ready event, several hundred ms after
    // the panel renders. Positioning against 0 divides into NaN and puts every
    // pin at the left edge, which reads as real markers at the start.
    expect(stageMarkers({ ...base, duration: 0, chapters: [{ time: 25, title: "x" }] }).pins)
      .toEqual([]);
    expect(stageMarkers({ ...base, duration: Number.POSITIVE_INFINITY, markIn: 5 }).pins)
      .toEqual([]);
  });

  it("drops a marker that lies outside this source", () => {
    // The bug this exists to prevent: marks belonging to another clip pile up
    // on the last pixel and read as a real marker at the end of this one.
    const { pins } = stageMarkers({
      ...base,
      markIn: -4,
      markOut: 400,
      chapters: [{ time: 101, title: "elsewhere" }],
    });
    expect(pins).toEqual([]);
  });

  it("keeps a marker exactly at either end", () => {
    const { pins } = stageMarkers({ ...base, markIn: 0, markOut: 100 });
    expect(pins.map((p) => p.pct)).toEqual([0, 100]);
  });
});

describe("stageMarkers — the in/out band", () => {
  it("shades between the two marks", () => {
    const { band } = stageMarkers({ ...base, markIn: 20, markOut: 60 });
    expect(band).toEqual({ startPct: 20, widthPct: 40 });
  });

  it("shades nothing when only one mark is set", () => {
    // A lone mark is a point in the recording. Shading from it to the end
    // claims a range nobody chose.
    expect(stageMarkers({ ...base, markIn: 20 }).band).toBeNull();
    expect(stageMarkers({ ...base, markOut: 60 }).band).toBeNull();
  });

  it("shades nothing when out is not after in", () => {
    expect(stageMarkers({ ...base, markIn: 60, markOut: 60 }).band).toBeNull();
    expect(stageMarkers({ ...base, markIn: 60, markOut: 20 }).band).toBeNull();
  });

  it("still pins both marks even when the band is refused", () => {
    const { pins, band } = stageMarkers({ ...base, markIn: 60, markOut: 20 });
    expect(band).toBeNull();
    expect(pins.map((p) => p.kind).sort()).toEqual(["in", "out"]);
  });
});

describe("stageMarkers — pins that land on the same pixel", () => {
  it("merges same-kind pins that are closer than a pixel apart", () => {
    // Three chapters four seconds apart in a two-hour recording are the same
    // dot. Drawing all three makes a smudge with an unaimable tooltip.
    const { pins } = stageMarkers({
      ...base,
      duration: 7200,
      chapters: [
        { time: 100, title: "a" }, { time: 104, title: "b" }, { time: 108, title: "c" },
      ],
    });
    expect(pins).toHaveLength(1);
    expect(pins[0].count).toBe(3);
    expect(pins[0].label).toBe("a");
  });

  it("does not merge across kinds", () => {
    // A comment and a chapter at the same moment are different things to know.
    const { pins } = stageMarkers({
      ...base,
      chapters: [{ time: 50, title: "a" }],
      comments: [{ time: 50, resolved: false }],
    });
    expect(pins).toHaveLength(2);
  });

  it("keeps pins that are genuinely far apart", () => {
    const { pins } = stageMarkers({
      ...base,
      chapters: [{ time: 10, title: "a" }, { time: 50, title: "b" }, { time: 90, title: "c" }],
    });
    expect(pins.map((p) => p.pct)).toEqual([10, 50, 90]);
  });
});

describe("stageMarkers — resolved comments", () => {
  it("leaves resolved comments off the bar", () => {
    const { pins } = stageMarkers({ ...base, comments: [{ time: 30, resolved: true }] });
    expect(pins).toEqual([]);
  });

  it("shows them when asked", () => {
    const { pins } = stageMarkers({
      ...base, comments: [{ time: 30, resolved: true }], showResolved: true,
    });
    expect(pins).toHaveLength(1);
  });
});

describe("markerSummary", () => {
  it("says what the bar is showing", () => {
    const { pins } = stageMarkers({
      ...base,
      markIn: 10, markOut: 60,
      chapters: [{ time: 20, title: "a" }, { time: 40, title: "b" }],
      comments: [{ time: 55, resolved: false }],
    });
    expect(markerSummary(pins)).toBe("in/out · 2 chapters · 1 comment");
  });

  it("counts what a merged pin stands for, not the dots drawn", () => {
    // Otherwise the line says "1 chapter" next to a dot meaning three, which
    // is the one job this line has.
    const { pins } = stageMarkers({
      ...base, duration: 7200,
      chapters: [{ time: 100, title: "a" }, { time: 104, title: "b" }],
    });
    expect(markerSummary(pins)).toBe("2 chapters");
  });

  it("is empty when there is nothing to say", () => {
    expect(markerSummary([])).toBe("");
  });
});

describe("stageMarkers — merging is not defeated by a pin of another kind", () => {
  it("merges two chapters that have a comment between them", () => {
    // The bug: merge compared against the last pin EMITTED, so the comment
    // became the tail, the chapter chain broke, and both chapters drew on the
    // same pixel - exactly the smudge merging exists to prevent.
    const { pins } = stageMarkers({
      duration: 7200,
      markIn: null, markOut: null,
      chapters: [{ time: 100, title: "a" }, { time: 102, title: "b" }],
      comments: [{ time: 101, resolved: false }],
    });
    const chapters = pins.filter((p) => p.kind === "chapter");
    expect(chapters, "the two chapters did not merge").toHaveLength(1);
    expect(chapters[0].count).toBe(2);
    // The comment is a different thing to know about and still gets its pin.
    expect(pins.filter((p) => p.kind === "comment")).toHaveLength(1);
  });

  it("still merges a long run broken up by several other kinds", () => {
    const { pins } = stageMarkers({
      duration: 7200,
      markIn: 100, markOut: 104,
      chapters: [{ time: 100, title: "a" }, { time: 101, title: "b" }, { time: 103, title: "c" }],
      comments: [{ time: 100.5, resolved: false }, { time: 102, resolved: false }],
    });
    expect(pins.filter((p) => p.kind === "chapter")).toHaveLength(1);
    expect(pins.filter((p) => p.kind === "chapter")[0].count).toBe(3);
    expect(pins.filter((p) => p.kind === "comment")).toHaveLength(1);
  });
});
