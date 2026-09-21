import { describe, expect, it } from "vitest";
import { nativeSeekTarget } from "./native-seek-target";

describe("native frame-boundary target", () => {
  it("avoids WebKit truncating the fractional-rate cut into the preceding tick", () => {
    const nativeClock = (seconds: number) => Math.trunc(seconds * 10_000_000) / 10_000_000;
    expect(nativeClock(1.001)).toBe(1.0009999);
    expect(nativeClock(nativeSeekTarget(1.001))).toBe(1.001);
  });
  it.each([1.001, 3.003, 3600.001, 14400.125125])("only advances floating-point precision at %s", seconds => {
    const target = nativeSeekTarget(seconds);
    expect(target).toBeGreaterThan(seconds);
    expect(target - seconds).toBeLessThan(0.000001);
  });
  it("preserves zero and clamps at EOF instead of seeking past duration", () => {
    expect(nativeSeekTarget(0, 2.002)).toBe(0);
    expect(nativeSeekTarget(2.002, 2.002)).toBe(2.002);
    expect(nativeSeekTarget(3, 2.002)).toBe(2.002);
  });
});
