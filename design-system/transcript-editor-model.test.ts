import { describe, expect, it } from "vitest";
import {
  deleteWords as deleteKeys, moveParagraph, muteWords, paragraphs, placeWords, placementKey, programDuration, programToSource,
  healSeam, removeRange, seamList, spliceIn, unmuteWords, type TeEdit, type TeWord,
} from "./transcript-editor-model";
import { teWholeScene, teWords } from "./transcript-editor-fixture";

const w = (id: string, speaker: string, start: number, end: number): TeWord => ({ id, speaker, text: id, start, end });
// Two speakers; b2 overlaps a3 (crosstalk).
const words = [w("a1", "a", 1, 1.4), w("a2", "a", 1.5, 1.9), w("a3", "a", 2.0, 2.4), w("b1", "b", 3.0, 3.4), w("b2", "b", 2.2, 2.6)];
const whole = (): TeEdit => ({ segments: [{ id: "s", srcIn: 0, srcOut: 5 }], mutes: [] });
/** Delete every appearance of these word ids. */
const deleteWords = (all: TeWord[], edit: TeEdit, ids: Set<string>) =>
  deleteKeys(all, edit, new Set(placeWords(all, edit).filter((item) => ids.has(item.word.id)).map(placementKey)));

describe("transcript editor model", () => {
  it("places every word of an untouched scene in source order", () => {
    const placed = placeWords(teWords, teWholeScene());
    expect(placed).toHaveLength(teWords.length);
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
    expect(paras.map((p) => [p.speaker, p.words.map((i) => i.word.id)])).toEqual([["a", ["a1", "a3"]], ["b", ["b2", "b1"]]]);
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
    expect(placeWords(teWords, moved)).toHaveLength(teWords.length - 1);
  });

  it("removeRange and programToSource agree across several segments", () => {
    const edit = removeRange(removeRange(whole(), 1, 2), 3, 4);
    expect(edit.segments.map((s) => [s.srcIn, s.srcOut])).toEqual([[0, 1], [2, 3], [4, 5]]);
    expect(programToSource(edit, 1.5)).toEqual({ segment: 1, source: 2.5 });
    expect(programToSource(edit, 2.5)).toEqual({ segment: 2, source: 4.5 });
  });

  it("splices a source range in at a program position without disturbing the rest", () => {
    const base: TeEdit = { segments: [{ id: "x", srcIn: 10, srcOut: 20 }], mutes: [] };
    const edit = spliceIn(base, 1, 3, 4);
    expect(edit.segments.map((s) => [s.srcIn, s.srcOut])).toEqual([[10, 14], [1, 3], [14, 20]]);
    expect(spliceIn(base, 1, 3, 10).segments.map((s) => [s.srcIn, s.srcOut])).toEqual([[10, 20], [1, 3]]);
    expect(spliceIn(base, 1, 3, 0).segments.map((s) => [s.srcIn, s.srcOut])).toEqual([[1, 3], [10, 20]]);
  });

  it("a source range used twice is cut only where it was selected", () => {
    const twice = spliceIn(whole(), 1.45, 1.95, 5);
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
    const spliced = spliceIn(whole(), 2.95, 3.45, 1.45);
    const kinds = seamList(spliced, words).map((seam) => seam.kind);
    expect(kinds).toEqual(["jump", "jump"]);
    expect(seamList(spliced, words).every((seam) => seam.removed.length === 0)).toBe(true);
  });

  it("healing a cut brings back exactly what it removed, and a backwards jump cannot be healed", () => {
    const cut = deleteWords(words, whole(), new Set(["a2"])).edit;
    expect(healSeam(cut, 1).segments.map((s) => [s.srcIn, s.srcOut])).toEqual([[0, 5]]);
    const moved: TeEdit = { segments: [{ id: "1", srcIn: 3, srcOut: 5 }, { id: "2", srcIn: 0, srcOut: 3 }], mutes: [] };
    expect(healSeam(moved, 1)).toBe(moved);
  });

  it("moving a paragraph keeps the running time and changes the order", () => {
    const edit = teWholeScene();
    const paras = paragraphs(placeWords(teWords, edit));
    const moved = moveParagraph(teWords, edit, paras[3], paras[0]);
    expect(programDuration(moved)).toBeCloseTo(programDuration(edit), 6);
    const after = paragraphs(placeWords(teWords, moved));
    expect(after[0].words[0].word.id).toBe(paras[3].words[0].word.id);
    expect(placeWords(teWords, moved)).toHaveLength(teWords.length);
  });
});
