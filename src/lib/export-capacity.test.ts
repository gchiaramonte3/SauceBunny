import { describe, expect, it } from "vitest";
import {
  BUFFER_TARGET_MAX_BYTES, isBufferCeilingError, willExceedBufferTarget,
} from "./export-capacity";

const GB = 1024 ** 3;

describe("isBufferCeilingError", () => {
  it("recognises mediabunny's own ceiling message", () => {
    // Verbatim from node_modules/mediabunny/dist/modules/src/target.js.
    const err = new Error(
      "ArrayBuffer exceeded maximum size of 4294967296 bytes. Please consider using another target.",
    );
    expect(isBufferCeilingError(err)).toBe(true);
  });

  it("recognises an engine-level allocation failure as the same situation", () => {
    expect(isBufferCeilingError(new Error("Array buffer allocation failed"))).toBe(true);
    expect(isBufferCeilingError(new Error("Invalid array buffer length"))).toBe(true);
  });

  it("does NOT swallow a real conversion failure", () => {
    // Misclassifying these would silently route a genuine bug to the ffmpeg
    // pipeline and hide it.
    expect(isBufferCeilingError(new Error("no decoder for hev1"))).toBe(false);
    expect(isBufferCeilingError(new Error("ConversionCanceledError"))).toBe(false);
    expect(isBufferCeilingError(null)).toBe(false);
    expect(isBufferCeilingError(undefined)).toBe(false);
  });
});

describe("willExceedBufferTarget", () => {
  it("flags a whole-file export bigger than the cap", () => {
    expect(willExceedBufferTarget({
      inputBytes: 6 * GB, durationSeconds: 600, startSeconds: null, endSeconds: null,
    })).toBe(true);
  });

  it("does not flag a short cut out of a huge file", () => {
    // 30s of a 10-minute 6 GB ProRes file is ~300 MB — mediabunny's path, and
    // it is roughly 3x faster than ffmpeg on ProRes.
    expect(willExceedBufferTarget({
      inputBytes: 6 * GB, durationSeconds: 600, startSeconds: 10, endSeconds: 40,
    })).toBe(false);
  });

  it("flags a long cut out of a huge file", () => {
    expect(willExceedBufferTarget({
      inputBytes: 12 * GB, durationSeconds: 600, startSeconds: 0, endSeconds: 500,
    })).toBe(true);
  });

  it("says no when it cannot tell", () => {
    // A wrong "too big" pushes work to the slower pipeline for nothing, and
    // the catch is there to cover a miss.
    expect(willExceedBufferTarget({
      inputBytes: 0, durationSeconds: null, startSeconds: null, endSeconds: null,
    })).toBe(false);
    // Unknown duration: decline to guess. Assuming the whole file would send
    // a short cut off a huge source to the slower pipeline for nothing, and
    // the catch around the Conversion still covers a real overflow.
    expect(willExceedBufferTarget({
      inputBytes: 6 * GB, durationSeconds: null, startSeconds: null, endSeconds: null,
    })).toBe(false);
  });

  it("leaves headroom below the hard cap", () => {
    // BufferTarget doubles as it grows and fails when the NEXT doubling would
    // cross, so sizing right up to the limit still throws.
    expect(willExceedBufferTarget({
      inputBytes: BUFFER_TARGET_MAX_BYTES - 1, durationSeconds: 100,
      startSeconds: null, endSeconds: null,
    })).toBe(true);
  });

  it("treats a zero or inverted trim span as the whole file", () => {
    expect(willExceedBufferTarget({
      inputBytes: 6 * GB, durationSeconds: 600, startSeconds: 100, endSeconds: 100,
    })).toBe(true);
  });
});
