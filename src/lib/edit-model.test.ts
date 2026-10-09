import { describe, expect, it } from "vitest";
import {
  addEdit, clipAround, extractProgram, findDeadSpace, insertGap, isGap, liftLayers, liftProgram, removeDeadSpace, GAP, deleteWords as deleteKeys, ghostLines, moveParagraph, muteWords, paragraphs, placeWords, placementKey, programDuration, programToSource,
  addCut, healSeam, laneClips, layerClips, overwrite, removeRange, removeWithoutCuttingOvertalk, restoreRange, seamList, snapToGap, spliceIn, unliftOnTrack, unmuteWords, type Layering, type Timeline, type TimelineWord,
} from "./edit-model";

/** A small generated scene: six lines across five tracks, and a second source. */
function scene(source: string, lines: [string, string][], offset = 1): TimelineWord[] {
  const out: TimelineWord[] = [];
  let at = offset;
  lines.forEach(([track, text], line) => {
    text.split(" ").forEach((word, index) => {
      out.push({ id: `${source}-${line}-${index}`, source, track, text: word, start: at, end: at + 0.4 });
      at += 0.5;
    });
    at += 1.5;
  });
  return out;
}
const teWords: TimelineWord[] = [
  ...scene("mg3", [["rosa", "Okay everybody circle up."], ["dev", "Um I mean that's not on us."], ["imani", "It doesn't matter whose mess it is."],
    ["wes", "Can we just pick stations?"], ["tamsin", "You took the grill last time."], ["rosa", "Guys focus."]]),
  ...scene("itm", [["rosa", "I knew it would be chaos."]]),
];
const teDurations: Record<string, number> = { mg3: 40, itm: 6 };
const teWholeScene = (source = "mg3"): Timeline => ({ segments: [{ id: `whole-${source}`, source, srcIn: 0, srcOut: teDurations[source] }], mutes: [] });

const w = (id: string, track: string, start: number, end: number): TimelineWord => ({ id, source: "s", track, text: id, start, end });
const kitchen = teWords.filter((word) => word.source === "mg3");
// Two speakers; b2 overlaps a3 (crosstalk).
const words = [w("a1", "a", 1, 1.4), w("a2", "a", 1.5, 1.9), w("a3", "a", 2.0, 2.4), w("b1", "b", 3.0, 3.4), w("b2", "b", 2.2, 2.6)];
const whole = (): Timeline => ({ segments: [{ id: "s", source: "s", srcIn: 0, srcOut: 5 }], mutes: [] });
/** Delete every appearance of these word ids. */
const deleteWords = (all: TimelineWord[], edit: Timeline, ids: Set<string>) =>
  deleteKeys(all, edit, new Set(placeWords(all, edit).filter((item) => ids.has(item.word.id)).map(placementKey)));

describe("transcript editor model", () => {
  it("places every word of an untouched scene in source order", () => {
    const placed = placeWords(teWords, teWholeScene());
    expect(placed).toHaveLength(kitchen.length);
    expect(placed.every((item) => item.word.source === "mg3")).toBe(true);
    expect(placed.every((item, index) => index === 0 || item.programStart >= placed[index - 1].programStart)).toBe(true);
  });

  it("deleting a word ripples: the edit gets shorter by exactly the cut, and the word is gone", () => {
    const edit = whole();
    const result = deleteWords(words, edit, new Set(["a2"]));
    expect(programDuration(result.edit)).toBeCloseTo(programDuration(edit) - result.seconds, 6);
    expect(result.removed.map((word) => word.id)).toEqual(["a2"]);
    const left = placeWords(words, result.edit).map((item) => item.word.id);
    expect(left).not.toContain("a2");
    expect(left).toEqual(expect.arrayContaining(["a1", "a3", "b1", "b2"]));
    // The cut keeps air but never reaches into the neighbours.
    expect(result.edit.segments.map((s) => [s.srcIn, s.srcOut])).toEqual([[0, 1.45], [1.95, 5]]);
  });

  it("reports crosstalk that a ripple takes with it, and a mute keeps it", () => {
    const result = deleteWords(words, whole(), new Set(["a3"]));
    expect(result.crosstalk.map((word) => word.id)).toEqual(["b2"]);
    const muted = muteWords(words, whole(), new Set(["a3"]));
    expect(programDuration(muted)).toBe(5);
    const placed = placeWords(words, muted);
    expect(placed.find((item) => item.word.id === "a3")?.muted).toBe(true);
    expect(placed.find((item) => item.word.id === "b2")?.muted).toBe(false);
    expect(placeWords(words, unmuteWords(words, muted, new Set(["a3"]))).some((item) => item.muted)).toBe(false);
  });

  it("a cut does not break a paragraph; it is marked between the words it separates", () => {
    const result = deleteWords(words, whole(), new Set(["a2"]));
    const paras = paragraphs(placeWords(words, result.edit));
    expect(paras.map((p) => [p.track, p.words.map((i) => i.word.id)])).toEqual([["a", ["a1", "a3"]], ["b", ["b2", "b1"]]]);
    const [a1, a3] = paras[0].words;
    expect(a1.segment).not.toBe(a3.segment);
  });

  it("moving a paragraph that contains a cut carries the cut with it", () => {
    const edit = teWholeScene();
    const inner = paragraphs(placeWords(teWords, edit))[2];
    const cut = deleteWords(teWords, edit, new Set([inner.words[1].word.id])).edit;
    const paras = paragraphs(placeWords(teWords, cut));
    const moved = moveParagraph(teWords, cut, paras[2], paras[0]);
    expect(programDuration(moved)).toBeCloseTo(programDuration(cut), 6);
    const after = paragraphs(placeWords(teWords, moved));
    expect(after[0].words.map((i) => i.word.id)).toEqual(paras[2].words.map((i) => i.word.id));
    expect(placeWords(teWords, moved)).toHaveLength(kitchen.length - 1);
  });

  it("removeRange and programToSource agree across several segments", () => {
    const edit = removeRange(removeRange(whole(), "s", 1, 2), "s", 3, 4);
    expect(edit.segments.map((s) => [s.srcIn, s.srcOut])).toEqual([[0, 1], [2, 3], [4, 5]]);
    expect(programToSource(edit, 1.5)).toEqual({ segment: 1, source: 2.5 });
    expect(programToSource(edit, 2.5)).toEqual({ segment: 2, source: 4.5 });
  });

  it("splices a source range in at a program position without disturbing the rest", () => {
    const base: Timeline = { segments: [{ id: "x", source: "s", srcIn: 10, srcOut: 20 }], mutes: [] };
    const edit = spliceIn(base, "s", 1, 3, 4);
    expect(edit.segments.map((s) => [s.srcIn, s.srcOut])).toEqual([[10, 14], [1, 3], [14, 20]]);
    expect(spliceIn(base, "s", 1, 3, 10).segments.map((s) => [s.srcIn, s.srcOut])).toEqual([[10, 20], [1, 3]]);
    expect(spliceIn(base, "s", 1, 3, 0).segments.map((s) => [s.srcIn, s.srcOut])).toEqual([[1, 3], [10, 20]]);
  });

  it("overwrite replaces what is under it for its own length and moves nothing after it", () => {
    const base: Timeline = { segments: [{ id: "x", source: "s", srcIn: 10, srcOut: 20 }], mutes: [] };
    const edit = overwrite(base, "t", 1, 3, 4);
    expect(edit.segments.map((s) => [s.source, s.srcIn, s.srcOut])).toEqual([["s", 10, 14], ["t", 1, 3], ["s", 16, 20]]);
    expect(programDuration(edit)).toBe(programDuration(base));
    // Past the end it runs on, as Avid's does.
    const tail = overwrite(base, "t", 0, 4, 8);
    expect(tail.segments.map((s) => [s.source, s.srcIn, s.srcOut])).toEqual([["s", 10, 18], ["t", 0, 4]]);
    expect(programDuration(tail)).toBe(12);
  });

  it("with Snap on a splice lands in the gap between words, never inside one", () => {
    const edit: Timeline = { segments: [{ id: "x", source: "s", srcIn: 0, srcOut: 4 }], mutes: [] };
    const placed = placeWords([w("one", "a", 0.5, 1.5), w("two", "a", 2, 3)], edit);
    expect(snapToGap(edit, placed, 1.2)).toBeCloseTo(1.75, 6);
    expect(snapToGap(edit, placed, 0.7)).toBe(0);
    // Already between words: it stays where it is.
    expect(snapToGap(edit, placed, 3.5)).toBe(3.5);
  });

  it("a source range used twice is cut only where it was selected", () => {
    const twice = spliceIn(whole(), "s", 1.45, 1.95, 5);
    const second = placeWords(words, twice).filter((item) => item.word.id === "a2");
    expect(second).toHaveLength(2);
    const result = deleteKeys(words, twice, new Set([placementKey(second[1])]));
    expect(placeWords(words, result.edit).filter((item) => item.word.id === "a2")).toHaveLength(1);
    expect(result.edit.segments[0]).toEqual(twice.segments[0]);
  });

  it("an edit point knows a cut from a jump, so restore never plays a line twice", () => {
    const cut = deleteWords(words, whole(), new Set(["a2"])).edit;
    expect(seamList(cut, words).map((seam) => [seam.kind, seam.removed.map((word) => word.id)])).toEqual([["cut", ["a2"]]]);
    // Splice a later line in early: the seam before it skips source that still plays later.
    const spliced = spliceIn(whole(), "s", 2.95, 3.45, 1.45);
    const kinds = seamList(spliced, words).map((seam) => seam.kind);
    expect(kinds).toEqual(["jump", "jump"]);
    expect(seamList(spliced, words).every((seam) => seam.removed.length === 0)).toBe(true);
  });

  it("healing a cut brings back exactly what it removed, and a backwards jump cannot be healed", () => {
    const cut = deleteWords(words, whole(), new Set(["a2"])).edit;
    expect(healSeam(cut, 1).segments.map((s) => [s.srcIn, s.srcOut])).toEqual([[0, 5]]);
    const moved: Timeline = { segments: [{ id: "1", source: "s", srcIn: 3, srcOut: 5 }, { id: "2", source: "s", srcIn: 0, srcOut: 3 }], mutes: [] };
    expect(healSeam(moved, 1)).toBe(moved);
  });

  it("moving a paragraph keeps the running time and changes the order", () => {
    const edit = teWholeScene();
    const paras = paragraphs(placeWords(teWords, edit));
    const moved = moveParagraph(teWords, edit, paras[3], paras[0]);
    expect(programDuration(moved)).toBeCloseTo(programDuration(edit), 6);
    const after = paragraphs(placeWords(teWords, moved));
    expect(after[0].words[0].word.id).toBe(paras[3].words[0].word.id);
    expect(placeWords(teWords, moved)).toHaveLength(kitchen.length);
  });

  it("a deleted line stays in the text as a ghost, and restoring it brings back only that line", () => {
    const edit = teWholeScene();
    const paras = paragraphs(placeWords(teWords, edit));
    const keys = new Set([...paras[1].words, ...paras[2].words].map(placementKey));
    const cut = deleteKeys(teWords, edit, keys).edit;
    const ghosts = ghostLines(cut, teWords);
    expect(ghosts.map((ghost) => ghost.track)).toEqual(["dev", "imani"]);
    expect(ghosts.map((ghost) => ghost.words.length)).toEqual([paras[1].words.length, paras[2].words.length]);
    // Restore only the second of the two lines: the first stays cut.
    const [devLine, imaniLine] = ghosts;
    const back = restoreRange(cut, imaniLine.at, imaniLine.source, imaniLine.from, imaniLine.to);
    const ids = new Set(placeWords(teWords, back).map((item) => item.word.id));
    expect(imaniLine.words.every((word) => ids.has(word.id))).toBe(true);
    expect(devLine.words.some((word) => ids.has(word.id))).toBe(false);
    expect(ghostLines(back, teWords).map((ghost) => ghost.track)).toEqual(["dev"]);
    // And then the other one: nothing is left cut, and the edit is whole again.
    const [rest] = ghostLines(back, teWords);
    const whole = restoreRange(back, rest.at, rest.source, rest.from, rest.to);
    expect(placeWords(teWords, whole)).toHaveLength(kitchen.length);
    expect(ghostLines(whole, teWords)).toEqual([]);
  });

  it("Remove Lines cuts a line nobody in the clip talks over, even where someone outside the clip spoke in the source", () => {
    const words: TimelineWord[] = [
      { id: "k1", source: "s", track: "kara", text: "so", start: 1, end: 1.5 },
      { id: "k2", source: "s", track: "kara", text: "anyway", start: 2, end: 2.5 },
      // Dev talks over "anyway" in the source, but this clip is Kara's alone.
      { id: "d1", source: "s", track: "dev", text: "yeah", start: 2.1, end: 2.4 },
    ];
    const bite: Timeline = { segments: [{ id: "a", source: "s", srcIn: 0, srcOut: 4, tracks: ["kara"] }], mutes: [] };
    const cut = removeWithoutCuttingOvertalk(words, bite, new Set(["k2"]));
    expect(cut.mutes).toEqual([]);
    expect(programDuration(cut)).toBeLessThan(4);
    // With Dev in the clip too, his word is in the way: "anyway" is silenced, not cut.
    const both: Timeline = { segments: [{ id: "a", source: "s", srcIn: 0, srcOut: 4 }], mutes: [] };
    const kept = removeWithoutCuttingOvertalk(words, both, new Set(["k2"]));
    expect(kept.mutes).toEqual([{ source: "s", track: "kara", srcIn: 2, srcOut: 2.5 }]);
    expect(programDuration(kept)).toBe(4);
  });

  it("a restored middle line plays the people its clip played, on their tracks, and not every mic", () => {
    const edit: Timeline = { segments: [
      { id: "a", source: "s", srcIn: 0, srcOut: 4, tracks: ["kara"], layers: { kara: 2 } },
      { id: "b", source: "s", srcIn: 6, srcOut: 9, tracks: ["kara"], layers: { kara: 2 } },
    ], mutes: [] };
    // A line from 4 to 5 s that does not join either side (it stops short of 6).
    const back = restoreRange(edit, 1, "s", 4.5, 5);
    expect(back.segments[1]).toMatchObject({ source: "s", srcIn: 4.5, srcOut: 5, tracks: ["kara"], layers: { kara: 2 } });
  });

  it("what lies before the first kept piece or after the last is not removed: it was never in the string out", () => {
    const [, second] = paragraphs(placeWords(teWords, teWholeScene()));
    const cut: Timeline = { segments: [{ id: "t", source: "mg3", srcIn: second.words[0].word.start - 0.1, srcOut: second.words[second.words.length - 1].word.end + 0.1 }], mutes: [] };
    expect(ghostLines(cut, teWords)).toEqual([]);
  });

  it("reads a cut through interleaved mics as speaker turns, leaving bleed copies out", () => {
    // Alex talks for four seconds; Sam's mic hears every word of it, one
    // word behind; then Sam answers. Before, a line broke at every change of
    // track: one row per word.
    const word = (id: string, track: string, cue: string, text: string, start: number, heardOn?: string): TimelineWord =>
      ({ id, source: "s", track, cue, text, start, end: start + 0.3, heardOn });
    const said = ["so", "we", "drove", "all", "night", "long"];
    const cutWords: TimelineWord[] = [
      word("k0", "alex", "c0", "Before.", 0),
      ...said.map((text, index) => word(`a${index}`, "alex", "c1", text, 2 + index * 0.5)),
      ...said.map((text, index) => word(`b${index}`, "sam", "c2", text, 2.1 + index * 0.5)),
      word("r0", "room", "c3", "night", 3.6, "alex"),
      ...["and", "then", "what"].map((text, index) => word(`s${index}`, "sam", "c4", text, 6 + index * 0.5)),
      word("k1", "alex", "c5", "After.", 9),
    ];
    const edit: Timeline = { segments: [{ id: "x", source: "s", srcIn: 0, srcOut: 1 }, { id: "y", source: "s", srcIn: 8.5, srcOut: 10 }], mutes: [] };
    const ghosts = ghostLines(edit, cutWords);
    expect(ghosts.map((ghost) => [ghost.track, ghost.words.map((item) => item.text).join(" ")])).toEqual([
      ["alex", "so we drove all night long"],
      ["sam", "and then what"],
    ]);
    // Restoring each turn in order brings the whole cut back, and nothing twice.
    let back = edit;
    for (const ghost of ghosts) back = restoreRange(back, ghost.at, ghost.source, ghost.from, ghost.to);
    expect(placeWords(cutWords, back).map((item) => item.word.id).sort()).toEqual(cutWords.map((item) => item.id).sort());
    expect(ghostLines(back, cutWords)).toEqual([]);
  });

  it("runs a speaker's cues together into one turn until a long pause", () => {
    const word = (id: string, cue: string, start: number): TimelineWord => ({ id, source: "s", track: "alex", cue, text: id, start, end: start + 0.3 });
    const cutWords = [word("k0", "c0", 0), word("w1", "c1", 2), word("w2", "c2", 2.6), word("w3", "c3", 6), word("k1", "c4", 9)];
    const edit: Timeline = { segments: [{ id: "x", source: "s", srcIn: 0, srcOut: 1 }, { id: "y", source: "s", srcIn: 8.5, srcOut: 10 }], mutes: [] };
    expect(ghostLines(edit, cutWords).map((ghost) => ghost.words.map((item) => item.id))).toEqual([["w1", "w2"], ["w3"]]);
  });

  it("a line from another source is a jump, never a restorable cut", () => {
    const edit = spliceIn(teWholeScene(), "itm", 0.5, 4, 10);
    const seams = seamList(edit, teWords);
    expect(seams.map((seam) => seam.kind)).toEqual(["jump", "jump"]);
    expect(seams.every((seam) => Number.isNaN(seam.gap))).toBe(true);
    expect(healSeam(edit, 1)).toBe(edit);
    expect(placeWords(teWords, edit).some((item) => item.word.source === "itm")).toBe(true);
  });

  it("add edit cuts every track at the playhead and changes nothing else", () => {
    const edit = addEdit(whole(), 2.5);
    expect(edit.segments.map((segment) => [segment.srcIn, segment.srcOut])).toEqual([[0, 2.5], [2.5, 5]]);
    expect(programDuration(edit)).toBe(5);
    expect(seamList(edit, words).map((seam) => seam.kind)).toEqual(["through"]);
    // On an existing edit point there is nothing to cut.
    expect(addEdit(edit, 2.5)).toBe(edit);
    expect(addEdit(whole(), 0)).toEqual(whole());
  });

  it("lift leaves a gap and nothing after it moves; extract closes it up", () => {
    const lifted = liftProgram(whole(), 1.45, 2.7);
    expect(programDuration(lifted)).toBeCloseTo(5);
    expect(lifted.segments.map((segment) => isGap(segment))).toEqual([false, true, false]);
    expect(placeWords(words, lifted).map((item) => item.word.id)).toEqual(["a1", "b1"]);
    expect(placeWords(words, lifted).find((item) => item.word.id === "b1")!.programStart).toBe(3);
    const extracted = extractProgram(whole(), 1.45, 2.7).edit;
    expect(programDuration(extracted)).toBeCloseTo(3.75);
    expect(liftProgram(whole(), 2, 2)).toEqual(whole());
  });

  it("a lifted line is a ghost that restores into its gap without moving what follows", () => {
    const lifted = liftProgram(whole(), 1.45, 2.7);
    const ghosts = ghostLines(lifted, words);
    const ghost = ghosts.find((item) => item.words.some((word) => word.id === "a2"))!;
    expect(ghost).toBeTruthy();
    const restored = restoreRange(lifted, ghost.at, ghost.source, ghost.from, ghost.to);
    expect(programDuration(restored)).toBeCloseTo(5);
    expect(placeWords(words, restored).map((item) => item.word.id)).toContain("a2");
  });

  it("lift on some record tracks silences only those tracks, there, and moves nothing", () => {
    const edit: Timeline = { segments: [{ id: "x", source: "s", srcIn: 3, srcOut: 5 }, { id: "y", source: "s", srcIn: 0, srcOut: 2 }], mutes: [] };
    const layering: Layering = { carries: () => ["a", "b"], home: (lane) => ({ a: 1, b: 2 } as Record<string, number>)[lane] };
    const lifted = liftLayers(edit, 1, 3, [1], layering);
    expect(lifted.mutes).toEqual([]);
    expect(lifted.segments.map((s) => [s.srcIn, s.srcOut, s.overrides])).toEqual([
      [3, 4, undefined], [4, 5, { a: { source: null } }], [0, 1, { a: { source: null } }], [1, 2, undefined]]);
    expect(programDuration(lifted)).toBe(4);
    expect(liftLayers(edit, 2, 2, [1], layering)).toBe(edit);
    // An empty track, or one whose person has no mic in the source, has nothing to lift.
    expect(liftLayers(edit, 1, 3, [3], layering)).toBe(edit);
    expect(liftLayers(edit, 1, 3, [1], { ...layering, carries: () => ["b"] })).toBe(edit);
  });

  it("gaps merge, can be inserted, and Mark Clip marks the segment under the playhead", () => {
    const gapped = insertGap(liftProgram(whole(), 1, 2), 2, 0.5);
    expect(gapped.segments.filter(isGap)).toHaveLength(1);
    expect(gapped.segments.find(isGap)!.srcOut).toBeCloseTo(1.5);
    expect(programDuration(gapped)).toBeCloseTo(5.5);
    expect(clipAround(gapped, 1.2)).toEqual([1, 2.5]);
    expect(clipAround({ segments: [], mutes: [] }, 0)).toBeNull();
    expect(gapped.segments.find(isGap)!.source).toBe(GAP);
  });

  it("dead space needs both a quiet transcript and quiet mics, and a gap is dead whole", () => {
    // Loud only in [3.9, 4.4): a noise with no words (a laugh), which must survive.
    const loudest = (_source: string, from: number, to: number) => (from < 4.4 && to > 3.9 ? 0.6 : 0.02);
    const options = { threshold: 0.12, minimum: 0.5, pad: 0.1, step: 0.05 };
    const spaces = findDeadSpace(liftProgram(whole(), 4.6, 5), words, loudest, options);
    // Words (padded) cover 0.9 to 2.7 and 2.9 to 3.5; the laugh holds 3.9 to 4.4.
    // 2.7 to 2.9 and 3.5 to 3.9 are too short; the quiet run into the gap joins it.
    // Edges land on the analysis step (50 ms), so compare within one step.
    const expected: [number, number][] = [[0, 0.9], [4.4, 5]];
    expect(spaces).toHaveLength(expected.length);
    spaces.forEach((space, index) => {
      expect(Math.abs(space.from - expected[index][0])).toBeLessThanOrEqual(options.step + 1e-9);
      expect(Math.abs(space.to - expected[index][1])).toBeLessThanOrEqual(options.step + 1e-9);
      expect(space.gap).toBe(false);
    });
    expect(findDeadSpace(liftProgram(whole(), 4.6, 5), words, () => 1, options)).toEqual([{ from: 4.6, to: 5, gap: true }]);
  });

  it("removing dead space keeps a breath of each pause and none of a gap", () => {
    const edit = liftProgram(whole(), 4.5, 5);
    const spaces = [{ from: 0, to: 0.9, gap: false }, { from: 4.5, to: 5, gap: true }];
    const { edit: tight, seconds } = removeDeadSpace(edit, spaces, 0.3);
    expect(seconds).toBeCloseTo(0.6 + 0.5);
    expect(programDuration(tight)).toBeCloseTo(5 - 1.1);
    expect(tight.segments.some(isGap)).toBe(false);
    expect(placeWords(words, tight).map((item) => item.word.id)).toEqual(placeWords(words, whole()).map((item) => item.word.id));
  });
});

describe("a clip that names its tracks", () => {
  const word = (id: string, track: string, start: number): TimelineWord => ({ id, source: "s", track, text: id, start, end: start + 0.3 });
  const words = [word("hi", "rosa", 1), word("mm", "dev", 1.4), word("yes", "rosa", 5), word("ok", "dev", 5.2)];
  it("carries only its own people's words; every clip without a list carries everyone's", () => {
    const edit = { segments: [{ id: "a", source: "s", srcIn: 0, srcOut: 2, tracks: ["rosa"] }, { id: "b", source: "s", srcIn: 4, srcOut: 6 }], mutes: [] };
    expect(placeWords(words, edit).map((item) => item.word.id)).toEqual(["hi", "yes", "ok"]);
  });
  it("keeps its list when it is cut, split or healed", () => {
    const edit = { segments: [{ id: "a", source: "s", srcIn: 0, srcOut: 10, tracks: ["rosa"] }], mutes: [] };
    const cut = removeRange(edit, "s", 3, 4);
    expect(cut.segments.map((segment) => segment.tracks)).toEqual([["rosa"], ["rosa"]]);
    expect(healSeam(cut, 1).segments).toEqual([{ id: expect.any(String), source: "s", srcIn: 0, srcOut: 10, tracks: ["rosa"] }]);
    // Two clips that play different people are not one clip.
    const mixed = { segments: [{ id: "a", source: "s", srcIn: 0, srcOut: 3, tracks: ["rosa"] }, { id: "b", source: "s", srcIn: 4, srcOut: 6, tracks: ["dev"] }], mutes: [] };
    expect(healSeam(mixed, 1)).toBe(mixed);
  });
});

/**
 * Avid's track selectors: an Overwrite or a Lift with only some tracks on
 * changes those tracks and nothing else, while anything that closes or opens
 * time does it on every track at once, so nothing slips out of sync.
 */
describe("per-track edits", () => {
  const k = (id: string, track: string, start: number, end: number, source = "s"): TimelineWord => ({ id, source, track, text: id, start, end });
  // Kara (a) and Bo (b) on one source; a second take of Kara on another.
  const all = [k("ka1", "a", 1, 1.4), k("kb1", "b", 2, 2.4), k("ka2", "a", 4.2, 4.6), k("kb2", "b", 4.5, 4.9), k("ka3", "a", 7, 7.4), k("kb3", "b", 8, 8.4),
    k("ta1", "a", 20.2, 20.6, "t"), k("ta2", "a", 21, 21.4, "t")];
  const base = (): Timeline => ({ segments: [{ id: "s", source: "s", srcIn: 0, srcOut: 10 }], mutes: [] });
  const carries = () => ["a", "b"];
  // Kara on A1 and Bo on A2, where a segment does not say otherwise.
  const layering: Layering = { carries, home: (lane) => ({ a: 1, b: 2 } as Record<string, number>)[lane] };
  const A = { lane: "a", layer: 1 }, B = { lane: "b", layer: 2 };
  const at = (edit: Timeline) => Object.fromEntries(placeWords(all, edit).map((item) => [item.voice ? `${item.word.id}@${item.voice}` : item.word.id, [+item.programStart.toFixed(3), item.muted]]));
  const shape = (edit: Timeline) => edit.segments.map((s) => [s.source, s.srcIn, s.srcOut, s.tracks ?? null, s.overrides ?? null]);

  it("an Overwrite on one track replaces that track alone, and everyone else keeps playing", () => {
    const edit = overwrite(base(), "t", 20, 22, 4, [A], layering);
    expect(programDuration(edit)).toBe(10);
    const placed = at(edit);
    // Kara's own line under the overwrite is gone; Bo's, under the same span, still plays where it was.
    expect(placed.ka2).toBeUndefined();
    expect(placed.kb2).toEqual([4.5, false]);
    expect(placed["ta1@a"]).toEqual([4.2, false]);
    expect(placed["ta2@a"]).toEqual([5, false]);
    expect([placed.ka1, placed.ka3, placed.kb3]).toEqual([[1, false], [7, false], [8, false]]);
    expect(shape(edit)).toEqual([["s", 0, 4, null, null], ["s", 4, 6, null, { a: { source: "t", srcIn: 20 } }], ["s", 6, 10, null, null]]);
  });

  it("an Overwrite on every track a source carries is simply a clip", () => {
    const edit = overwrite(base(), "t", 20, 22, 4, [A, B], layering);
    expect(shape(edit)).toEqual([["s", 0, 4, null, null], ["t", 20, 22, ["a", "b"], null], ["s", 6, 10, null, null]]);
    // Putting a track's own material back over it is no override at all.
    expect(overwrite(base(), "s", 4, 6, 4, [A], layering).segments.every((s) => !s.overrides)).toBe(true);
  });

  it("an Overwrite past the end runs on, with filler on the other tracks", () => {
    const edit = overwrite(base(), "t", 20, 22, 9, [A], layering);
    expect(programDuration(edit)).toBe(11);
    expect(shape(edit)).toEqual([["s", 0, 9, null, null], ["s", 9, 10, null, { a: { source: "t", srcIn: 20 } }], ["t", 21, 22, ["a"], null]]);
    // Onto a hole, the clip goes in on that track alone.
    const holed = overwrite(liftProgram(base(), 4, 6), "t", 20, 22, 4, [A], layering);
    expect(shape(holed)).toEqual([["s", 0, 4, null, null], ["t", 20, 22, ["a"], null], ["s", 6, 10, null, null]]);
  });

  it("a Lift on one track is a place in the edit: the same material elsewhere still plays", () => {
    const twice = spliceIn(base(), "s", 4, 5, 10);
    const lifted = liftLayers(twice, 4, 5, [1], layering);
    expect(programDuration(lifted)).toBe(11);
    const copies = placeWords(all, lifted).filter((item) => item.word.id === "ka2");
    expect(copies.map((item) => [item.programStart, item.muted])).toEqual([[4.2, true], [10.2, false]]);
    // The lifted words stay in the text, struck through, and Bo is untouched.
    expect(placeWords(all, lifted).filter((item) => item.word.id === "kb2").every((item) => !item.muted)).toBe(true);
  });

  it("a lifted word restores where it was lifted, and a whole restore joins the clip again", () => {
    const lifted = liftLayers(base(), 4, 5, [1], layering);
    expect(at(unliftOnTrack(lifted, 4.2, 4.6, "a")).ka2).toEqual([4.2, false]);
    expect(shape(unliftOnTrack(lifted, 4, 5, "a"))).toEqual(shape(base()));
    expect(unliftOnTrack(lifted, 4, 5, "b")).toBe(lifted);
  });

  it("deleting a word an override plays closes the time there on every track", () => {
    const edit = overwrite(base(), "t", 20, 22, 4, [A], layering);
    const key = placeWords(all, edit).find((item) => item.word.id === "ta1")!;
    const result = deleteKeys(all, edit, new Set([placementKey(key)]));
    expect(result.removed.map((word) => word.id)).toEqual(["ta1"]);
    expect(programDuration(result.edit)).toBeCloseTo(10 - result.seconds, 6);
    expect(result.seconds).toBeGreaterThan(0.3);
    const after = at(result.edit);
    expect(after["ta1@a"]).toBeUndefined();
    expect(after["ta2@a"]).toBeDefined();
    expect(after.ka3[0]).toBeCloseTo(7 - result.seconds, 6);
  });

  it("an edit point inside an override's span keeps every track on its material, and joins again", () => {
    const edit = overwrite(base(), "t", 20, 22, 4, [A], layering);
    const split = addEdit(edit, 5);
    expect(split.segments).toHaveLength(4);
    expect(at(split)).toEqual(at(edit));
    expect(shape(healSeam(split, 2))).toEqual(shape(edit));
  });

  it("where one track changes material the edit point is a jump, not a through edit", () => {
    const edit = overwrite(base(), "t", 20, 22, 4, [A], layering);
    expect(seamList(edit, all).map((seam) => [seam.at, seam.kind])).toEqual([[4, "jump"], [6, "jump"]]);
    expect(healSeam(edit, 1)).toBe(edit);
  });

  it("each track reads as its own clips: a cut on another track alone is not a cut here", () => {
    const edit = overwrite(base(), "t", 20, 22, 4, [A], layering);
    expect(laneClips(edit, "b").map((clip) => [clip.from, clip.to, clip.source, clip.srcIn, clip.srcOut])).toEqual([[0, 10, "s", 0, 10]]);
    expect(laneClips(edit, "a").map((clip) => [clip.from, clip.to, clip.source, clip.srcIn, clip.srcOut])).toEqual([[0, 4, "s", 0, 4], [4, 6, "t", 20, 22], [6, 10, "s", 6, 10]]);
    expect(laneClips(liftLayers(base(), 4, 6, [1], layering), "a").map((clip) => [clip.from, clip.to])).toEqual([[0, 4], [6, 10]]);
  });

  it("a line is not cut by an edit made on someone else's track: its words keep their place and their paragraph", () => {
    // Kara says "okay" at 2.0-2.5 and "remind" at 2.8-3.4; Bo is overwritten from 1 to 3 s.
    const lines = [k("okay", "a", 2, 2.5), k("remind", "a", 2.8, 3.4)];
    const edit = overwrite(base(), "t", 20, 22, 1, [B], layering);
    expect(edit.segments).toHaveLength(3);
    const placed = placeWords(lines, edit);
    // "remind" straddles the edit point at 3 s and is not clipped to it.
    expect(placed.map((item) => [item.word.id, item.programStart])).toEqual([["okay", 2], ["remind", 2.8]]);
    expect(paragraphs(placed).map((paragraph) => [paragraph.words.length, paragraph.cutBefore])).toEqual([[2, false]]);
    // Where Kara's own material does cut, her line still reads as cut.
    const cutHer = overwrite(base(), "t", 20, 22, 1, [A], layering);
    expect(placeWords(lines, cutHer).find((item) => item.word.id === "remind")!.programStart).toBe(3);
  });

  it("Add Edit cuts the chosen tracks alone, and the cut stays a cut on them though the material runs on", () => {
    const cut = addCut(base(), 3, [1], layering)!;
    expect(layerClips(cut, 1, layering).map((clip) => [clip.from, clip.to, clip.srcIn])).toEqual([[0, 3, 0], [3, 10, 3]]);
    // Bo, on A2, plays straight through: no edit on his track.
    expect(layerClips(cut, 2, layering).map((clip) => [clip.from, clip.to])).toEqual([[0, 10]]);
    // Nothing more to cut there on A1, and nothing to cut where no clip crosses.
    expect(addCut(cut, 3, [1], layering)).toBeNull();
    expect(addCut(base(), 3, [3], layering)).toBeNull();
    // Words and time are untouched; a split elsewhere keeps the edit where it is; healing it on purpose takes it away.
    expect(at(cut)).toEqual(at(base()));
    expect(layerClips(addCut(cut, 6, [2], layering)!, 1, layering).map((clip) => [clip.from, clip.to])).toEqual([[0, 3], [3, 10]]);
    expect(healSeam(cut, 1)).toBe(cut);
    expect(layerClips(healSeam(cut, 1, true), 1, layering).map((clip) => [clip.from, clip.to])).toEqual([[0, 10]]);
  });

  it("dead space is quiet on every track, overwritten ones included", () => {
    const quietSource = [k("ka1", "a", 1, 1.4), k("ka3", "a", 8, 8.4), k("ta1", "a", 20.2, 20.6, "t"), k("ta2", "a", 21, 21.4, "t")];
    const edit = overwrite(base(), "t", 20, 22, 4, [A], layering);
    const spaces = findDeadSpace(edit, quietSource, () => 0);
    expect(spaces.length).toBeGreaterThan(0);
    for (const space of spaces) expect(space.to <= 4.2 - 0.1 || space.from >= 5.4 + 0.1).toBe(true);
  });
});
