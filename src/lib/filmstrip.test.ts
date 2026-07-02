import { describe, it, expect } from "vitest";
import { filmstripCount, filmstripTimestamps } from "./filmstrip";

describe("filmstripCount", () => {
  it("is 0 for unknown/zero width", () => {
    expect(filmstripCount(0)).toBe(0);
    expect(filmstripCount(-5)).toBe(0);
    expect(filmstripCount(NaN)).toBe(0);
  });

  it("aims for ~targetCellPx-wide cells", () => {
    expect(filmstripCount(720, 72)).toBe(10);
    expect(filmstripCount(360, 72)).toBe(6); // 5 rounded → clamped up to min 6
  });

  it("clamps to [min, max]", () => {
    expect(filmstripCount(50, 72)).toBe(6); // tiny track → min
    expect(filmstripCount(100000, 72)).toBe(24); // huge track → max
    expect(filmstripCount(100000, 72, 6, 40)).toBe(40);
  });
});

describe("filmstripTimestamps", () => {
  it("is empty for a bad duration or count", () => {
    expect(filmstripTimestamps(0, 5)).toEqual([]);
    expect(filmstripTimestamps(-1, 5)).toEqual([]);
    expect(filmstripTimestamps(10, 0)).toEqual([]);
  });

  it("centre-samples each cell, ascending, within [0, duration]", () => {
    const ts = filmstripTimestamps(10, 5); // cells of 2s → centres 1,3,5,7,9
    expect(ts).toEqual([1, 3, 5, 7, 9]);
    expect(ts.every((t, i) => i === 0 || t > ts[i - 1])).toBe(true); // strictly ascending
    expect(ts.every((t) => t >= 0 && t <= 10)).toBe(true);
  });

  it("returns exactly `count` timestamps", () => {
    expect(filmstripTimestamps(123.4, 17)).toHaveLength(17);
  });
});
