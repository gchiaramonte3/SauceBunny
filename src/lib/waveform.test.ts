import { describe, it, expect } from "vitest";
import {
  createPeakBuckets,
  foldPeaks,
  lruSet,
  WAVEFORM_BUCKETS,
  type WaveformPeaks,
} from "./waveform";

describe("createPeakBuckets", () => {
  it("returns zeroed, length-matched min/max arrays", () => {
    const p = createPeakBuckets(8);
    expect(p.mins).toHaveLength(8);
    expect(p.maxs).toHaveLength(8);
    expect(Array.from(p.mins).every((v) => v === 0)).toBe(true);
    expect(Array.from(p.maxs).every((v) => v === 0)).toBe(true);
  });

  it("default bucket count is in the ~1000-2000 display range", () => {
    expect(WAVEFORM_BUCKETS).toBeGreaterThanOrEqual(1000);
    expect(WAVEFORM_BUCKETS).toBeLessThanOrEqual(2000);
  });
});

describe("lruSet", () => {
  it("evicts the oldest entry once the cap is exceeded", () => {
    const m = new Map<string, number>();
    lruSet(m, "a", 1, 2);
    lruSet(m, "b", 2, 2);
    lruSet(m, "c", 3, 2);
    expect(m.has("a")).toBe(false);
    expect([...m.keys()]).toEqual(["b", "c"]);
  });

  it("re-setting an existing key refreshes recency instead of growing", () => {
    // The cache-hit pattern: re-set the value just read so the displayed
    // source is always the newest entry, hence never the eviction victim.
    const m = new Map<string, number>();
    lruSet(m, "a", 1, 3);
    lruSet(m, "b", 2, 3);
    lruSet(m, "c", 3, 3);
    lruSet(m, "b", 2, 3); // hit → newest; size stays 3
    expect(m.size).toBe(3);
    lruSet(m, "d", 4, 3);
    expect(m.has("a")).toBe(false); // oldest UNTOUCHED entry went, not "b"
    expect([...m.keys()]).toEqual(["c", "b", "d"]);
  });

  it("never grows past the cap and keeps the newest entries", () => {
    const m = new Map<string, number>();
    for (let i = 0; i < 10; i++) lruSet(m, `k${i}`, i, 4);
    expect(m.size).toBe(4);
    expect([...m.keys()]).toEqual(["k6", "k7", "k8", "k9"]);
  });

  it("caches null distinctly from absent, and null entries share the cap", () => {
    // Mirrors the peaks cache: `null` = probed, no audio. It must read back
    // as a hit (so audio-less files aren't re-probed) yet still count toward
    // — and age out of — the same cap as real entries.
    const m = new Map<string, WaveformPeaks | null>();
    lruSet(m, "noaudio.mp4", null, 2);
    expect(m.get("noaudio.mp4")).toBeNull();
    expect(m.has("noaudio.mp4")).toBe(true);
    lruSet(m, "a.mov", createPeakBuckets(4), 2);
    lruSet(m, "b.mov", createPeakBuckets(4), 2);
    expect(m.has("noaudio.mp4")).toBe(false);
    expect(m.size).toBe(2);
  });
});

describe("foldPeaks", () => {
  it("captures a sine's amplitude in every bucket it spans", () => {
    // 10s at 1kHz, 5Hz sine, amplitude 0.8 → every 1s bucket sees 5 full
    // cycles, so each bucket's min/max lands within a hair of ±0.8.
    const rate = 1000;
    const dur = 10;
    const amp = 0.8;
    const samples = new Float32Array(dur * rate);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = amp * Math.sin((2 * Math.PI * 5 * i) / rate);
    }
    const p = createPeakBuckets(10);
    foldPeaks(p, samples, rate, 0, dur);
    // Float32 storage rounds 0.8 up a hair, hence the epsilon headroom.
    const eps = 1e-6;
    for (let b = 0; b < 10; b++) {
      expect(p.maxs[b]).toBeGreaterThan(amp - 0.01);
      expect(p.maxs[b]).toBeLessThanOrEqual(amp + eps);
      expect(p.mins[b]).toBeLessThan(-(amp - 0.01));
      expect(p.mins[b]).toBeGreaterThanOrEqual(-amp - eps);
    }
  });

  it("leaves silence at zero", () => {
    const p = createPeakBuckets(4);
    foldPeaks(p, new Float32Array(400), 100, 0, 4);
    expect(Array.from(p.mins)).toEqual([0, 0, 0, 0]);
    expect(Array.from(p.maxs)).toEqual([0, 0, 0, 0]);
  });

  it("maps an offset chunk into the right bucket only", () => {
    // 10s timeline, 10 buckets, 100Hz. A 1s constant chunk starting at
    // t=3s must land entirely in bucket 3.
    const chunk = new Float32Array(100).fill(0.5);
    const p = createPeakBuckets(10);
    foldPeaks(p, chunk, 100, 3, 10);
    for (let b = 0; b < 10; b++) {
      expect(p.maxs[b]).toBe(b === 3 ? 0.5 : 0);
      expect(p.mins[b]).toBe(0); // constant positive never lowers a min
    }
  });

  it("folds min and max independently across calls (channels)", () => {
    const p = createPeakBuckets(1);
    foldPeaks(p, new Float32Array([0.3]), 1, 0, 1); // channel A
    foldPeaks(p, new Float32Array([-0.9]), 1, 0, 1); // channel B
    expect(p.maxs[0]).toBeCloseTo(0.3);
    expect(p.mins[0]).toBeCloseTo(-0.9);
  });

  it("drops samples outside [0, duration) without throwing", () => {
    // Chunk straddles the end: t=9.5s..10.5s on a 10s timeline. The first
    // half lands in the last bucket; the overshoot is ignored.
    const chunk = new Float32Array(100).fill(0.7);
    const p = createPeakBuckets(10);
    foldPeaks(p, chunk, 100, 9.5, 10);
    expect(p.maxs[9]).toBeCloseTo(0.7, 5); // float32 storage of 0.7
    expect(p.maxs[8]).toBe(0);
    // And a chunk entirely before zero is a no-op.
    foldPeaks(p, chunk, 100, -5, 10);
    expect(p.maxs[0]).toBe(0);
  });

  it("is a no-op for degenerate duration, rate, or bucket count", () => {
    const chunk = new Float32Array([1, -1]);
    const empty = createPeakBuckets(0);
    expect(() => foldPeaks(empty, chunk, 100, 0, 10)).not.toThrow();
    const p = createPeakBuckets(4);
    foldPeaks(p, chunk, 0, 0, 10); // bad rate
    foldPeaks(p, chunk, 100, 0, 0); // bad duration
    expect(Array.from(p.maxs)).toEqual([0, 0, 0, 0]);
  });

  it("folds an hour of 48kHz stereo within the compute budget", () => {
    // Synthetic stand-in for the real decode: 3600s × 48000Hz × 2ch folded
    // in 60s chunks (reused buffer, like the streaming sink). This measures
    // the linear fold pass, the only part of the pipeline we own — the
    // WebCodecs decode itself runs many× realtime natively.
    const rate = 48000;
    const chunkSec = 60;
    const dur = 3600;
    const chunk = new Float32Array(rate * chunkSec);
    for (let i = 0; i < chunk.length; i++) chunk[i] = Math.sin(i * 0.01) * 0.6;
    const p = createPeakBuckets(WAVEFORM_BUCKETS);
    const t0 = performance.now();
    for (let ch = 0; ch < 2; ch++) {
      for (let start = 0; start < dur; start += chunkSec) {
        foldPeaks(p, chunk, rate, start, dur);
      }
    }
    const ms = performance.now() - t0;
     
    console.info(`waveform fold: 1h 48kHz stereo in ${ms.toFixed(0)}ms`);
    expect(ms).toBeLessThan(10_000); // generous bound for slow CI runners
    expect(p.maxs[0]).toBeGreaterThan(0.5); // sanity: signal actually landed
    expect(p.mins[WAVEFORM_BUCKETS - 1]).toBeLessThan(-0.5);
  });
});
