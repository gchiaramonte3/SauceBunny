// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearHistory, findForSource, getHistory, recordTranscript,
  removeEntry, renameEntryPath, renameSourcePath, touchEntry,
} from "./transcript-history";

/**
 * The transcript history: 271 lines, eleven exports, persisted user data — and
 * no test. Nothing here was broken; what was missing was any check on the
 * invariants that lose or duplicate somebody's work quietly.
 *
 * Three of them matter more than the rest:
 *
 *  · De-dup, because the whole point is that re-transcribing a source updates
 *    its row instead of growing a second one. Get the key wrong in one
 *    direction and the list fills with duplicates; wrong in the other and two
 *    unrelated transcripts merge and one disappears.
 *  · The 50-entry cap, because it decides WHICH entry is thrown away. Evicting
 *    by insertion order rather than by last-opened would discard the file
 *    someone uses daily.
 *  · Surviving corrupt storage, because this module is read on every render of
 *    the history popover and one malformed row must not take the panel down.
 */

const KEY = "saucebunny.transcriptHistory";

const rec = (over: Partial<Parameters<typeof recordTranscript>[0]> = {}) =>
  recordTranscript({
    srtPath: "/T/a.srt", sourcePath: "/M/a.mov", sourceUrl: null,
    title: "A", origin: "whisper", ...over,
  });

beforeEach(() => localStorage.clear());

describe("de-duplication", () => {
  it("updates in place when the same SRT is recorded again", () => {
    const first = rec();
    const again = rec({ title: "A (renamed)" });
    expect(getHistory()).toHaveLength(1);
    expect(again.id).toBe(first.id);
    expect(getHistory()[0].title).toBe("A (renamed)");
  });

  it("updates the same row when one source yields a NEW srt", () => {
    // Re-Generate with a different model writes a different .srt. That is the
    // same piece of work, not a second one.
    rec({ srtPath: "/T/a.srt" });
    rec({ srtPath: "/T/a-large-v3.srt" });
    const all = getHistory();
    expect(all).toHaveLength(1);
    expect(all[0].srtPath).toBe("/T/a-large-v3.srt");
  });

  it("matches a web source on its URL", () => {
    rec({ srtPath: "/T/x.srt", sourcePath: null, sourceUrl: "https://y.tld/1" });
    rec({ srtPath: "/T/x2.srt", sourcePath: null, sourceUrl: "https://y.tld/1" });
    expect(getHistory()).toHaveLength(1);
  });

  it("does NOT merge two sources that merely both lack a path", () => {
    // The guard that makes the above safe: a null field must not match another
    // null field, or every pathless entry would collapse into one row.
    rec({ srtPath: "/T/one.srt", sourcePath: null, sourceUrl: null, title: "One" });
    rec({ srtPath: "/T/two.srt", sourcePath: null, sourceUrl: null, title: "Two" });
    expect(getHistory().map((e) => e.title).sort()).toEqual(["One", "Two"]);
  });

  it("keeps different sources apart", () => {
    rec({ srtPath: "/T/a.srt", sourcePath: "/M/a.mov" });
    rec({ srtPath: "/T/b.srt", sourcePath: "/M/b.mov", title: "B" });
    expect(getHistory()).toHaveLength(2);
  });
});

describe("the 50-entry cap", () => {
  it("keeps the most recently opened, not the most recently added", () => {
    // Fill past the cap, then prove the survivor set is chosen by
    // lastOpenedAt. An entry touched moments ago must outlive newer ones.
    for (let i = 0; i < 50; i++) {
      rec({ srtPath: `/T/${i}.srt`, sourcePath: `/M/${i}.mov`, title: `#${i}` });
    }
    expect(getHistory()).toHaveLength(50);

    const oldest = getHistory()[49];
    touchEntry(oldest.id);                       // now the newest by use
    rec({ srtPath: "/T/new.srt", sourcePath: "/M/new.mov", title: "NEW" });

    const titles = getHistory().map((e) => e.title);
    expect(titles).toHaveLength(50);
    expect(titles, "the freshly added entry was dropped").toContain("NEW");
    expect(titles, "a just-opened entry was evicted in favour of older ones")
      .toContain(oldest.title);
  });

  it("never grows past the cap however many are added", () => {
    for (let i = 0; i < 120; i++) {
      rec({ srtPath: `/T/${i}.srt`, sourcePath: `/M/${i}.mov`, title: `#${i}` });
    }
    expect(getHistory()).toHaveLength(50);
  });
});

describe("ordering", () => {
  it("returns newest-used first", () => {
    rec({ srtPath: "/T/a.srt", sourcePath: "/M/a.mov", title: "A" });
    rec({ srtPath: "/T/b.srt", sourcePath: "/M/b.mov", title: "B" });
    const first = getHistory().find((e) => e.title === "A")!;
    touchEntry(first.id);
    expect(getHistory()[0].title).toBe("A");
  });
});

describe("renames keep an entry findable", () => {
  it("follows the source file when it moves", () => {
    // The identity problem behind the library's rename feature: after a move,
    // re-importing the file must still find its transcript.
    rec({ srtPath: "/T/a.srt", sourcePath: "/M/a.mov", title: "A" });
    renameSourcePath("/M/a.mov", "/M/renamed.mov", "Renamed");
    expect(findForSource({ sourcePath: "/M/renamed.mov" })).toBeTruthy();
    expect(findForSource({ sourcePath: "/M/a.mov" })).toBeFalsy();
  });

  it("follows the transcript file when it moves", () => {
    rec({ srtPath: "/T/a.srt", sourcePath: "/M/a.mov" });
    renameEntryPath("/T/a.srt", "/T/moved.srt");
    expect(getHistory()[0].srtPath).toBe("/T/moved.srt");
  });
});

describe("removal", () => {
  it("removes one entry and leaves the rest", () => {
    rec({ srtPath: "/T/a.srt", sourcePath: "/M/a.mov", title: "A" });
    rec({ srtPath: "/T/b.srt", sourcePath: "/M/b.mov", title: "B" });
    removeEntry(getHistory().find((e) => e.title === "A")!.id);
    expect(getHistory().map((e) => e.title)).toEqual(["B"]);
  });

  it("clears everything", () => {
    rec();
    clearHistory();
    expect(getHistory()).toEqual([]);
  });
});

describe("corrupt storage", () => {
  it("drops malformed rows instead of poisoning the popover", () => {
    // This is read on every render of the history list. One bad row from an
    // older schema must cost that row, not the panel.
    localStorage.setItem(KEY, JSON.stringify([
      { id: "ok", srtPath: "/T/a.srt", title: "A", origin: "whisper", createdAt: 1, lastOpenedAt: 2 },
      { id: "missing-fields" },
      null,
      "not an object",
      { id: 7, srtPath: "/T/b.srt", title: "B", origin: "whisper", createdAt: 1, lastOpenedAt: 2 },
    ]));
    const out = getHistory();
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("ok");
  });

  it("survives storage that is not JSON at all", () => {
    localStorage.setItem(KEY, "{not json");
    expect(getHistory()).toEqual([]);
    // And still writes cleanly over the wreckage.
    rec();
    expect(getHistory()).toHaveLength(1);
  });

  it("survives storage holding a non-array", () => {
    localStorage.setItem(KEY, JSON.stringify({ nope: true }));
    expect(getHistory()).toEqual([]);
  });
});
