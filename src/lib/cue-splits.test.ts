import { describe, expect, it } from "vitest";
import {
  applySplits, clearSplits, fragmentAt, normalizeSplitOffsets, snapToWord, splitCue, splitKey,
  splitOrigins, splitsForRange,
} from "./cue-splits";
import { groupIntoTurns, type Cue } from "./srt";
import { cueKey, retagCues } from "../components/transcript/helpers";

const cue = (start: number, end: number, text: string, speaker: string | null = "SPEAKER_00"): Cue =>
  ({ index: 1, start, end, text, speaker });

describe("snapToWord", () => {
  it("leaves an offset already on a word boundary alone", () => {
    const t = "hello world this";
    expect(snapToWord(t, 5)).toBe(5); // end of "hello"
    expect(snapToWord(t, 6)).toBe(6); // start of "world"
  });

  it("snaps out of the middle of a word", () => {
    // "…the ma" / "n said…" is what not snapping produces, and it reads as a
    // bug even when the speaker assignment is exactly right.
    expect(snapToWord("ab cdef gh", 6)).toBe(7); // nearer the right edge
  });

  it("breaks a tie to the LEFT, keeping the whole word with the drag", () => {
    expect(snapToWord("ab cdef gh", 5)).toBe(3);
  });

  it("clamps to the text and never returns a fractional offset", () => {
    expect(snapToWord("abc", -4)).toBe(0);
    expect(snapToWord("abc", 99)).toBe(3);
    expect(snapToWord("ab cd", 2.4)).toBe(2);
  });
});

describe("normalizeSplitOffsets", () => {
  it("sorts, de-duplicates, and drops cuts that divide nothing", () => {
    const t = "one two three";
    // 0 and length are the cue's own edges; they are not cuts.
    expect(normalizeSplitOffsets(t, [7, 0, 3, 13, 3])).toEqual([3, 7]);
  });

  it("de-duplicates cuts that only COLLIDE after snapping", () => {
    // Two drags landing in the same word are one cut, not two.
    expect(normalizeSplitOffsets("ab cdef gh", [4, 5])).toEqual([3]);
  });

  it("treats the two sides of one space as ONE cut", () => {
    // 3 and 4 both snap to themselves, but the text between them is a single
    // space: kept as two cuts they mint a fragment that trims to nothing and
    // leaves a hole in the timeline.
    expect(normalizeSplitOffsets("aaa bbb", [3, 4])).toEqual([3]);
    // Across a run of spaces the first offer wins, and it does not matter
    // which: every offset in one gap divides the text the same way, and the
    // true boundary is somewhere inside that silence either way.
    expect(normalizeSplitOffsets("aaa   bbb", [6, 3])).toEqual([6]);
    expect(splitCue(cue(0, 4, "aaa   bbb"), [6]).map((c) => c.text))
      .toEqual(splitCue(cue(0, 4, "aaa   bbb"), [3]).map((c) => c.text));
  });

  it("ignores garbage rather than emitting NaN offsets", () => {
    expect(normalizeSplitOffsets("one two", [Number.NaN, Infinity, 3])).toEqual([3]);
  });
});

describe("splitCue", () => {
  it("returns the cue untouched when there is nothing to cut", () => {
    const c = cue(10, 14, "hello world");
    expect(splitCue(c, [])).toEqual([c]);
    expect(splitCue(c, [0, 11])).toEqual([c]); // both offsets are edges
  });

  it("interpolates the boundary by character position across the cue", () => {
    // 26 characters over 4 seconds; the cut at 11 is 11/26 of the way in.
    const parts = splitCue(cue(10, 14, "hello world this is a test"), [11]);
    expect(parts).toHaveLength(2);
    expect(parts[0].text).toBe("hello world");
    expect(parts[1].text).toBe("this is a test");
    expect(parts[0].start).toBe(10);
    expect(parts[0].end).toBeCloseTo(10 + (4 * 11) / 26, 6);
    expect(parts[1].start).toBe(parts[0].end); // no gap, no overlap
    expect(parts[1].end).toBe(14);
  });

  it("carries the speaker and the parent index onto every fragment", () => {
    // Splitting divides TEXT. Who said it is a separate decision, made after,
    // so that undoing a split does not also undo a reassignment.
    const parts = splitCue(cue(0, 4, "one two three four", "SPEAKER_03"), [7]);
    expect(parts.map((p) => p.speaker)).toEqual(["SPEAKER_03", "SPEAKER_03"]);
    expect(parts.every((p) => p.index === 1)).toBe(true);
  });

  it("cuts a cue into three when asked twice", () => {
    // The case the feature exists for: two phrases pulled out of one long cue.
    const parts = splitCue(cue(0, 6, "aaa bbb ccc ddd eee fff"), [7, 15]);
    expect(parts.map((p) => p.text)).toEqual(["aaa bbb", "ccc ddd", "eee fff"]);
    expect(parts[0].end).toBe(parts[1].start);
    expect(parts[1].end).toBe(parts[2].start);
  });

  it("refuses a fragment too short to be a distinct, seekable cue", () => {
    // 100ms over 8 characters. A cut at 3 leaves 37.5ms in front of it, which
    // is under a frame and would round onto its neighbour's millisecond key —
    // two fragments sharing one cueTag would make the split a lie.
    expect(splitCue(cue(0, 0.1, "ab cd ef"), [3])).toHaveLength(1);
    expect(splitCue(cue(0, 0.1, "ab cd ef"), [5])).toHaveLength(1); // tail too short
    expect(splitCue(cue(0, 1, "ab cd ef"), [3])).toHaveLength(2); // same cut, real cue
  });

  it("collapses a run of cuts that land within a frame of each other", () => {
    const t = "a b c d e f g h i j k l m n o p q r s t u v w x y z";
    const parts = splitCue(cue(0, 1, t), [1, 2, 3]);
    expect(parts).toHaveLength(2);
    expect(parts[0].text).toBe("a b");
  });

  it("survives a zero-length or empty cue instead of dividing by zero", () => {
    expect(splitCue(cue(5, 5, "one two"), [3])).toHaveLength(1);
    expect(splitCue(cue(0, 4, ""), [1])).toHaveLength(1);
    expect(splitCue(cue(0, 4, "one two"), [3]).every((p) => Number.isFinite(p.start))).toBe(true);
  });

  it("never emits a fragment with no words in it", () => {
    // A seekable cue containing nothing is worse than no split at all.
    const parts = splitCue(cue(0, 4, "one    two"), [4]);
    expect(parts.every((p) => p.text.length > 0)).toBe(true);
  });
});

describe("applySplits", () => {
  const cues = [cue(0, 4, "one two three"), cue(4, 8, "four five six")];

  it("returns the SAME array when nothing applies", () => {
    // Called unconditionally on every caption frame; it must not allocate.
    expect(applySplits(cues, undefined)).toBe(cues);
    expect(applySplits(cues, {})).toBe(cues);
    expect(applySplits(cues, { "9999": [3] })).toBe(cues); // no cue at that ms
    expect(applySplits(cues, { "0": [0] })).toBe(cues); // offset divides nothing
  });

  it("keys on the cue start in whole milliseconds", () => {
    const odd = [cue(12.3456, 16, "one two three")];
    const out = applySplits(odd, { [splitKey(12.3456)]: [3] });
    expect(out).toHaveLength(2);
    expect(splitKey(12.3456)).toBe("12346");
  });

  it("splices fragments in place and leaves every other cue alone", () => {
    const out = applySplits(cues, { "0": [7] });
    expect(out.map((c) => c.text)).toEqual(["one two", "three", "four five six"]);
    expect(out[2]).toBe(cues[1]); // untouched cues are not copied
  });
});

describe("the pipeline: parse → applySplits → retagCues → groupIntoTurns", () => {
  it("makes a sub-cue phrase addressable, then reassignable, then its own turn", () => {
    // The whole point. Whisper's -ml 84 puts the end of one person's sentence
    // and the start of another's in ONE cue, and until a fragment has its own
    // start there is no key to hang a reassignment on.
    const parsed = [cue(10, 14, "I agree completely no I do not")];

    const split = applySplits(parsed, { [splitKey(10)]: [19] });
    expect(split.map((c) => c.text)).toEqual(["I agree completely", "no I do not"]);

    // The fragment now has a millisecond key exactly like any other cue.
    const tagged = retagCues(split, { cueTag: { [cueKey(split[1].start)]: "CAST_A" } });
    expect(tagged.map((c) => c.speaker)).toEqual(["SPEAKER_00", "CAST_A"]);

    // And the turn boundary re-derives itself. No turn-splitting code needed.
    const turns = groupIntoTurns(tagged);
    expect(turns.map((t) => t.speaker)).toEqual(["SPEAKER_00", "CAST_A"]);
    expect(turns[1].cues[0].text).toBe("no I do not");
  });

  it("leaves the transcript identical when every split is removed", () => {
    const parsed = [cue(10, 14, "I agree completely no I do not")];
    const cleared = clearSplits({ [splitKey(10)]: [19] }, 10);
    expect(applySplits(parsed, cleared)).toBe(parsed);
  });
});

describe("splitsForRange", () => {
  it("turns a selected phrase into the cuts at each of its ends", () => {
    // Selecting "two three" out of "one two three four".
    expect(splitsForRange("one two three four", undefined, 4, 13)).toEqual([4, 13]);
  });

  it("ignores an end that is already the cue's own edge", () => {
    const t = "one two three";
    expect(splitsForRange(t, undefined, 0, 7)).toEqual([7]);
    expect(splitsForRange(t, undefined, 3, t.length)).toEqual([3]);
  });

  it("ADDS to the cuts a cue already has rather than replacing them", () => {
    // Pulling a second phrase out of one long cue is the case this exists for;
    // replacing would make it impossible.
    expect(splitsForRange("aaa bbb ccc ddd", [3], 8, 11)).toEqual([3, 8, 11]);
  });

  it("does not care which way the selection was dragged", () => {
    expect(splitsForRange("one two three", undefined, 7, 3))
      .toEqual(splitsForRange("one two three", undefined, 3, 7));
  });
});

describe("clearSplits", () => {
  it("drops every cut on a cue and returns the same object when there were none", () => {
    const splits = { "1000": [4], "2000": [7] };
    expect(clearSplits(splits, 1)).toEqual({ "2000": [7] });
    expect(clearSplits(splits, 9)).toBe(splits);
    expect(splits["1000"]).toEqual([4]); // input not mutated
  });
});

describe("fragmentAt", () => {
  it("finds the fragment a selected phrase became", () => {
    const c = cue(10, 14, "I agree completely no I do not");
    const frag = fragmentAt(c, [19], 19);
    expect(frag?.text).toBe("no I do not");
    expect(frag?.start).toBeCloseTo(10 + (4 * 19) / 30, 6);
  });

  it("answers from the FILTERED cuts, not the ones asked for", () => {
    // The cut at 3 is dropped for leaving a sub-frame fragment. A caller that
    // re-derived the fragment from its own offsets would point at a cue that
    // does not exist and reassign the wrong words.
    const c = cue(0, 0.1, "ab cd ef");
    expect(fragmentAt(c, [3], 4)?.text).toBe("ab cd ef");
  });

  it("returns the whole cue when nothing was cut", () => {
    expect(fragmentAt(cue(0, 4, "one two"), [], 3)?.text).toBe("one two");
  });

  it("is null past the end of the text", () => {
    expect(fragmentAt(cue(0, 4, "one two"), [3], 99)).toBeNull();
  });
});

describe("splitOrigins", () => {
  const cues = [cue(0, 4, "one two three"), cue(4, 8, "four five six")];

  it("is index-aligned with applySplits — the contract the viewer relies on", () => {
    const splits = { "0": [7] };
    const out = applySplits(cues, splits);
    const origins = splitOrigins(cues, splits);
    expect(origins).toHaveLength(out.length);
    expect(origins.map((o) => o.parent.start)).toEqual([0, 0, 4]);
  });

  it("reports the offset where each fragment begins in its PARENT", () => {
    const origins = splitOrigins([cue(0, 4, "one two three")], { "0": [7] });
    // "one two" starts at 0; "three" starts at 8 — after the space, not on it.
    expect(origins.map((o) => o.from)).toEqual([0, 8]);
  });

  it("maps a selection in a fragment back to a cut in the parent", () => {
    // THE SECOND CUT. After splitting once, the user lassos inside the second
    // fragment. Its offsets are its own; the split has to be recorded against
    // the parent or it keys on a cue that never existed.
    const parent = cue(0, 6, "aaa bbb ccc ddd");
    const splits = { [splitKey(0)]: [7] };
    const out = applySplits([parent], splits);
    const origins = splitOrigins([parent], splits);
    expect(out[1].text).toBe("ccc ddd");

    // Selecting "ddd" inside that fragment: offsets 4..7 of "ccc ddd".
    const o = origins[1];
    const next = splitsForRange(o.parent.text, splits[splitKey(0)], o.from + 4, o.from + 7);
    expect(next).toEqual([7, 12]);
    const again = applySplits([parent], { [splitKey(0)]: next });
    expect(again.map((c) => c.text)).toEqual(["aaa bbb", "ccc", "ddd"]);
    expect(fragmentAt(parent, next, o.from + 4)?.text).toBe("ddd");
  });

  it("is every cue's own parent when nothing is split", () => {
    const origins = splitOrigins(cues, {});
    expect(origins.map((o) => o.from)).toEqual([0, 0]);
    expect(origins[1].parent).toBe(cues[1]);
  });
});

describe("a cut moves the indices after it", () => {
  it("the fragment is NOT at the index that was clicked", () => {
    // The trap: an editor that right-clicks cue 1, cuts it, and then addresses
    // "the fragment" by index 1 gets the half that stayed behind. Any follow-up
    // action — naming it, reassigning it — lands on the wrong words, and only
    // when the phrase was in the second half.
    const cues = [cue(0, 4, "first line"), cue(4, 8, "I agree no I do not"), cue(8, 12, "third")];
    const splits = { [splitKey(4)]: [8] };
    const frag = fragmentAt(cues[1], [8], 8);
    expect(frag?.text).toBe("no I do not");

    const after = applySplits(cues, splits);
    expect(after[1].text).toBe("I agree"); // the clicked index is the OTHER half
    const fragIdx = after.findIndex((c) => cueKey(c.start) === cueKey(frag!.start));
    expect(fragIdx).toBe(2);
    expect(after[fragIdx].text).toBe("no I do not");
  });

  it("gives every fragment of a cut cue a distinct millisecond key", () => {
    // The lookup above is only sound because the keys do not collide — which is
    // exactly what MIN_FRAGMENT_MS protects.
    const parts = splitCue(cue(0, 6, "aaa bbb ccc ddd eee fff"), [7, 15]);
    const keys = parts.map((p) => cueKey(p.start));
    expect(new Set(keys).size).toBe(parts.length);
  });
});
