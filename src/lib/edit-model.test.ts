import { describe, expect, it } from "vitest";
import {
  addEdit, clipAround, extractProgram, findDeadSpace, insertGap, isGap, liftOnTracks, liftProgram, removeDeadSpace, GAP, deleteWords as deleteKeys, ghostLines, moveParagraph, muteWords, paragraphs, placeWords, placementKey, programDuration, programToSource,
  healSeam, overwrite, removeRange, restoreRange, seamList, snapToGap, spliceIn, unmuteWords, type Timeline, type TimelineWord,
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
    const ghosts = ghostLines(cut, teWords, teDurations);
    expect(ghosts.map((ghost) => ghost.track)).toEqual(["dev", "imani"]);
    expect(ghosts.map((ghost) => ghost.words.length)).toEqual([paras[1].words.length, paras[2].words.length]);
    // Restore only the second of the two lines: the first stays cut.
    const [devLine, imaniLine] = ghosts;
    const back = restoreRange(cut, imaniLine.at, imaniLine.source, imaniLine.from, imaniLine.to);
    const ids = new Set(placeWords(teWords, back).map((item) => item.word.id));
    expect(imaniLine.words.every((word) => ids.has(word.id))).toBe(true);
    expect(devLine.words.some((word) => ids.has(word.id))).toBe(false);
    expect(ghostLines(back, teWords, teDurations).map((ghost) => ghost.track)).toEqual(["dev"]);
    // And then the other one: nothing is left cut, and the edit is whole again.
    const [rest] = ghostLines(back, teWords, teDurations);
    const whole = restoreRange(back, rest.at, rest.source, rest.from, rest.to);
    expect(placeWords(teWords, whole)).toHaveLength(kitchen.length);
    expect(ghostLines(whole, teWords, teDurations)).toEqual([]);
  });

  it("lines trimmed off the head of a source are ghosts too", () => {
    const [first, second] = paragraphs(placeWords(teWords, teWholeScene()));
    const cut: Timeline = { segments: [{ id: "t", source: "mg3", srcIn: second.words[0].word.start - 0.1, srcOut: teDurations.mg3 }], mutes: [] };
    const [ghost] = ghostLines(cut, teWords, teDurations);
    expect(ghost.at).toBe(0);
    expect(ghost.words.map((word) => word.id)).toEqual(first.words.map((item) => item.word.id));
    expect(placeWords(teWords, restoreRange(cut, 0, ghost.source, ghost.from, ghost.to))).toHaveLength(kitchen.length);
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
    const ghosts = ghostLines(lifted, words, { s: 5 });
    const ghost = ghosts.find((item) => item.words.some((word) => word.id === "a2"))!;
    expect(ghost).toBeTruthy();
    const restored = restoreRange(lifted, ghost.at, ghost.source, ghost.from, ghost.to);
    expect(programDuration(restored)).toBeCloseTo(5);
    expect(placeWords(words, restored).map((item) => item.word.id)).toContain("a2");
  });

  it("lift on some tracks silences only those mics and moves nothing", () => {
    const edit: Timeline = { segments: [{ id: "x", source: "s", srcIn: 3, srcOut: 5 }, { id: "y", source: "s", srcIn: 0, srcOut: 2 }], mutes: [] };
    const lifted = liftOnTracks(edit, 1, 3, () => ["a"]);
    expect(lifted.mutes).toEqual([{ source: "s", track: "a", srcIn: 4, srcOut: 5 }, { source: "s", track: "a", srcIn: 0, srcOut: 1 }]);
    expect(programDuration(lifted)).toBe(4);
    expect(liftOnTracks(edit, 2, 2, () => ["a"])).toBe(edit);
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
