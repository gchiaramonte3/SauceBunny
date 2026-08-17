import { describe, expect, it } from "vitest";
import { METER_SEGMENTS, meterZoneClass, topLitIndex } from "./level-meter";

/**
 * The mic meter's segment maths.
 *
 * `startLevelMeter` itself needs an AudioContext, a live MediaStream and
 * requestAnimationFrame, so it is not worth mocking — you would be asserting
 * that the mocks were called. The part that was WRONG was pure arithmetic
 * buried in its animation frame, and pulling that out is what makes it
 * testable at all.
 *
 * The defect: the lit run and the peak-hold marker used different quantisers
 * for the same scalar. A segment lights at its midpoint (`level >= (i+0.5)/n`);
 * the marker bucketed at a segment's lower edge (`Math.floor(level * n)`). For
 * 46 of the 128 reachable peak values those disagree by exactly one, always the
 * same direction, so the marker sat one segment above the signal — and it
 * crossed zone boundaries, painting a near-solid red "peaking" bar at ordinary
 * speaking volume with nothing red lit.
 *
 * `peak` is an integer 0..128 from Uint8 time-domain samples and `level` is
 * `peak / 96` clamped to 1, so the reachable inputs are a small discrete set
 * and can be swept exhaustively rather than sampled. That sweep is the real
 * assertion here; the named cases below it are there to make a failure legible.
 */

const N = METER_SEGMENTS;
const levelFor = (peak: number) => Math.min(1, peak / 96);

/** What a segment lighting up actually means, stated independently. */
const isLit = (level: number, i: number, n: number) => level >= (i + 0.5) / n;

describe("the invariant that was broken", () => {
  it("never puts the hold marker above the highest lit segment, for any reachable peak", () => {
    // The whole bug in one assertion, swept over every input the analyser can
    // produce. holdLevel === level on any rising frame, so this is exactly the
    // situation at the moment of a peak.
    const offenders: string[] = [];
    for (let peak = 0; peak <= 128; peak++) {
      const level = levelFor(peak);
      const hold = topLitIndex(level, N);
      let highestLit = -1;
      for (let i = 0; i < N; i++) if (isLit(level, i, N)) highestLit = i;
      if (hold !== highestLit) {
        offenders.push(`peak ${peak}: marker ${hold}, highest lit ${highestLit}`);
      }
    }
    expect(offenders, "marker disagreed with the lit run").toEqual([]);
  });

  it("agrees with an independent reading of the lit rule at every index", () => {
    // Canary for the sweep above: if topLitIndex returned a constant, or isLit
    // were computed from topLitIndex rather than from the rule, the sweep would
    // pass while proving nothing.
    for (let peak = 0; peak <= 128; peak += 7) {
      const level = levelFor(peak);
      const top = topLitIndex(level, N);
      for (let i = 0; i < N; i++) {
        expect(i <= top, `peak ${peak}, segment ${i}`).toBe(isLit(level, i, N));
      }
    }
  });
});

describe("the specific peaks that used to misfire", () => {
  it("keeps a loud speaking voice out of the red", () => {
    // peak 84 ≈ -3.6 dBFS. Marker used to land on 14 (red) with 13 (yellow)
    // the highest lit.
    expect(topLitIndex(levelFor(84), N)).toBe(13);
    expect(meterZoneClass(13)).toContain("zone-yellow");
    for (const peak of [84, 85, 86]) expect(topLitIndex(levelFor(peak), N)).toBe(13);
  });

  it("still reaches red when the signal really is that hot", () => {
    // The other half — the fix must not make red unreachable.
    expect(topLitIndex(levelFor(87), N)).toBe(14);
    expect(meterZoneClass(14)).toContain("zone-red");
    expect(topLitIndex(levelFor(96), N)).toBe(15);
    expect(topLitIndex(levelFor(128), N)).toBe(15);
  });

  it("does not jump the green/yellow boundary early either", () => {
    // The same off-by-one at the other zone crossing: peak 60 lit up to 9
    // (last green) while the marker sat on 10 (first yellow).
    expect(topLitIndex(levelFor(60), N)).toBe(9);
    expect(meterZoneClass(9)).toContain("zone-green");
    expect(meterZoneClass(10)).toContain("zone-yellow");
  });
});

describe("silence and near-silence", () => {
  it("shows no marker at true silence", () => {
    expect(topLitIndex(0, N)).toBe(-1);
  });

  it("shows no marker for a signal too small to light anything", () => {
    // This replaced a separate `holdLevel > 0.02` gate, which sat at a
    // different threshold than the lit rule — peak 2 cleared it while no
    // segment was lit, so a marker floated over an empty strip.
    expect(topLitIndex(levelFor(2), N)).toBe(-1);
    expect(isLit(levelFor(2), 0, N)).toBe(false);
  });

  it("lights the first segment and the marker together", () => {
    // The threshold is now one number, not two: the first peak that lights
    // segment 0 is the first that shows a marker.
    let firstLit = -1;
    for (let peak = 0; peak <= 128; peak++) {
      if (isLit(levelFor(peak), 0, N)) { firstLit = peak; break; }
    }
    expect(firstLit, "no peak ever lights segment 0").toBeGreaterThan(0);
    expect(topLitIndex(levelFor(firstLit), N)).toBe(0);
    expect(topLitIndex(levelFor(firstLit - 1), N)).toBe(-1);
  });
});

describe("hostile and out-of-range input", () => {
  it("paints nothing for a non-finite level rather than guessing an end", () => {
    // All three are -1, including +Infinity. "We do not know the level" is not
    // the same as "the level is maximum", and a meter that invents a full-scale
    // reading from a bad frame is worse than one that shows nothing. Not
    // reachable from the analyser — peak comes from a Uint8Array, so peak/96 is
    // always finite — but it makes the -1..n-1 contract hold for every input.
    expect(topLitIndex(NaN, N)).toBe(-1);
    expect(topLitIndex(Infinity, N)).toBe(-1);
    expect(topLitIndex(-Infinity, N)).toBe(-1);
  });

  it("clamps above 1 rather than running off the end of the strip", () => {
    expect(topLitIndex(2, N)).toBe(N - 1);
    expect(topLitIndex(1, N)).toBe(N - 1);
  });

  it("returns -1 for a negative level", () => {
    expect(topLitIndex(-0.5, N)).toBe(-1);
  });

  it("survives a strip that has not rendered yet", () => {
    // getBars() can return an empty array on the first frame after mount.
    expect(topLitIndex(0.5, 0)).toBe(-1);
    expect(topLitIndex(0.5, -1)).toBe(-1);
  });

  it("works for strip sizes other than 16", () => {
    // Nothing forces n === METER_SEGMENTS at the call site; it is bars.length.
    expect(topLitIndex(1, 4)).toBe(3);
    expect(topLitIndex(0.5, 4)).toBe(1);
    expect(topLitIndex(0.1, 1)).toBe(-1);
    expect(topLitIndex(0.9, 1)).toBe(0);
  });
});

describe("zone classes", () => {
  it("splits 16 segments into 10 green, 4 yellow, 2 red", () => {
    // The doc comment's own claim, checked. A drifting boundary here changes
    // what "you are peaking" means without touching the meter maths.
    const zones = Array.from({ length: METER_SEGMENTS }, (_, i) => meterZoneClass(i));
    expect(zones.filter((z) => z.includes("zone-green"))).toHaveLength(10);
    expect(zones.filter((z) => z.includes("zone-yellow"))).toHaveLength(4);
    expect(zones.filter((z) => z.includes("zone-red"))).toHaveLength(2);
  });

  it("keeps the shared base class on every segment", () => {
    for (let i = 0; i < METER_SEGMENTS; i++) {
      expect(meterZoneClass(i)).toContain("cp-gr-meter-bar");
    }
  });

  it("changes zone exactly at 10 and 14", () => {
    expect(meterZoneClass(9)).toContain("zone-green");
    expect(meterZoneClass(10)).toContain("zone-yellow");
    expect(meterZoneClass(13)).toContain("zone-yellow");
    expect(meterZoneClass(14)).toContain("zone-red");
  });
});
