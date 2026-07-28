// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { adoptSourceChapters, loadChapters, saveChapters } from "./chapters";

const KEY = "https://example.com/watch?v=abc";

beforeEach(() => localStorage.clear());

describe("adoptSourceChapters", () => {
  it("takes the creator's chapters when there are none stored", () => {
    // The point: yt-dlp had these in a probe the app already ran, while the
    // app was inferring chapters from the transcript with an LLM.
    const wrote = adoptSourceChapters(KEY, [
      { time: 0, title: "Cold open" },
      { time: 61, title: "The interview" },
    ]);
    expect(wrote).toBe(true);
    expect(loadChapters(KEY).map((c) => c.title)).toEqual(["Cold open", "The interview"]);
  });

  it("NEVER overwrites chapters that already exist", () => {
    // Chapters are editable and this runs on every metadata arrival, so
    // re-opening a source must not undo a rename or a deletion.
    saveChapters(KEY, [{ time: 5, title: "My own title" }]);
    const wrote = adoptSourceChapters(KEY, [{ time: 0, title: "Site title" }]);
    expect(wrote).toBe(false);
    expect(loadChapters(KEY)).toEqual([{ time: 5, title: "My own title" }]);
  });

  it("sorts what the site sent", () => {
    adoptSourceChapters(KEY, [
      { time: 90, title: "Second" },
      { time: 10, title: "First" },
    ]);
    expect(loadChapters(KEY).map((c) => c.title)).toEqual(["First", "Second"]);
  });

  it("drops malformed entries rather than repairing them", () => {
    // A marker in the wrong place is worse than one marker fewer.
    adoptSourceChapters(KEY, [
      { time: 10, title: "Good" },
      { time: 20, title: "   " },
      { time: -1, title: "Negative" },
      { time: Number.NaN, title: "NaN" },
      { time: Infinity, title: "Infinite" },
    ] as { time: number; title: string }[]);
    expect(loadChapters(KEY).map((c) => c.title)).toEqual(["Good"]);
  });

  it("writes nothing at all when every entry is unusable", () => {
    // …so the LLM fallback still has an empty store to fill.
    const wrote = adoptSourceChapters(KEY, [{ time: -1, title: "" }]);
    expect(wrote).toBe(false);
    expect(loadChapters(KEY)).toEqual([]);
  });

  it("is a no-op for a source that publishes none", () => {
    // The common case for most of the web, and what keeps the LLM path alive.
    expect(adoptSourceChapters(KEY, [])).toBe(false);
    expect(adoptSourceChapters(KEY, null)).toBe(false);
    expect(adoptSourceChapters(KEY, undefined)).toBe(false);
    expect(adoptSourceChapters(null, [{ time: 0, title: "x" }])).toBe(false);
  });

  it("trims the titles the site sent", () => {
    adoptSourceChapters(KEY, [{ time: 0, title: "  Cold open  " }]);
    expect(loadChapters(KEY)[0].title).toBe("Cold open");
  });
});
