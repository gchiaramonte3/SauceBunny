import { describe, expect, it } from "vitest";
import {
  cueAtOffset, groupHits, indexTranscript, normalizeForSearch, searchTranscripts,
} from "./transcript-search";
import type { Cue } from "./srt";

/**
 * The test that matters is the straddling one. Whisper breaks cues at 84
 * characters, mid-phrase, so a per-cue search loses any quote that spans a
 * break — and loses it SILENTLY, which is how a search stops being trusted.
 */

let n = 0;
const cue = (text: string, start: number, speaker?: string): Cue => ({
  index: n++, start, end: start + 3, text, speaker: speaker ?? null,
} as Cue);

const idx = (cues: Cue[], path = "/t/a.srt", title = "A") =>
  indexTranscript(path, title, cues);

describe("straddling a cue boundary", () => {
  // The exact shape Whisper produces: one sentence, cut at a fixed width.
  const cues = [
    cue("I think we should have led", 10),
    cue("with that, honestly.", 13),
  ];

  it("finds a phrase that spans two cues", () => {
    const hits = searchTranscripts([idx(cues)], "led with that");
    expect(hits).toHaveLength(1);
  });

  it("reports it at the cue where it STARTS, so seeking plays the whole line", () => {
    const [h] = searchTranscripts([idx(cues)], "led with that");
    expect(h.cueIndex).toBe(0);
    expect(h.start).toBe(10);
  });

  it("still finds phrases wholly inside one cue", () => {
    expect(searchTranscripts([idx(cues)], "honestly")).toHaveLength(1);
    expect(searchTranscripts([idx(cues)], "I think")).toHaveLength(1);
  });

  it("does not invent a match across a gap that isn't there", () => {
    expect(searchTranscripts([idx(cues)], "led withthat")).toHaveLength(0);
    expect(searchTranscripts([idx(cues)], "should have said")).toHaveLength(0);
  });

  it("spans THREE cues when the phrase is long enough", () => {
    const three = [cue("one two", 0), cue("three four", 3), cue("five six", 6)];
    const hits = searchTranscripts([idx(three)], "two three four five");
    expect(hits).toHaveLength(1);
    expect(hits[0].cueIndex).toBe(0);
  });
});

describe("normalisation", () => {
  it("matches a typed apostrophe against the model's curly one", () => {
    const c = [cue("we can’t ship that", 5)];
    expect(searchTranscripts([idx(c)], "can't ship")).toHaveLength(1);
  });

  it("is case-insensitive both ways", () => {
    const c = [cue("The Reunion Special", 0)];
    expect(searchTranscripts([idx(c)], "reunion")).toHaveLength(1);
    expect(searchTranscripts([idx(c)], "REUNION")).toHaveLength(1);
  });

  it("folds smart quotes and dashes", () => {
    const c = [cue("a “quote” and an — aside", 0)];
    expect(searchTranscripts([idx(c)], '"quote"')).toHaveLength(1);
    expect(searchTranscripts([idx(c)], "an - aside")).toHaveLength(1);
  });

  it("PRESERVES LENGTH, which is what keeps offsets honest", () => {
    // Load-bearing: every offset in the index addresses the normalised text.
    // A rule that dropped or added a character would shift every match after
    // it, and highlights would drift further the longer the transcript.
    for (const s of ["plain", "we’re “here” — now", "MiXeD CaSe", "a b"]) {
      expect(normalizeForSearch(s), s).toHaveLength(s.length);
    }
  });
});

describe("offset mapping", () => {
  const cues = [cue("alpha", 0), cue("bravo", 3), cue("charlie", 6)];
  const t = idx(cues);

  it("resolves an offset to the cue containing it", () => {
    expect(cueAtOffset(t, 0)).toBe(0);              // "alpha"
    expect(cueAtOffset(t, 6)).toBe(1);              // "bravo"
    expect(cueAtOffset(t, t.text.length - 1)).toBe(2);
  });

  it("puts the JOIN SPACE with the cue already open", () => {
    // "alpha bravo" — offset 5 is the join. A match landing there belongs to
    // the cue that was being spoken, not the one about to start.
    expect(cueAtOffset(t, 5)).toBe(0);
  });

  it("survives an empty transcript", () => {
    expect(cueAtOffset(idx([]), 0)).toBe(-1);
    expect(searchTranscripts([idx([])], "anything")).toEqual([]);
  });

  it("gives a highlight range inside the cue's own text", () => {
    const [h] = searchTranscripts([idx([cue("find the needle here", 0)])], "needle");
    expect(h.text.slice(h.matchStart, h.matchEnd)).toBe("needle");
  });
});

describe("across many transcripts", () => {
  const a = idx([cue("shared word here", 0)], "/t/a.srt", "Episode A");
  const b = idx([cue("another shared line", 0), cue("and shared again", 9)], "/t/b.srt", "Episode B");

  it("searches all of them", () => {
    expect(searchTranscripts([a, b], "shared")).toHaveLength(3);
  });

  it("keeps the caller's transcript order, then time within each", () => {
    const hits = searchTranscripts([a, b], "shared");
    expect(hits.map((h) => h.title)).toEqual(["Episode A", "Episode B", "Episode B"]);
    expect(hits[1].start).toBeLessThan(hits[2].start);
  });

  it("groups into sources for the result list", () => {
    const g = groupHits(searchTranscripts([a, b], "shared"));
    expect(g.map((x) => x.title)).toEqual(["Episode A", "Episode B"]);
    expect(g[1].hits).toHaveLength(2);
  });

  it("honours the limit rather than returning the whole library", () => {
    const many = Array.from({ length: 50 }, (_, i) => cue("repeat repeat", i));
    expect(searchTranscripts([idx(many)], "repeat", 10)).toHaveLength(10);
  });
});

describe("what is deliberately not a search", () => {
  it("ignores a query of under two characters", () => {
    // One character matches most of the library; showing that is noise, not a
    // result set.
    const c = [cue("a b c d e", 0)];
    expect(searchTranscripts([idx(c)], "a")).toEqual([]);
    expect(searchTranscripts([idx(c)], " ")).toEqual([]);
    expect(searchTranscripts([idx(c)], "")).toEqual([]);
  });

  it("finds repeated matches in one cue without double-counting overlaps", () => {
    const c = [cue("aaaa", 0)];
    // "aa" appears at 0 and 2 when advancing past each match — not 3 times.
    expect(searchTranscripts([idx(c)], "aa")).toHaveLength(2);
  });

  it("carries the speaker through when the transcript has one", () => {
    const c = [cue("that is the line", 0, "Harry")];
    expect(searchTranscripts([idx(c)], "the line")[0].speaker).toBe("Harry");
  });
});
