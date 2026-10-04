import { describe, expect, it } from "vitest";
import type { Timeline } from "./edit-model";
import { silentStretches, stripMutes, stripSilenceDefaults, stripTargets, type LevelWindow } from "./edit-strip-silence";

const loud: [number, number] = [-0.5, 0.5];   // about -6 dBFS
const quiet: [number, number] = [-0.001, 0.001]; // -60 dBFS
/** One bucket per tenth of a second from 0, loud where the pattern says L. */
const windowOf = (pattern: string): LevelWindow => ({ source: "s", lane: "rosa", from: 0, to: pattern.length / 10, peaks: [...pattern].map((c) => c === "L" ? loud : quiet) });
const exact = { ...stripSilenceDefaults, padStart: 0, padEnd: 0, keepWords: false };

describe("Strip Silence (Avid's settings)", () => {
  it("finds stretches under the threshold that last the minimum, and nothing shorter", () => {
    // 0.3 s loud, 0.6 s quiet, 0.2 s loud, 0.3 s quiet (too short), 0.2 s loud.
    const stretches = silentStretches([windowOf("LLLqqqqqqLLqqqLL")], [], exact);
    expect(stretches.map(([a, b]) => [+a.toFixed(3), +b.toFixed(3)])).toEqual([[0.3, 0.9]]);
  });

  it("keeps Pad End after the sound that starts a silence and Pad Start before the sound that ends it", () => {
    const [[from, to]] = silentStretches([windowOf("LLqqqqqqqqqqLL")], [], { ...exact, padStart: 0.1, padEnd: 0.2 });
    expect(from).toBeCloseTo(0.4, 6);
    expect(to).toBeCloseTo(1.1, 6);
  });

  it("strips to the window's edge where no sound sits beyond it", () => {
    const [[from, to]] = silentStretches([windowOf("qqqqqqLL")], [], { ...exact, padStart: 0.1, padEnd: 0.2 });
    expect(from).toBe(0);
    expect(to).toBeCloseTo(0.5, 6);
  });

  it("the threshold decides: a quiet stretch above it stays", () => {
    expect(silentStretches([windowOf("LLqqqqqqLL")], [], { ...exact, thresholdDb: -70 })).toEqual([]);
  });

  it("a silence across the seam between two reads is one silence, not two too short to count", () => {
    const first = { ...windowOf("LLqqq"), to: 0.5 }, second = { ...windowOf("qqqLL"), from: 0.5, to: 1 };
    const stretches = silentStretches([first, second], [], exact);
    expect(stretches.map(([a, b]) => [+a.toFixed(3), +b.toFixed(3)])).toEqual([[0.2, 0.8]]);
  });

  it("never strips a transcribed word unless asked to, as Avid would", () => {
    const pattern = "LLqqqqqqqqqqLL", word = { start: 0.6, end: 0.8 };
    const kept = silentStretches([windowOf(pattern)], [word], { ...exact, keepWords: true });
    expect(kept.map(([a, b]) => [+a.toFixed(3), +b.toFixed(3)])).toEqual([[0.2, 0.6], [0.8, 1.2]]);
    expect(silentStretches([windowOf(pattern)], [word], exact)).toHaveLength(1);
  });

  it("measures each selected lane only where its clip plays and its source has a mic, inside the range", () => {
    const edit: Timeline = { segments: [
      { id: "a", source: "s", srcIn: 10, srcOut: 20 },
      { id: "g", source: "gap", srcIn: 0, srcOut: 2 },
      { id: "b", source: "s", srcIn: 15, srcOut: 25, tracks: ["dev"] },
    ], mutes: [] };
    const targets = stripTargets(edit, 5, 20, ["rosa", "dev"], { s: ["rosa", "dev"] });
    // Rosa plays only in the first clip (5 s of it in range); Dev plays both, and the
    // second clip's 15-23 s overlaps the first's 15-20 s, so it is measured once.
    expect(targets).toEqual([{ source: "s", lane: "rosa", from: 15, to: 20 }, { source: "s", lane: "dev", from: 15, to: 23 }]);
  });

  it("adds the stretches as mutes on their lanes, merged with what was already silenced", () => {
    const edit: Timeline = { segments: [{ id: "a", source: "s", srcIn: 0, srcOut: 10 }], mutes: [{ source: "s", track: "rosa", srcIn: 1, srcOut: 2 }] };
    const after = stripMutes(edit, [{ source: "s", lane: "rosa", from: 1.5, to: 3 }, { source: "s", lane: "dev", from: 4, to: 5 }]);
    expect(after.mutes).toEqual([{ source: "s", track: "rosa", srcIn: 1, srcOut: 3 }, { source: "s", track: "dev", srcIn: 4, srcOut: 5 }]);
    expect(after.segments).toBe(edit.segments);
  });
});
