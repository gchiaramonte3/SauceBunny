import { describe, expect, it } from "vitest";
import {
  PLAYBACK_RATES, formatPlaybackRate, sanitizePlaybackRate, stepPlaybackRate,
} from "./playback-rate";

describe("sanitizePlaybackRate", () => {
  it("exposes the canonical rate list", () => {
    expect(PLAYBACK_RATES).toEqual([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);
  });

  it("passes canonical rates through unchanged", () => {
    for (const r of PLAYBACK_RATES) expect(sanitizePlaybackRate(r)).toBe(r);
  });

  it("snaps arbitrary numbers to the nearest rate", () => {
    expect(sanitizePlaybackRate(0.9)).toBe(1);
    expect(sanitizePlaybackRate(1.6)).toBe(1.5);
    expect(sanitizePlaybackRate(3)).toBe(2);
    expect(sanitizePlaybackRate(0.1)).toBe(0.5);
  });

  it("breaks exact ties toward 1×", () => {
    expect(sanitizePlaybackRate(0.875)).toBe(1); // midway between 0.75 and 1
  });

  it("falls back to 1× on junk (corrupt persisted blob)", () => {
    expect(sanitizePlaybackRate(undefined)).toBe(1);
    expect(sanitizePlaybackRate(null)).toBe(1);
    expect(sanitizePlaybackRate("fast")).toBe(1);
    expect(sanitizePlaybackRate(NaN)).toBe(1);
    expect(sanitizePlaybackRate(0)).toBe(1);
    expect(sanitizePlaybackRate(-2)).toBe(1);
    expect(sanitizePlaybackRate(Infinity)).toBe(1);
  });
});

describe("stepPlaybackRate", () => {
  it("walks up and down the list", () => {
    expect(stepPlaybackRate(1, 1)).toBe(1.25);
    expect(stepPlaybackRate(1.25, 1)).toBe(1.5);
    expect(stepPlaybackRate(1, -1)).toBe(0.75);
    expect(stepPlaybackRate(0.75, -1)).toBe(0.5);
  });

  it("pins at the ends", () => {
    expect(stepPlaybackRate(2, 1)).toBe(2);
    expect(stepPlaybackRate(0.5, -1)).toBe(0.5);
  });

  it("snaps a non-list rate before stepping", () => {
    expect(stepPlaybackRate(1.6, 1)).toBe(1.75); // snaps to 1.5, then up
    expect(stepPlaybackRate(9, -1)).toBe(1.75);  // snaps to 2, then down
    expect(stepPlaybackRate(NaN, 1)).toBe(1.25); // junk → 1×, then up
  });
});

describe("formatPlaybackRate", () => {
  it("renders compact badges", () => {
    expect(formatPlaybackRate(1)).toBe("1×");
    expect(formatPlaybackRate(0.75)).toBe("0.75×");
    expect(formatPlaybackRate(1.5)).toBe("1.5×");
    expect(formatPlaybackRate(2)).toBe("2×");
  });
});
