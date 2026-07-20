import { describe, expect, it } from "vitest";
import { parseSemver, compareSemver, isNewer } from "./update-check";

describe("parseSemver", () => {
  it("accepts bare and v-prefixed versions", () => {
    expect(parseSemver("0.2.0")).toEqual({ major: 0, minor: 2, patch: 0 });
    expect(parseSemver("v0.2.0")).toEqual({ major: 0, minor: 2, patch: 0 });
    expect(parseSemver("  v1.10.3 ")).toEqual({ major: 1, minor: 10, patch: 3 });
  });

  it("rejects anything that is not bare X.Y.Z", () => {
    // The version scheme guarantees bare semver; a prerelease or build-metadata
    // tag would compare wrongly, so refusing to parse is the safe answer.
    for (const bad of ["1.0", "1.0.0-beta", "1.0.0+build", "2026.07.04", "latest", ""]) {
      expect(parseSemver(bad), bad).toBeNull();
    }
  });
});

describe("compareSemver", () => {
  it("orders by major, then minor, then patch", () => {
    const v = (s: string) => parseSemver(s)!;
    expect(compareSemver(v("1.0.0"), v("0.9.9"))).toBeGreaterThan(0);
    expect(compareSemver(v("0.2.0"), v("0.10.0"))).toBeLessThan(0); // not string order
    expect(compareSemver(v("1.2.3"), v("1.2.3"))).toBe(0);
  });
});

describe("isNewer", () => {
  it("detects a real upgrade", () => {
    expect(isNewer("0.3.0", "0.2.0")).toBe(true);
    expect(isNewer("v0.2.1", "0.2.0")).toBe(true);
  });

  it("does not nag when current or newer", () => {
    expect(isNewer("0.2.0", "0.2.0")).toBe(false);
    expect(isNewer("0.1.0", "0.2.0")).toBe(false);
  });

  it("stays silent when either side is unparseable", () => {
    // An odd tag must never produce a phantom update prompt.
    expect(isNewer("nightly", "0.2.0")).toBe(false);
    expect(isNewer("0.3.0", "unknown")).toBe(false);
  });
});
