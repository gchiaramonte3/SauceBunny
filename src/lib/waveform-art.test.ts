import { describe, expect, it } from "vitest";
import { waveformBars, waveformPath } from "./waveform-art";
import type { WaveformPeaks } from "./waveform";

/** Peaks from a magnitude per bucket, symmetric about zero. */
const peaksOf = (mags: number[]): WaveformPeaks => ({
  mins: Float32Array.from(mags.map((m) => -m)),
  maxs: Float32Array.from(mags),
});

describe("waveformBars", () => {
  it("reduces many buckets to the bar count asked for", () => {
    // The whole reason this exists: 1500 timeline buckets into ~48 card bars,
    // once, rather than per repaint on a wall of cards.
    expect(waveformBars(peaksOf(new Array(1500).fill(0.5)), 48)).toHaveLength(48);
  });

  it("takes the PEAK of each span, not the average", () => {
    // A transient inside a quiet stretch is what makes a waveform readable;
    // averaging flattens it away.
    const bars = waveformBars(peaksOf([0.1, 0.1, 0.9, 0.1]), 2);
    expect(bars[1]).toBe(1); // 0.9 survives its span and normalises to the top
  });

  it("uses the larger excursion either side of zero", () => {
    const asymmetric: WaveformPeaks = {
      mins: Float32Array.from([-0.8, -0.1]),
      maxs: Float32Array.from([0.2, 0.1]),
    };
    const bars = waveformBars(asymmetric, 2);
    expect(bars[0]).toBe(1); // 0.8 dominates its own 0.2
  });

  it("normalises to the file's OWN loudest moment", () => {
    // A quiet recording at true amplitude is a flat line, which reads as a
    // broken thumbnail rather than a quiet take.
    const quiet = waveformBars(peaksOf([0.02, 0.01, 0.005]), 3);
    expect(Math.max(...quiet)).toBe(1);
    const loud = waveformBars(peaksOf([1.0, 0.5, 0.25]), 3);
    expect(quiet).toEqual(loud); // same SHAPE, different absolute levels
  });

  it("leaves silence flat instead of dividing by zero", () => {
    const bars = waveformBars(peaksOf([0, 0, 0, 0]), 4);
    expect(bars).toEqual([0, 0, 0, 0]);
    expect(bars.every(Number.isFinite)).toBe(true);
  });

  it("survives empty peaks and absurd bar counts", () => {
    expect(waveformBars(peaksOf([]), 8)).toEqual(new Array(8).fill(0));
    expect(waveformBars(peaksOf([1, 1]), 0)).toHaveLength(1);
    expect(waveformBars(peaksOf([1, 1]), -5)).toHaveLength(1);
  });

  it("covers every bucket when there are fewer buckets than bars", () => {
    // Upsampling must not drop the loud one or leave a bar undefined.
    const bars = waveformBars(peaksOf([0.2, 1.0]), 6);
    expect(bars).toHaveLength(6);
    expect(bars.every((b) => Number.isFinite(b))).toBe(true);
    expect(Math.max(...bars)).toBe(1);
  });
});

describe("waveformPath", () => {
  it("builds ONE path rather than a node per bar", () => {
    // Forty cards times forty-eight bars is ~1900 DOM nodes for decoration.
    const d = waveformPath([1, 0.5, 0.2], 90, 40);
    expect(typeof d).toBe("string");
    expect(d.match(/M/g)).toHaveLength(3); // three subpaths, one element
  });

  it("gives a silent bar a visible stub, not a gap", () => {
    const d = waveformPath([0], 10, 40, { floor: 0.1 });
    // 0.1 of a 40px height, mirrored: 2px tall, so a stub exists.
    expect(d).toContain("v4");
  });

  it("stays inside the box for a full-scale bar", () => {
    const d = waveformPath([1], 10, 40);
    const ys = [...d.matchAll(/M[\d.-]+ ([\d.-]+)/g)].map((m) => Number(m[1]));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
  });

  it("returns nothing for a degenerate box or no bars", () => {
    expect(waveformPath([], 100, 40)).toBe("");
    expect(waveformPath([1], 0, 40)).toBe("");
    expect(waveformPath([1], 100, 0)).toBe("");
  });

  it("keeps a bar visible, and inside the box, at extreme density", () => {
    // 200 bars across 90px is well under 1px per slot. Every bar must still
    // have positive width (the floor) AND stay within the box (the ceiling) —
    // without the ceiling the floor pushed the first bar to a negative x.
    const d = waveformPath(new Array(200).fill(1), 90, 40, { gap: 2 });
    expect(d.match(/M/g)).toHaveLength(200);
    const widths = [...d.matchAll(/M[\d.-]+ [\d.-]+h([\d.-]+)/g)].map((m) => Number(m[1]));
    expect(Math.min(...widths)).toBeGreaterThan(0);
    const xs = [...d.matchAll(/M([\d.-]+) /g)].map((m) => Number(m[1]));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs) + Math.max(...widths)).toBeLessThanOrEqual(90.01);
  });
});
