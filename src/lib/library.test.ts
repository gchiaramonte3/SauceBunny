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
  searchTruncationNote,
  unscannedDepthNote,
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
  deeper = false,
): LibraryFolder {
  return { name, path, folders, items, deeper };
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

  it("caps folder results but reports the true total", () => {
    // The mirror of the test above, which did not exist - and its absence is
    // why folders capped INSIDE the match condition for so long. Past the cap
    // a matching folder was not counted, not shown, and not reported.
    const subs = Array.from({ length: 10 }, (_, i) => folder(`take-${i}`, [], [], `/lib/Bulk/take-${i}`));
    const r = searchLibrary([folder("Bulk", [], subs, "/lib/Bulk")], "take", { folders: 4 });
    expect(r.folders).toHaveLength(4);
    expect(r.totalFolders).toBe(10);
  });

  it("counts every match even when both kinds overflow", () => {
    const subs = Array.from({ length: 6 }, (_, i) => folder(`take-${i}`, [], [], `/lib/B/take-${i}`));
    const items = Array.from({ length: 7 }, (_, i) => item(`take-${i}.mp4`));
    const r = searchLibrary([folder("B", items, subs, "/lib/B")], "take", { items: 2, folders: 3 });
    expect([r.folders.length, r.totalFolders, r.items.length, r.totalItems]).toEqual([3, 6, 2, 7]);
  });

  it("returns nothing for an empty/whitespace query", () => {
    const r = searchLibrary(trees, "   ");
    expect(r.items).toEqual([]);
    expect(r.folders).toEqual([]);
  });
});

describe("searchLibrary and macOS filename encoding", () => {
  // APFS stores filenames DECOMPOSED. A keyboard sends PRECOMPOSED. The two
  // render identically, so before this the user typed the name they could see
  // and the file did not come back.
  const NFD = "caf\u0065\u0301 interview.mov";   // e + combining acute, as on disk
  const NFC = "caf\u00e9";                        // precomposed, as typed
  const tree = {
    name: "Root", path: "/root", folders: [],
    items: [{ name: NFD, path: `/root/${NFD}`, modified_ms: 1, size_bytes: 1, kind: "video" }],
  } as never;

  it("finds a decomposed filename from a precomposed query", () => {
    expect(NFD).not.toBe(NFD.normalize("NFC")); // the fixture really is decomposed
    const r = searchLibrary([tree], NFC);
    expect(r.items).toHaveLength(1);
    expect(r.totalItems).toBe(1);
  });

  it("works the other way round too", () => {
    const nfcTree = {
      name: "Root", path: "/root", folders: [],
      items: [{ name: NFD.normalize("NFC"), path: "/root/x", modified_ms: 1, size_bytes: 1, kind: "video" }],
    } as never;
    expect(searchLibrary([nfcTree], NFC.normalize("NFD")).items).toHaveLength(1);
  });

  it("matches a decomposed FOLDER name too", () => {
    const folderTree = {
      name: "Root", path: "/root", items: [],
      folders: [{ name: NFD, path: `/root/${NFD}`, folders: [], items: [] }],
    } as never;
    expect(searchLibrary([folderTree], NFC).folders).toHaveLength(1);
  });

  it("does NOT fold accents away, which would break other scripts", () => {
    // Deliberate: stripping diacritics would make "cafe" match "café", and it
    // would also make か match が, which is a different word. Normalising is a
    // bug fix; folding is a product decision.
    expect(searchLibrary([tree], "cafe").items).toHaveLength(0);
    const kana = {
      name: "Root", path: "/root", folders: [],
      items: [{ name: "\u304c.mov", path: "/root/ga", modified_ms: 1, size_bytes: 1, kind: "video" }],
    } as never;
    expect(searchLibrary([kana], "\u304b").items).toHaveLength(0); // か must not match が
    expect(searchLibrary([kana], "\u304c").items).toHaveLength(1); // が finds itself
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

describe("searchTruncationNote", () => {
  const r = (folders: number, totalFolders: number, items: number, totalItems: number) => ({
    folders: Array.from({ length: folders }, () => ({ folder: folder("f"), chain: [] })),
    items: Array.from({ length: items }, (_, i) => item(`i-${i}.mp4`)),
    totalFolders, totalItems,
  });

  it("says nothing when everything fits", () => {
    expect(searchTruncationNote(r(3, 3, 5, 5))).toBe(null);
    expect(searchTruncationNote(r(0, 0, 0, 0))).toBe(null);
  });

  it("reports folders alone, which the old view could not", () => {
    // Forty folders and three files used to show thirty folders in silence:
    // the note was gated on items overflowing.
    expect(searchTruncationNote(r(30, 47, 3, 3)))
      .toBe("Showing 30 of 47 folders. Narrow the search to see the rest.");
  });

  it("reports files alone", () => {
    expect(searchTruncationNote(r(2, 2, 120, 340)))
      .toBe("Showing 120 of 340 files. Narrow the search to see the rest.");
  });

  it("reports both in one sentence", () => {
    expect(searchTruncationNote(r(30, 47, 120, 340)))
      .toBe("Showing 30 of 47 folders and 120 of 340 files. Narrow the search to see the rest.");
  });

  it("tells the reader what to do about it", () => {
    // A count with no next step says "you are missing results" and stops.
    expect(searchTruncationNote(r(30, 47, 3, 3))).toContain("Narrow the search");
  });
});

describe("unscannedDepthNote", () => {
  it("says nothing when the scan reached everything", () => {
    expect(unscannedDepthNote([folder("root", [], [folder("sub")])])).toBe(null);
    expect(unscannedDepthNote([])).toBe(null);
  });

  it("reports a folder the scan stopped short of", () => {
    // Without this the folder renders as empty, which is indistinguishable
    // from a folder that really has nothing in it.
    const deep = folder("Camera A", [], [], "/lib/Camera A", true);
    const note = unscannedDepthNote([folder("Footage", [], [deep])]);
    expect(note).toContain("One folder goes");
    expect(note).toContain("library root");
  });

  it("counts them, however deep they are nested", () => {
    const a = folder("A", [], [], "/lib/A", true);
    const b = folder("B", [], [], "/lib/B", true);
    const note = unscannedDepthNote([folder("root", [], [a, folder("mid", [], [b])])]);
    expect(note).toContain("2 folders go");
  });

  it("tells the reader what to do about it", () => {
    const deep = folder("X", [], [], "/lib/X", true);
    expect(unscannedDepthNote([deep])).toContain("Add the inner folder");
  });
});
