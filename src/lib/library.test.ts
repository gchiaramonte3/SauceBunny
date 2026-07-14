import { describe, it, expect } from "vitest";
import type { LibraryFolder, LibraryItem } from "../types";
import {
  countLibraryItems,
  formatBytes,
  formatModifiedDate,
  libraryPosterPaths,
  resolveLibraryChain,
  sanitizeLibraryRoots,
  searchLibrary,
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

describe("resolveLibraryChain", () => {
  const sub = folder("Interviews", [item("intro.mp4")], [], "/lib/Footage/Interviews");
  const trees = [folder("Footage", [], [sub], "/lib/Footage")];

  it("walks a chain of absolute paths to the node", () => {
    const hit = resolveLibraryChain(trees, [
      { name: "Footage", path: "/lib/Footage" },
      { name: "Interviews", path: "/lib/Footage/Interviews" },
    ]);
    expect(hit).toBe(sub);
  });

  it("is null when a hop vanished (root removed / rescan changed the tree)", () => {
    expect(resolveLibraryChain(trees, [{ name: "Gone", path: "/lib/Gone" }])).toBeNull();
    expect(resolveLibraryChain(trees, [
      { name: "Footage", path: "/lib/Footage" },
      { name: "Old", path: "/lib/Footage/Old" },
    ])).toBeNull();
    expect(resolveLibraryChain(trees, [])).toBeNull();
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
