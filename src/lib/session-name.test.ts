import { describe, expect, it } from "vitest";
import { isSessionNameTaken, nextFreeSessionName, normalizeSessionName } from "./session-name";

describe("normalizeSessionName", () => {
  it("ignores case and surrounding or repeated space", () => {
    expect(normalizeSessionName("  Test   Session 4 ")).toBe("test session 4");
  });
});

describe("isSessionNameTaken", () => {
  const taken = ["Test Session 4", "Rough cut"];

  it("matches the way a person would, not byte for byte", () => {
    expect(isSessionNameTaken("test session 4", taken)).toBe(true);
    expect(isSessionNameTaken("  Test  Session 4  ", taken)).toBe(true);
  });

  it("a free name is free", () => {
    expect(isSessionNameTaken("Test Session 5", taken)).toBe(false);
  });

  it("an empty name is not a collision, just empty", () => {
    // Otherwise the lobby would report "that name is taken" at an empty field.
    expect(isSessionNameTaken("", taken)).toBe(false);
    expect(isSessionNameTaken("   ", taken)).toBe(false);
  });
});

describe("nextFreeSessionName", () => {
  it("leaves a free name alone", () => {
    expect(nextFreeSessionName("Rough cut", ["Other"])).toBe("Rough cut");
  });

  it("CONTINUES a trailing number instead of appending one", () => {
    // "Test Session 4 2" reads as a mistake, and is what makes people give up
    // and reuse the old name.
    expect(nextFreeSessionName("Test Session 4", ["Test Session 4"])).toBe("Test Session 5");
  });

  it("skips every number already used, in any order", () => {
    const taken = ["Test Session 6", "Test Session 4", "Test Session 5"];
    expect(nextFreeSessionName("Test Session 4", taken)).toBe("Test Session 7");
  });

  it("appends 2 to a name that ends in no number", () => {
    expect(nextFreeSessionName("Rough cut", ["Rough cut"])).toBe("Rough cut 2");
  });

  it("keeps the name's own spacing around the number", () => {
    expect(nextFreeSessionName("Review2", ["Review2"])).toBe("Review3");
    expect(nextFreeSessionName("Review 2", ["Review 2"])).toBe("Review 3");
  });

  it("normalises the name it returns, so the suggestion is the tidy one", () => {
    expect(nextFreeSessionName("  Rough   cut  ", ["Rough cut"])).toBe("Rough cut 2");
  });

  it("an empty name suggests nothing", () => {
    expect(nextFreeSessionName("   ", ["a"])).toBe("");
  });
});
