import { describe, expect, it } from "vitest";
import { dirOf, needsRepath, repathKey, repathKeys, repathTo } from "./repath";

/**
 * Every test here is really about the same failure: a renamed clip whose
 * review, poster or timecode stayed behind on the old key. Nothing errors when
 * that happens — the notes are on disk, the clip is on disk, and they simply
 * stop finding each other, which reads as "the app lost my notes".
 */

describe("repathKey", () => {
  it("moves the value to the new key", () => {
    expect(repathKey({ "/m/a.mp4": 12 }, "/m/a.mp4", "/m/b.mp4")).toEqual({ "/m/b.mp4": 12 });
  });

  it("leaves other entries untouched", () => {
    const out = repathKey({ "/m/a.mp4": 1, "/m/z.mp4": 9 }, "/m/a.mp4", "/m/b.mp4");
    expect(out).toEqual({ "/m/b.mp4": 1, "/m/z.mp4": 9 });
  });

  it("keeps identity when the key is not there, so no write happens", () => {
    const map = { "/m/z.mp4": 9 };
    expect(repathKey(map, "/m/a.mp4", "/m/b.mp4")).toBe(map);
  });

  it("keeps identity for a no-op rename", () => {
    const map = { "/m/a.mp4": 1 };
    expect(repathKey(map, "/m/a.mp4", "/m/a.mp4")).toBe(map);
  });

  it("overwrites an entry already at the destination", () => {
    // The file at that path is being replaced by this one, so its old poster
    // is stale by definition — keeping it would show the wrong frame.
    expect(repathKey({ a: 1, b: 2 }, "a", "b")).toEqual({ b: 1 });
  });

  it("does not mutate the input", () => {
    const map = { "/m/a.mp4": 1 };
    repathKey(map, "/m/a.mp4", "/m/b.mp4");
    expect(map).toEqual({ "/m/a.mp4": 1 });
  });

  it("treats a CASE-ONLY rename as a real move", () => {
    // The filesystem is case-preserving but case-insensitive, so these are one
    // file on disk. The stores are case-SENSITIVE, so they are two keys, and
    // skipping this leaves the poster behind on a key nothing will ask for.
    const out = repathKey({ "/m/clip.mp4": 5 }, "/m/clip.mp4", "/m/Clip.mp4");
    expect(out).toEqual({ "/m/Clip.mp4": 5 });
  });
});

describe("repathKeys", () => {
  it("moves a whole batch", () => {
    const out = repathKeys({ a: 1, b: 2, c: 3 }, [["a", "x"], ["b", "y"]]);
    expect(out).toEqual({ x: 1, y: 2, c: 3 });
  });

  it("survives a batch where nothing matches", () => {
    const map = { a: 1 };
    expect(repathKeys(map, [["q", "r"], ["s", "t"]])).toBe(map);
  });

  it("handles a swap through a temporary, in the order given", () => {
    // a -> tmp, b -> a, tmp -> b. Applying in order is what makes this land.
    const out = repathKeys({ a: 1, b: 2 }, [["a", "tmp"], ["b", "a"], ["tmp", "b"]]);
    expect(out).toEqual({ a: 2, b: 1 });
  });
});

describe("path building", () => {
  it("keeps the file in its own folder", () => {
    expect(repathTo("/Users/me/Clips/a.mp4", "b.mp4")).toBe("/Users/me/Clips/b.mp4");
  });

  it("handles a bare filename with no folder", () => {
    expect(dirOf("a.mp4")).toBe("");
    expect(repathTo("a.mp4", "b.mp4")).toBe("b.mp4");
  });

  it("keeps a folder name containing dots", () => {
    expect(repathTo("/m/v1.2/a.mp4", "b.mp4")).toBe("/m/v1.2/b.mp4");
  });
});

describe("needsRepath", () => {
  it("is false for a rename that changes nothing", () => {
    expect(needsRepath("/m/a.mp4", "/m/a.mp4")).toBe(false);
  });

  it("is TRUE for a case-only change", () => {
    expect(needsRepath("/m/a.mp4", "/m/A.mp4")).toBe(true);
  });
});
