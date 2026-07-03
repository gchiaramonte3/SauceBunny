import { describe, expect, it } from "vitest";
import { SHUTTLE_LADDER, nextShuttleRate } from "./shuttle";

describe("nextShuttleRate", () => {
  it("exposes the canonical ladder", () => {
    expect(SHUTTLE_LADDER).toEqual([1, 2, 4, 8]);
  });

  it("walks the full ladder up on repeated L presses (0→1→2→4→8, then pinned at cap)", () => {
    expect(nextShuttleRate(0, 1)).toBe(1);
    expect(nextShuttleRate(1, 1)).toBe(2);
    expect(nextShuttleRate(2, 1)).toBe(4);
    expect(nextShuttleRate(4, 1)).toBe(8);
    expect(nextShuttleRate(8, 1)).toBe(8); // capped
  });

  it("mirrors the ladder for J (0→-1→-2→-4→-8, then pinned)", () => {
    expect(nextShuttleRate(0, -1)).toBe(-1);
    expect(nextShuttleRate(-1, -1)).toBe(-2);
    expect(nextShuttleRate(-2, -1)).toBe(-4);
    expect(nextShuttleRate(-4, -1)).toBe(-8);
    expect(nextShuttleRate(-8, -1)).toBe(-8); // capped
  });

  it("J against a forward shuttle steps back down the ladder, keeping sign", () => {
    expect(nextShuttleRate(8, -1)).toBe(4);
    expect(nextShuttleRate(4, -1)).toBe(2);
    expect(nextShuttleRate(2, -1)).toBe(1);
  });

  it("J at +1 flips to -1", () => {
    expect(nextShuttleRate(1, -1)).toBe(-1);
  });

  it("L against a reverse shuttle steps down then flips at -1", () => {
    expect(nextShuttleRate(-8, 1)).toBe(-4);
    expect(nextShuttleRate(-4, 1)).toBe(-2);
    expect(nextShuttleRate(-2, 1)).toBe(-1);
    expect(nextShuttleRate(-1, 1)).toBe(1);
  });

  it("honors a custom cap (MSE web player caps at 4×)", () => {
    expect(nextShuttleRate(2, 1, 4)).toBe(4);
    expect(nextShuttleRate(4, 1, 4)).toBe(4);   // pinned at the cap
    expect(nextShuttleRate(-4, -1, 4)).toBe(-4);
    // A rate above the cap (e.g. player swap mid-shuttle) is pulled back to it.
    expect(nextShuttleRate(8, 1, 4)).toBe(4);
  });

  it("clamps a non-ladder cap to the nearest ladder value below it", () => {
    expect(nextShuttleRate(2, 1, 5)).toBe(4);
    expect(nextShuttleRate(4, 1, 5)).toBe(4);
  });

  it("snaps non-ladder rates to the nearest rung before stepping (ties break down)", () => {
    expect(nextShuttleRate(3, 1)).toBe(4);    // 3 snaps to 2 → doubles to 4
    expect(nextShuttleRate(3, -1)).toBe(1);   // 3 snaps to 2 → steps down to 1
    expect(nextShuttleRate(-5, -1)).toBe(-8); // 5 snaps to 4 → doubles to 8
    expect(nextShuttleRate(0.5, 1)).toBe(2);  // 0.5 snaps to 1 → doubles to 2
    expect(nextShuttleRate(1.2, -1)).toBe(-1); // snaps to 1 → opposite at 1× flips
  });

  it("result is always a ladder value within the cap", () => {
    const dirs: Array<1 | -1> = [1, -1];
    for (const rate of [-9, -8, -3, -1, -0.25, 0, 0.25, 1, 3, 8, 9]) {
      for (const dir of dirs) {
        for (const cap of [1, 2, 4, 8]) {
          const next = nextShuttleRate(rate, dir, cap);
          expect(SHUTTLE_LADDER).toContain(Math.abs(next));
          expect(Math.abs(next)).toBeLessThanOrEqual(cap);
        }
      }
    }
  });
});
