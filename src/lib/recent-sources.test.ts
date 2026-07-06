import { describe, it, expect } from "vitest";
import {
  MAX_RECENT_SOURCES,
  sanitizeRecentSources,
  removeRecent,
  upsertRecent,
  type RecentSource,
} from "./recent-sources";

function entry(value: string, lastOpenedAt: number, kind: RecentSource["kind"] = "url"): RecentSource {
  return { kind, value, title: `title of ${value}`, lastOpenedAt };
}

describe("upsertRecent", () => {
  it("prepends a new entry (most-recent-first)", () => {
    const list = [entry("a", 100), entry("b", 50)];
    const next = upsertRecent(list, { kind: "url", value: "c", title: "C", lastOpenedAt: 200 });
    expect(next.map((e) => e.value)).toEqual(["c", "a", "b"]);
  });

  it("de-dups by value — a re-open moves the entry to the front", () => {
    const list = [entry("a", 100), entry("b", 50)];
    const next = upsertRecent(list, { kind: "url", value: "b", title: "B2", lastOpenedAt: 200 });
    expect(next.map((e) => e.value)).toEqual(["b", "a"]);
    expect(next).toHaveLength(2);
    expect(next[0].title).toBe("B2");
    expect(next[0].lastOpenedAt).toBe(200);
  });

  it("keeps prior title/duration when the fresh load lacks them", () => {
    const list = [{ ...entry("a", 100), durationSeconds: 90 }];
    const next = upsertRecent(list, { kind: "url", value: "a", title: "", lastOpenedAt: 200 });
    expect(next[0].title).toBe("title of a");
    expect(next[0].durationSeconds).toBe(90);
  });

  it("falls back to the value when there is no title at all", () => {
    const next = upsertRecent([], { kind: "file", value: "/x/y.mp4", title: "", lastOpenedAt: 1 });
    expect(next[0].title).toBe("/x/y.mp4");
  });

  it("caps at MAX_RECENT_SOURCES, evicting the oldest (tail)", () => {
    let list: RecentSource[] = [];
    for (let i = 0; i < MAX_RECENT_SOURCES + 3; i++) {
      list = upsertRecent(list, { kind: "url", value: `v${i}`, title: `t${i}`, lastOpenedAt: i });
    }
    expect(list).toHaveLength(MAX_RECENT_SOURCES);
    expect(list[0].value).toBe(`v${MAX_RECENT_SOURCES + 2}`);
    expect(list.some((e) => e.value === "v0")).toBe(false);
    expect(list.some((e) => e.value === "v2")).toBe(false);
  });

  it("stamps lastOpenedAt with Date.now() when omitted", () => {
    const before = Date.now();
    const next = upsertRecent([], { kind: "url", value: "a", title: "A" });
    expect(next[0].lastOpenedAt).toBeGreaterThanOrEqual(before);
    expect(next[0].lastOpenedAt).toBeLessThanOrEqual(Date.now());
  });

  it("does not mutate the input list", () => {
    const list = [entry("a", 100)];
    upsertRecent(list, { kind: "url", value: "b", title: "B", lastOpenedAt: 200 });
    expect(list.map((e) => e.value)).toEqual(["a"]);
  });
});

describe("removeRecent", () => {
  it("removes by value and leaves others in order", () => {
    const list = [entry("a", 300), entry("b", 200), entry("c", 100)];
    expect(removeRecent(list, "b").map((e) => e.value)).toEqual(["a", "c"]);
  });

  it("is a no-op for an unknown value", () => {
    const list = [entry("a", 100)];
    expect(removeRecent(list, "zzz")).toEqual(list);
  });
});

describe("sanitizeRecentSources", () => {
  it("returns [] for junk input", () => {
    expect(sanitizeRecentSources(null)).toEqual([]);
    expect(sanitizeRecentSources("nope")).toEqual([]);
    expect(sanitizeRecentSources({ a: 1 })).toEqual([]);
    expect(sanitizeRecentSources(42)).toEqual([]);
  });

  it("drops malformed entries and keeps valid ones", () => {
    const raw = [
      entry("good", 10),
      { kind: "url", value: "", title: "empty value", lastOpenedAt: 5 },
      { kind: "torrent", value: "bad-kind", title: "t", lastOpenedAt: 5 },
      { kind: "file", value: "/f.mp4", lastOpenedAt: 5 }, // missing title
      { kind: "file", value: "/g.mp4", title: "g", lastOpenedAt: "soon" },
      { kind: "file", value: "/h.mp4", title: "h", lastOpenedAt: 5, durationSeconds: "90" },
      null,
      "string",
    ];
    const out = sanitizeRecentSources(raw);
    expect(out.map((e) => e.value)).toEqual(["good"]);
  });

  it("sorts newest-first and de-dups by value (first wins)", () => {
    const out = sanitizeRecentSources([
      entry("old", 10),
      entry("new", 30),
      { ...entry("old", 20), title: "dupe" },
      entry("mid", 20),
    ]);
    expect(out.map((e) => e.value)).toEqual(["new", "mid", "old"]);
    expect(out.find((e) => e.value === "old")!.title).toBe("title of old");
  });

  it("caps an oversized persisted list", () => {
    const raw = Array.from({ length: 40 }, (_, i) => entry(`v${i}`, i));
    const out = sanitizeRecentSources(raw);
    expect(out).toHaveLength(MAX_RECENT_SOURCES);
    expect(out[0].value).toBe("v39");
  });
});
