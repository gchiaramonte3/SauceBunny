import { describe, expect, it } from "vitest";
import {
  filterFrames, formatFrameTimecode, groupBySource, sortFrames, type FrameItem,
} from "./frames";

const f = (over: Partial<FrameItem>): FrameItem => ({
  path: "/Docs/Sauce Bunny/Frames/a.jpg", name: "a.jpg", source: "A",
  timecode: null, created_at: 0, size_bytes: 0, ...over,
});

describe("groupBySource", () => {
  it("bundles by the film a frame came from, biggest bundle first", () => {
    const out = groupBySource([
      f({ name: "1.jpg", source: "Solo" }),
      f({ name: "2.jpg", source: "The Bear" }),
      f({ name: "3.jpg", source: "The Bear" }),
    ]);
    expect(out.map((g) => g.source)).toEqual(["The Bear", "Solo"]);
    expect(out[0].items).toHaveLength(2);
  });

  it("breaks ties alphabetically so the shelf never reshuffles itself", () => {
    const out = groupBySource([f({ source: "Zulu" }), f({ source: "Alpha" })]);
    expect(out.map((g) => g.source)).toEqual(["Alpha", "Zulu"]);
  });

  it("groups case-insensitively but keeps the first spelling seen", () => {
    const out = groupBySource([f({ source: "The Bear" }), f({ source: "the bear" })]);
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("The Bear");
  });
});

describe("sortFrames", () => {
  it("name sorts numerically, so a film's frames read in timecode order", () => {
    const out = sortFrames([
      f({ name: "cut_00001000.jpg" }),
      f({ name: "cut_00000200.jpg" }),
      f({ name: "cut_00000100.jpg" }),
    ], "name", "asc");
    expect(out.map((x) => x.name)).toEqual([
      "cut_00000100.jpg", "cut_00000200.jpg", "cut_00001000.jpg",
    ]);
  });

  it("keeps the name tiebreak ascending under date desc, like every other shelf", () => {
    const out = sortFrames([
      f({ name: "zeta.jpg", created_at: 100 }),
      f({ name: "alpha.jpg", created_at: 100 }),
      f({ name: "mid.jpg", created_at: 200 }),
    ], "date", "desc");
    expect(out.map((x) => x.name)).toEqual(["mid.jpg", "alpha.jpg", "zeta.jpg"]);
  });

  it("does not mutate its input", () => {
    const input = [f({ name: "b.jpg" }), f({ name: "a.jpg" })];
    const before = [...input];
    sortFrames(input, "name", "asc");
    expect(input).toEqual(before);
  });
});

describe("filterFrames", () => {
  it("matches the filename and the source", () => {
    const items = [
      f({ name: "bear_00000100.jpg", source: "The Bear" }),
      f({ name: "solo_00000100.jpg", source: "Solo" }),
    ];
    expect(filterFrames(items, "bear")).toHaveLength(1);
    expect(filterFrames(items, "SOLO")).toHaveLength(1);
  });

  it("an empty or whitespace needle means no filter, and returns a copy", () => {
    const items = [f({}), f({})];
    expect(filterFrames(items, "")).toHaveLength(2);
    expect(filterFrames(items, "  ")).toHaveLength(2);
    expect(filterFrames(items, "")).not.toBe(items);
  });
});

describe("formatFrameTimecode", () => {
  it("puts the colons back", () => {
    expect(formatFrameTimecode("00012304")).toBe("00:01:23:04");
    expect(formatFrameTimecode("011523")).toBe("01:15:23");
  });

  it("shows an unexpected tail as-is rather than slicing it into a lie", () => {
    expect(formatFrameTimecode(null)).toBeNull();
    expect(formatFrameTimecode("0001230")).toBe("0001230"); // odd length
    expect(formatFrameTimecode("0100")).toBe("0100"); // too short
  });
});
