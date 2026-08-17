import { describe, expect, it } from "vitest";
import {
  durationToTc, framesToTc, secondsToClock, secondsToHms, secondsToTc,
} from "./timecode";

/**
 * No formatter may render a non-finite number.
 *
 * `secondsToHms` and `secondsToClock` were fixed for this earlier — they used
 * to produce "NaN:NaN" and "Infinity:NaN:NaN" — and `durationToTc` has always
 * guarded. `framesToTc` and `secondsToTc` were missed, and still printed
 * "NaN:NaN:NaN:NaN" and "Infinity:NaN:NaN:NaN" until this file existed.
 *
 * The trap is that `framesToTc` LOOKED guarded: `Math.max(0, Math.floor(x))`
 * reads like a clamp, but `Math.floor(NaN)` is NaN and `Math.max(0, NaN)` is
 * NaN, so it passes straight through. A reviewer scanning for a missing clamp
 * would find one and move on.
 *
 * Reachable rather than theoretical. `fps` rides in queue items restored from
 * localStorage and in metadata that carries none of its own, and a single NaN
 * there reaches the mark in/out fields, the queue's log lines, and the
 * duration on every recent clip. `<video>.duration` is NaN before metadata
 * arrives and Infinity for an unbounded stream, which is the same reasoning
 * the guarded siblings already carry.
 *
 * Whole family in one file so the next formatter added is checked against the
 * same list rather than rediscovering this.
 */

const HOSTILE: Array<[string, number]> = [
  ["NaN", NaN],
  ["Infinity", Infinity],
  ["-Infinity", -Infinity],
];

describe("timecode formatters refuse non-finite input", () => {
  it("still formats ordinary values", () => {
    // The canary. Every assertion below is about garbage in; a formatter that
    // returned a constant would satisfy all of them.
    expect(secondsToTc(83.45, 25)).toBe("00:01:23:11");
    expect(framesToTc(2086, 25)).toBe("00:01:23:11");
    expect(durationToTc(83.45, 25)).toBe("00:01:23:11");
    expect(secondsToHms(3723)).toBe("01:02:03");
    expect(secondsToClock(83)).toBe("1:23");
  });

  for (const [label, v] of HOSTILE) {
    it(`framesToTc(${label}) is a timecode, not a string with NaN in it`, () => {
      expect(framesToTc(v, 25)).toBe("00:00:00:00");
    });
    it(`secondsToTc(${label}) is a timecode, not a string with NaN in it`, () => {
      expect(secondsToTc(v, 25)).toBe("00:00:00:00");
    });
    it(`durationToTc(${label}) stays guarded`, () => {
      expect(durationToTc(v, 25)).toBe("00:00:00:00");
    });
    it(`secondsToHms(${label}) and secondsToClock(${label}) stay guarded`, () => {
      expect(secondsToHms(v)).toBe("00:00:00");
      expect(secondsToClock(v)).toBe("0:00");
    });
  }

  it("a non-finite FPS is refused too, not just a non-finite time", () => {
    // The other half of the same hazard: fps comes from metadata and from
    // restored queue items, so it is exactly as likely to arrive broken as
    // the frame count is.
    expect(secondsToTc(10, NaN)).toBe("00:00:00:00");
    expect(framesToTc(250, NaN)).toBe("00:00:00:00");
    expect(framesToTc(250, Infinity)).toBe("00:00:00:00");
  });

  it("negative input still clamps rather than going non-finite", () => {
    // Distinct from the above: -1 is finite, so it must reach the existing
    // Math.max(0, …) clamp and produce zero, not be short-circuited.
    expect(framesToTc(-1, 25)).toBe("00:00:00:00");
    expect(secondsToTc(-5, 25)).toBe("00:00:00:00");
  });
});
