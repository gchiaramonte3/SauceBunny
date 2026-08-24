import { describe, expect, it } from "vitest";
import {
  filterFrames, formatFrameTimecode, frameCrumbs, frameLevel, groupBySource,
  sortFrames, type FrameItem,
} from "./frames";

const f = (over: Partial<FrameItem>): FrameItem => ({
  path: "/Docs/Sauce Bunny/Frames/a.jpg", name: "a.jpg", source: "A",
  folder: "", timecode: null, created_at: 0, size_bytes: 0, ...over,
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

describe("frameLevel — one level of a real directory tree", () => {
  const tree = [
    f({ name: "root1.jpg", folder: "", created_at: 10 }),
    f({ name: "sel1.jpg", folder: "Selects", created_at: 20 }),
    f({ name: "sel2.jpg", folder: "Selects", created_at: 30 }),
    f({ name: "deep.jpg", folder: "Selects/Day 2", created_at: 40 }),
    f({ name: "other.jpg", folder: "Rejects", created_at: 5 }),
  ];

  it("at the root: loose frames here, and the folders directly beneath", () => {
    const { here, folders } = frameLevel(tree, "");
    expect(here.map((x) => x.name)).toEqual(["root1.jpg"]);
    expect(folders.map((x) => x.name)).toEqual(["Rejects", "Selects"]);
  });

  it("a folder's count includes everything beneath it, the way Finder counts", () => {
    const { folders } = frameLevel(tree, "");
    expect(folders.find((x) => x.name === "Selects")!.count).toBe(3);
  });

  it("the cover is the three NEWEST stills beneath it, derived not stored", () => {
    const { folders } = frameLevel(tree, "");
    const sel = folders.find((x) => x.name === "Selects")!;
    expect(sel.covers).toHaveLength(3);
    expect(sel.covers[0]).toContain("a.jpg"); // fixture path; newest first
  });

  it("drilling in shows that level's frames and its own subfolders", () => {
    const { here, folders } = frameLevel(tree, "Selects");
    expect(here.map((x) => x.name).sort()).toEqual(["sel1.jpg", "sel2.jpg"]);
    expect(folders.map((x) => x.name)).toEqual(["Day 2"]);
    expect(folders[0].path).toBe("Selects/Day 2");
  });

  it("a sibling folder with a shared name PREFIX is not swallowed", () => {
    // "Selects" must not capture "SelectsOld" - the split has to be on the
    // separator, not on the string.
    const items = [
      f({ name: "a.jpg", folder: "Selects" }),
      f({ name: "b.jpg", folder: "SelectsOld" }),
    ];
    const { folders } = frameLevel(items, "");
    expect(folders.map((x) => x.name)).toEqual(["Selects", "SelectsOld"]);
    expect(frameLevel(items, "Selects").here.map((x) => x.name)).toEqual(["a.jpg"]);
  });
});

describe("frameCrumbs", () => {
  it("the root has none, and a nested path builds up", () => {
    expect(frameCrumbs("")).toEqual([]);
    expect(frameCrumbs("Selects/Day 2")).toEqual([
      { name: "Selects", path: "Selects" },
      { name: "Day 2", path: "Selects/Day 2" },
    ]);
  });
});
