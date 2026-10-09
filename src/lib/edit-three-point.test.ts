import { describe, expect, it } from "vitest";
import { resolveThreePoint, type MarkPair } from "./edit-three-point";

// A 600 s source parked at 300, a record parked at 50. Source In 100 and Out
// 160 (60 s); record In 100 and Out 140 (40 s).
const SI = 100, SO = 160, RI = 100, RO = 140;
const resolve = (source: MarkPair, record: MarkPair) =>
  resolveThreePoint({ source: { ...source, playhead: 300, start: 0, end: 600 }, record: { ...record, playhead: 50 } });
const edit = (source: MarkPair, record: MarkPair) => {
  const result = resolve(source, record);
  if ("refusal" in result) throw new Error(result.refusal);
  return [result.edit.srcIn, result.edit.srcOut, result.edit.at];
};
const refusal = (source: MarkPair, record: MarkPair) => {
  const result = resolve(source, record);
  return "refusal" in result ? result.refusal : null;
};
const none = { in: null, out: null };

describe("three-point edits, Avid's sixteen combinations of marks", () => {
  it("both record marks win: they are the footprint and the source gives only a start", () => {
    // 1: all four. The source Out is discarded.
    expect(edit({ in: SI, out: SO }, { in: RI, out: RO })).toEqual([100, 140, 100]);
    // 4: the documented Overwrite, source In.
    expect(edit({ in: SI, out: null }, { in: RI, out: RO })).toEqual([100, 140, 100]);
    // 5: backtimed from the source Out.
    expect(edit({ in: null, out: SO }, { in: RI, out: RO })).toEqual([120, 160, 100]);
    // 11: no source mark, so from the source playhead.
    expect(edit(none, { in: RI, out: RO })).toEqual([300, 340, 100]);
  });

  it("otherwise the source gives the length, and the edit lands at the record In", () => {
    // 2: the canonical three-mark edit.
    expect(edit({ in: SI, out: SO }, { in: RI, out: null })).toEqual([100, 160, 100]);
    // 7: a source In alone runs to the end of the source.
    expect(edit({ in: SI, out: null }, { in: RI, out: null })).toEqual([100, 600, 100]);
    // 9: a source Out alone runs from its start.
    expect(edit({ in: null, out: SO }, { in: RI, out: null })).toEqual([0, 160, 100]);
  });

  it("with only a record Out the edit ends there: backtimed", () => {
    // 3
    expect(edit({ in: SI, out: SO }, { in: null, out: RO })).toEqual([100, 160, 80]);
    // 8 and 10, with an Out late enough to hold them.
    expect(edit({ in: SI, out: null }, { in: null, out: 520 })).toEqual([100, 600, 20]);
    expect(edit({ in: null, out: SO }, { in: null, out: 200 })).toEqual([0, 160, 40]);
  });

  it("with no record mark the edit lands at the record playhead", () => {
    // 6, 12 and 13.
    expect(edit({ in: SI, out: SO }, none)).toEqual([100, 160, 50]);
    expect(edit({ in: SI, out: null }, none)).toEqual([100, 600, 50]);
    expect(edit({ in: null, out: SO }, none)).toEqual([0, 160, 50]);
  });

  it("no source mark without both record marks is refused, not the whole source", () => {
    // 14, 15 and 16.
    for (const record of [{ in: RI, out: null }, { in: null, out: RO }, none]) expect(refusal(none, record)).toMatch(/^Nothing is marked in the source/);
  });

  it("refuses, in a sentence, an edit the source or the record cannot hold", () => {
    // The source runs out after its In, or before its Out.
    expect(refusal({ in: 590, out: null }, { in: RI, out: RO })).toMatch(/not enough source after the source In/);
    expect(refusal({ in: null, out: 20 }, { in: RI, out: RO })).toMatch(/not enough source before the source Out/);
    // Backtimed from a record Out that is too early.
    expect(refusal({ in: SI, out: SO }, { in: null, out: 30 })).toMatch(/longer than the record before its Out/);
    // A record pair with the Out before the In is not a pair: the In alone decides.
    expect(edit({ in: SI, out: SO }, { in: RI, out: 90 })).toEqual([100, 160, 100]);
  });
});
