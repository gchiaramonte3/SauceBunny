import { describe, expect, it } from "vitest";
import { createClockEstimator, expectedPosition } from "./session-clock";

describe("session clock offset", () => {
  it("reports nothing until it has enough samples", () => {
    const c = createClockEstimator();
    expect(c.offsetMs()).toBeNull();
    c.sample(1000, 3000);
    c.sample(1500, 3500);
    expect(c.offsetMs()).toBeNull(); // 2 samples is not a measurement
  });

  it("converges on the true offset despite variable network delay", () => {
    // Receiver clock runs 2000ms ahead. Each sample also carries some
    // one-sided transit delay, so the MINIMUM is the least-polluted estimate.
    const c = createClockEstimator();
    const OFFSET = 2000;
    for (const delay of [140, 90, 300, 35, 220, 60]) {
      const sentAt = 10_000;
      c.sample(sentAt, sentAt + OFFSET + delay);
    }
    // The fastest sample (35ms) sets the floor - never an UNDER-estimate.
    expect(c.offsetMs()).toBe(OFFSET + 35);
  });

  it("forgets everything on reset (a new presenter is a new clock)", () => {
    const c = createClockEstimator();
    for (let i = 0; i < 6; i++) c.sample(0, 500);
    expect(c.offsetMs()).not.toBeNull();
    c.reset();
    expect(c.offsetMs()).toBeNull();
  });
});

describe("expectedPosition", () => {
  const msg = { position: 100, playing: true, rate: 1, atMs: 50_000 };

  it("does not extrapolate while the offset is unknown", () => {
    // Conservative: trust the reported position rather than skew it by an
    // unmeasured clock difference.
    expect(expectedPosition(msg, 999_999, null)).toBe(100);
  });

  it("extrapolates elapsed time once the offset is known", () => {
    // Receiver is 2000ms ahead; 1s of real time has passed since the stamp.
    expect(expectedPosition(msg, 53_000, 2000)).toBeCloseTo(101, 5);
  });

  it("a pure clock offset produces NO drift", () => {
    // The bug this module exists for: differencing raw wall clocks made a
    // 2s machine offset look like 2s of playback drift, forever.
    expect(expectedPosition(msg, 52_000, 2000)).toBeCloseTo(100, 5);
  });

  it("honours playback rate", () => {
    expect(expectedPosition({ ...msg, rate: 2 }, 53_000, 2000)).toBeCloseTo(102, 5);
  });

  it("never extrapolates while paused", () => {
    expect(expectedPosition({ ...msg, playing: false }, 999_999, 2000)).toBe(100);
  });
});
