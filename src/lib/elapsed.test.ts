import { describe, expect, it } from "vitest";
import { fmtElapsed, stageLabel } from "./elapsed";

describe("fmtElapsed", () => {
  it("reads naturally at every scale", () => {
    expect(fmtElapsed(820)).toBe("820ms");
    expect(fmtElapsed(45_200)).toBe("45.2s");
    expect(fmtElapsed(368_000)).toBe("6m 08s");
    expect(fmtElapsed(3_840_000)).toBe("1h 04m");
  });

  it("stays on the right side of each unit switch", () => {
    expect(fmtElapsed(999)).toBe("999ms");
    expect(fmtElapsed(59_000)).toBe("59.0s");
    expect(fmtElapsed(60_000)).toBe("1m 00s");
  });

  it("matches the Rust formatter's output for the same inputs", () => {
    // Mirrors src-tauri/src/commands/mod.rs elapsed_tests, so one pipeline
    // log never mixes two duration styles.
    expect(fmtElapsed(820)).toBe("820ms");
    expect(fmtElapsed(368_000)).toBe("6m 08s");
  });

  it("never emits a negative or NaN duration", () => {
    expect(fmtElapsed(-5)).toBe("0ms");
    expect(fmtElapsed(Number.NaN)).toBe("0ms");
  });
});

describe("stageLabel", () => {
  it("names the pipeline stages a human recognises", () => {
    expect(stageLabel("whisper")).toBe("Whisper");
    expect(stageLabel("diarize-process")).toBe("Speaker detection");
  });
  it("passes an unknown phase through rather than inventing a name", () => {
    expect(stageLabel("some-future-stage")).toBe("some-future-stage");
  });
});
