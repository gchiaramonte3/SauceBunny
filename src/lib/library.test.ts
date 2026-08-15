import { describe, it, expect } from "vitest";
import type { LibraryFolder, LibraryItem } from "../types";
import {
  collectLibraryItems,
  countLibraryItems,
  findLibraryFolder,
  formatBytes,
  formatModifiedDate,
  libraryPosterPaths,
  sanitizeLibraryRoots,
  searchLibrary,
  sortLibraryItems,
} from "./library";

function item(name: string, kind: LibraryItem["kind"] = "video"): LibraryItem {
  return { name, path: `/lib/${name}`, size_bytes: 1, modified_ms: 1, kind };
}

function folder(
  name: string,
  items: LibraryItem[] = [],
  folders: LibraryFolder[] = [],
  path = `/lib/${name}`,
): LibraryFolder {
  return { name, path, folders, items };
}

describe("sanitizeLibraryRoots", () => {
  it("keeps well-formed string lists in order", () => {
    expect(sanitizeLibraryRoots(["/a", "/b"])).toEqual(["/a", "/b"]);
  });
  it("drops non-strings, empties, and duplicate roots (first wins)", () => {
    expect(sanitizeLibraryRoots(["/a", 3, "", null, "/a", "/b", {}]))
      .toEqual(["/a", "/b"]);
  });
  it("yields [] for junk blobs instead of crashing", () => {
    expect(sanitizeLibraryRoots("nope")).toEqual([]);
    expect(sanitizeLibraryRoots({ roots: ["/a"] })).toEqual([]);
    expect(sanitizeLibraryRoots(undefined)).toEqual([]);
  });
});

describe("countLibraryItems", () => {
  it("counts items across the whole subtree", () => {
    const tree = folder("root", [item("a.mp4")], [
      folder("sub", [item("b.mp4"), item("c.mp3", "audio")], [
        folder("deep", [item("d.mov")]),
      ]),
      folder("empty"),
    ]);
    expect(countLibraryItems(tree)).toBe(4);
    expect(countLibraryItems(folder("bare"))).toBe(0);
  });
});

describe("libraryPosterPaths", () => {
  it("prefers shallow video items, skips audio, caps at max", () => {
    const tree = folder("root", [item("a.mp4"), item("skip.mp3", "audio")], [
      folder("sub", [item("b.mp4"), item("c.mp4"), item("d.mp4")]),
    ]);
    expect(libraryPosterPaths(tree, 3)).toEqual(["/lib/a.mp4", "/lib/b.mp4", "/lib/c.mp4"]);
  });
  it("returns [] for audio-only folders", () => {
    expect(libraryPosterPaths(folder("music", [item("x.mp3", "audio")]))).toEqual([]);
  });
});

describe("searchLibrary", () => {
  const trees = [
    folder("Footage", [item("Interview-final.mp4"), item("broll.mov")], [
      folder("Interviews", [item("intro.mp4")], [], "/lib/Footage/Interviews"),
    ], "/lib/Footage"),
    folder("Music", [item("theme.mp3", "audio")], [], "/lib/Music"),
  ];

  it("matches items and folders case-insensitively", () => {
    const r = searchLibrary(trees, "INTERVIEW");
    expect(r.items.map((i) => i.name)).toEqual(["Interview-final.mp4"]);
    expect(r.folders.map((f) => f.folder.name)).toEqual(["Interviews"]);
    expect(r.totalItems).toBe(1);
  });

  it("carries the drill chain on folder hits", () => {
    const r = searchLibrary(trees, "interviews");
    expect(r.folders[0].chain).toEqual([
      { name: "Footage", path: "/lib/Footage" },
      { name: "Interviews", path: "/lib/Footage/Interviews" },
    ]);
  });

  it("caps item results but reports the true total", () => {
    const many = folder("Bulk", Array.from({ length: 10 }, (_, i) => item(`take-${i}.mp4`)));
    const r = searchLibrary([many], "take", { items: 4 });
    expect(r.items).toHaveLength(4);
    expect(r.totalItems).toBe(10);
  });

  it("returns nothing for an empty/whitespace query", () => {
    const r = searchLibrary(trees, "   ");
    expect(r.items).toEqual([]);
    expect(r.folders).toEqual([]);
  });
});


describe("formatBytes", () => {
  it("picks sensible units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(64 * 1024)).toBe("64 KB");
    expect(formatBytes(2.5 * 1024 * 1024)).toBe("2.5 MB");
    expect(formatBytes(128 * 1024 * 1024)).toBe("128 MB");
    expect(formatBytes(1.25 * 1024 * 1024 * 1024)).toBe("1.3 GB");
  });
  it("is blank for junk", () => {
    expect(formatBytes(-1)).toBe("");
    expect(formatBytes(Number.NaN)).toBe("");
  });
});

describe("formatModifiedDate", () => {
  const now = new Date("2026-07-14T12:00:00Z");
  it("is blank for the scan's 0 = unknown sentinel", () => {
    expect(formatModifiedDate(0, now)).toBe("");
  });
  it("omits the year for this year, includes it otherwise", () => {
    const thisYear = formatModifiedDate(Date.UTC(2026, 5, 3, 12), now);
    expect(thisYear).toContain("3");
    expect(thisYear).not.toContain("2026");
    expect(formatModifiedDate(Date.UTC(2024, 5, 3, 12), now)).toContain("2024");
  });
});

describe("collectLibraryItems", () => {
  it("flattens every item in the subtree, own files before children", () => {
    const tree = folder("root", [item("a.mp4"), item("b.mp4")], [
      folder("sub", [item("c.mp4")], [folder("deep", [item("d.mp4")])]),
    ]);
    expect(collectLibraryItems(tree).map((i) => i.name)).toEqual([
      "a.mp4", "b.mp4", "c.mp4", "d.mp4",
    ]);
  });
  it("matches countLibraryItems on length", () => {
    const tree = folder("root", [item("a.mp4")], [folder("s", [item("b.mp4"), item("c.m4a", "audio")])]);
    expect(collectLibraryItems(tree)).toHaveLength(countLibraryItems(tree));
  });
});

describe("findLibraryFolder", () => {
  const trees = [folder("root", [], [folder("sub", [], [], "/lib/root/sub")], "/lib/root")];
  it("finds a nested folder by absolute path", () => {
    expect(findLibraryFolder(trees, "/lib/root/sub")?.name).toBe("sub");
    expect(findLibraryFolder(trees, "/lib/root")?.name).toBe("root");
  });
  it("returns null when the path is gone", () => {
    expect(findLibraryFolder(trees, "/lib/nope")).toBeNull();
  });
});

describe("sortLibraryItems", () => {
  const mk = (name: string, size: number, mod: number): LibraryItem =>
    ({ name, path: `/x/${name}`, size_bytes: size, modified_ms: mod, kind: "video" });
  const items = [mk("clip10.mp4", 30, 100), mk("clip2.mp4", 10, 300), mk("clip1.mp4", 20, 200)];
  it("sorts by name with numeric awareness (clip2 before clip10)", () => {
    expect(sortLibraryItems(items, "name", "asc").map((i) => i.name)).toEqual([
      "clip1.mp4", "clip2.mp4", "clip10.mp4",
    ]);
  });
  it("descending reverses the order", () => {
    expect(sortLibraryItems(items, "size", "desc").map((i) => i.size_bytes)).toEqual([30, 20, 10]);
  });
  it("sorts by date and size", () => {
    expect(sortLibraryItems(items, "date", "asc").map((i) => i.modified_ms)).toEqual([100, 200, 300]);
    expect(sortLibraryItems(items, "size", "asc").map((i) => i.size_bytes)).toEqual([10, 20, 30]);
  });
  it("does not mutate the input", () => {
    const copy = [...items];
    sortLibraryItems(items, "name", "asc");
    expect(items).toEqual(copy);
  });
});

describe("sortLibraryItems tiebreak direction", () => {
  // Files sharing a modified date is the ordinary case, not the edge one:
  // anything copied, exported or rendered as a batch lands on the same
  // timestamp. Reversing the sorted array flipped the NAME tiebreak with the
  // primary key, so "newest first" listed those files Z to A while "oldest
  // first" listed them A to Z. Finder keeps its secondary sort ascending in
  // both directions.
  const same = (name: string) =>
    ({ name, path: `/lib/${name}`, modified_ms: 1000, size_bytes: 42, kind: "video" }) as never;
  const names = (xs: readonly unknown[]) => (xs as { name: string }[]).map((x) => x.name);
  const items = [same("charlie.mov"), same("alpha.mov"), same("bravo.mov")];

  it("keeps equal-date files alphabetical in BOTH directions", () => {
    expect(names(sortLibraryItems(items, "date", "asc"))).toEqual(["alpha.mov", "bravo.mov", "charlie.mov"]);
    expect(names(sortLibraryItems(items, "date", "desc"))).toEqual(["alpha.mov", "bravo.mov", "charlie.mov"]);
  });

  it("keeps equal-size files alphabetical in BOTH directions", () => {
    expect(names(sortLibraryItems(items, "size", "asc"))).toEqual(["alpha.mov", "bravo.mov", "charlie.mov"]);
    expect(names(sortLibraryItems(items, "size", "desc"))).toEqual(["alpha.mov", "bravo.mov", "charlie.mov"]);
  });

  it("still reverses when NAME is the key being sorted", () => {
    expect(names(sortLibraryItems(items, "name", "desc"))).toEqual(["charlie.mov", "bravo.mov", "alpha.mov"]);
  });

  it("still orders by the primary key first", () => {
    const mixed = [
      { name: "b.mov", path: "/b", modified_ms: 3000, size_bytes: 1, kind: "video" },
      { name: "a.mov", path: "/a", modified_ms: 1000, size_bytes: 9, kind: "video" },
    ] as never[];
    expect(names(sortLibraryItems(mixed, "date", "desc"))).toEqual(["b.mov", "a.mov"]);
    expect(names(sortLibraryItems(mixed, "date", "asc"))).toEqual(["a.mov", "b.mov"]);
    expect(names(sortLibraryItems(mixed, "size", "desc"))).toEqual(["a.mov", "b.mov"]);
  });
});

describe("source timecodes (per-file store)", () => {
  function installLocalStorage(): void {
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() { return store.size; },
    } as Storage;
  }

  it("round-trips a well-formed TC and defaults to null", async () => {
    installLocalStorage();
    const { sourceTimecodeFor, setSourceTimecode, clearSourceTimecode } = await import("./library");
    expect(sourceTimecodeFor("/a.mp4")).toBeNull(); // starts at zero
    setSourceTimecode("/a.mp4", "01:00:00:00");
    expect(sourceTimecodeFor("/a.mp4")).toBe("01:00:00:00");
    clearSourceTimecode("/a.mp4");
    expect(sourceTimecodeFor("/a.mp4")).toBeNull();
  });

  it("accepts drop-frame (;) and rejects malformed TCs", async () => {
    installLocalStorage();
    const { sourceTimecodeFor, setSourceTimecode } = await import("./library");
    setSourceTimecode("/df.mp4", "00:59:59;29"); // drop-frame separator
    expect(sourceTimecodeFor("/df.mp4")).toBe("00:59:59;29");
    setSourceTimecode("/bad.mp4", "1:2:3");        // not HH:MM:SS:FF
    setSourceTimecode("/bad2.mp4", "garbage");
    expect(sourceTimecodeFor("/bad.mp4")).toBeNull();
    expect(sourceTimecodeFor("/bad2.mp4")).toBeNull();
  });

  it("survives a corrupt blob (junk-tolerant load)", async () => {
    installLocalStorage();
    localStorage.setItem("saucebunny.sourceTimecodes", '{"/x.mp4": 12345, "/y.mp4": "02:00:00:00"}');
    const { sourceTimecodeFor } = await import("./library");
    expect(sourceTimecodeFor("/x.mp4")).toBeNull();  // non-string dropped
    expect(sourceTimecodeFor("/y.mp4")).toBe("02:00:00:00");
  });
});
