// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LibraryOrganization } from "./library-organization";

/**
 * Moving a folder moves the app's records with it (docs/RECONNECT-MEDIA-SPEC-2026-10-05.md, 1c).
 *
 * About twenty records key a file by its absolute path, and every one of them
 * detaches silently when its folder moves: the poster, the timecode, the marks
 * and the Continue entry are still saved, under a path nothing will ask for
 * again. This seeds each store with a record under the old folder and one
 * beside it, moves the folder, and checks every record followed and the
 * neighbour did not.
 */
const h = vi.hoisted(() => ({ organization: null as null | ((path: string) => string | null) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => "" }));
vi.mock("./library-organization-store", () => ({
  libraryOrganization: { movePaths: async (move: (path: string) => string | null) => { h.organization = move; } },
}));

const { movedPath, moveKeys, moveList, moveRecents, moveQueue, moveStoredPaths, PATHS_MOVED_EVENT } = await import("./relink");
const { moveOrganizationPaths } = await import("./library-organization");
const from = "/Volumes/NEXIS/Show/Test", to = "/Volumes/NEXIS 1/Show/Test";
const inside = `${from}/Day 3/A001.mov`, moved = `${to}/Day 3/A001.mov`, neighbour = "/Volumes/NEXIS/Show/Testing/A002.mov";
afterEach(() => { localStorage.clear(); h.organization = null; });

describe("which paths a folder move takes with it", () => {
  it("moves the folder and what is under it, at a separator, whatever the Unicode spelling", () => {
    expect(movedPath(inside, from, to)).toBe(moved);
    expect(movedPath(from, from, to)).toBe(to);
    expect(movedPath(neighbour, from, to), "a sibling that shares a prefix moved").toBeNull();
    expect(movedPath(`${from}/`, `${from}/`, `${to}/`)).toBe(to);
    const decomposed = "/Users/editor/Café/clip.mov";
    expect(movedPath(decomposed, "/Users/editor/Café", "/Users/editor/Done")).toBe("/Users/editor/Done/clip.mov");
    expect(movedPath(inside, from, from)).toBeNull();
    expect(movedPath(inside, "relative", to)).toBeNull();
  });

  it("returns the same record when nothing moved, so nothing is written", () => {
    const map = { [neighbour]: 1 };
    expect(moveKeys(map, from, to)).toBe(map);
    const list = [neighbour];
    expect(moveList(list, from, to)).toBe(list);
    expect(moveKeys({ [inside]: 1, [neighbour]: 2 }, from, to)).toEqual({ [moved]: 1, [neighbour]: 2 });
  });

  it("moves Continue and the clip queue, leaving web sources alone", () => {
    const recents = [{ kind: "file" as const, value: inside, title: "A001", lastOpenedAt: 1 },
      { kind: "url" as const, value: "https://example.com/v", title: "Web", lastOpenedAt: 2 }];
    expect(moveRecents(recents, from, to).map((entry) => entry.value)).toEqual([moved, "https://example.com/v"]);
    const queue = [{ id: "q", source: { kind: "file" as const, path: inside }, fps: 24, title: "A001", thumbnail: null, inFrames: 0, outFrames: 10 }];
    expect(moveQueue(queue as Parameters<typeof moveQueue>[0], from, to)[0].source).toEqual({ kind: "file", path: moved });
  });

  it("moves project folder files and disk Favorites, not web items", () => {
    const data: LibraryOrganization = { version: 1, folders: [],
      assets: [{ id: "a", kind: "file", locator: inside, title: "A001.mov" }, { id: "w", kind: "web", locator: "https://example.com", title: "Web" }],
      favorites: [{ id: "f", kind: "disk", target: `${from}/Day 3`, name: "Day 3" }] };
    const next = moveOrganizationPaths(data, (path) => movedPath(path, from, to));
    expect(next.assets.map((a) => a.locator)).toEqual([moved, "https://example.com"]);
    expect(next.favorites[0].target).toBe(`${to}/Day 3`);
    expect(moveOrganizationPaths(data, () => null)).toBe(data);
  });
});

describe("moveStoredPaths", () => {
  it("moves every stored record under the folder, and only those", () => {
    const set = (key: string, value: unknown) => localStorage.setItem(key, JSON.stringify(value));
    set("saucebunny.libraryThumbTimes", { [inside]: 4.5, [neighbour]: 2 });
    set("saucebunny.sourceTimecodes", { [inside]: "01:00:00:00" });
    set("saucebunny.sourceMarks", { [inside]: { inFrames: 10, outFrames: 20 } });
    set("saucebunny.libraryHidden", [inside, neighbour]);
    set(`saucebunny.chapters.${inside}`, [{ time: 1, title: "Open" }]);
    set(`saucebunny.cutMarkers.${neighbour}`, [1]);
    set("saucebunny.transcriptHistory", [{ id: "t", srtPath: "/Users/editor/Documents/Sauce Bunny/Transcripts/A001.srt", sourcePath: inside,
      sourceUrl: null, title: "A001", origin: "whisper", createdAt: 1, lastOpenedAt: 1 }]);
    set("saucebunny.review.receivedAs", { [inside]: "review-key" });
    set("saucebunny.review.history", [{ key: "review-key", title: "A001", path: inside, updatedAt: 1, count: 2 }]);
    const events: unknown[] = [];
    const listener = (event: Event) => events.push((event as CustomEvent).detail);
    window.addEventListener(PATHS_MOVED_EVENT, listener);
    moveStoredPaths(from, to);
    window.removeEventListener(PATHS_MOVED_EVENT, listener);
    const get = (key: string) => JSON.parse(localStorage.getItem(key) ?? "null");
    expect(get("saucebunny.libraryThumbTimes")).toEqual({ [moved]: 4.5, [neighbour]: 2 });
    expect(get("saucebunny.sourceTimecodes")).toEqual({ [moved]: "01:00:00:00" });
    expect(Object.keys(get("saucebunny.sourceMarks"))).toEqual([moved]);
    expect([...get("saucebunny.libraryHidden")].sort()).toEqual([neighbour, moved].sort());
    expect(get(`saucebunny.chapters.${moved}`)).toEqual([{ time: 1, title: "Open" }]);
    expect(localStorage.getItem(`saucebunny.chapters.${inside}`)).toBeNull();
    expect(get(`saucebunny.cutMarkers.${neighbour}`), "a neighbour's record moved").toEqual([1]);
    expect(get("saucebunny.transcriptHistory")[0].sourcePath).toBe(moved);
    expect(get("saucebunny.review.receivedAs")).toEqual({ [moved]: "review-key" });
    expect(get("saucebunny.review.history")[0]).toMatchObject({ key: "review-key", path: moved });
    expect(h.organization?.(inside), "project folders were not told").toBe(moved);
    expect(events, "component-held records (Continue, queue, columns, tree) were not told").toEqual([{ from, to }]);
  });
});

describe("reconnecting files", () => {
  it("learns a folder move only from a file whose name did not change, and never moves the file itself twice", async () => {
    const { othersThatMoved } = await import("./relink");
    const known = [inside, `${from}/Day 3/A002.mov`, `${from}/Day 4/B001.mov`, neighbour];
    expect(othersThatMoved(inside, moved, known)).toEqual([[`${from}/Day 3/A002.mov`, `${to}/Day 3/A002.mov`]]);
    expect(othersThatMoved(inside, `${to}/Day 3/A001_v2.mov`, known), "a renamed file taught a folder move").toEqual([]);
    expect(othersThatMoved(inside, inside, known)).toEqual([]);
  });

  it("finds every stored path under a folder, from the stores and from component state", async () => {
    const { storedPathsUnder } = await import("./relink");
    localStorage.setItem("saucebunny.libraryThumbTimes", JSON.stringify({ [inside]: 1 }));
    localStorage.setItem("saucebunny.sourceMarks", JSON.stringify({ [`${from}/Day 3/A002.mov`]: { inFrames: 1, outFrames: 9 } }));
    expect(storedPathsUnder(`${from}/Day 3`, [`${from}/Day 3/A003.mov`, neighbour]).sort())
      .toEqual([inside, `${from}/Day 3/A002.mov`, `${from}/Day 3/A003.mov`].sort());
  });

  it("reconnects as one undo, and undo puts every record back", async () => {
    const { reconnectFiles } = await import("./relink");
    const { appUndo } = await import("./undo");
    localStorage.setItem("saucebunny.libraryThumbTimes", JSON.stringify({ [inside]: 1, [`${from}/Day 3/A002.mov`]: 2 }));
    reconnectFiles([[inside, moved], [`${from}/Day 3/A002.mov`, `${to}/Day 3/A002.mov`]]);
    const posters = () => JSON.parse(localStorage.getItem("saucebunny.libraryThumbTimes") ?? "{}");
    expect(posters()).toEqual({ [moved]: 1, [`${to}/Day 3/A002.mov`]: 2 });
    expect(appUndo.undo()).toBe("reconnect 2 files");
    expect(posters()).toEqual({ [inside]: 1, [`${from}/Day 3/A002.mov`]: 2 });
  });
});
