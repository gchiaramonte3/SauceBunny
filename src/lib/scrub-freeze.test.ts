import { describe, expect, it } from "vitest";
import { shouldFreezeOutgoingFrame } from "./scrub-freeze";

describe("shouldFreezeOutgoingFrame", () => {
  const drawable = { readyState: 2, videoWidth: 1920 };

  it("NEVER overwrites a decoded frame", () => {
    // THE REGRESSION, in one assertion. On an out-of-buffer drag the <video>
    // is still parked where the gesture started, so freezing it over the
    // decoder's target frame snapped the picture back the moment the user
    // let go - reported as "it was frame-accurate before, now it is ruined".
    expect(
      shouldFreezeOutgoingFrame({ ...drawable, previewPainted: true }),
      "the outgoing frame was drawn over a decoded one",
    ).toBe(false);
  });

  it("freezes when the overlay is holding nothing", () => {
    // The case it exists for: a peer stream (decoder deliberately off) or the
    // moments before the first decoded paint. Without it the element blanks
    // and the viewer gets the monitor's black for the whole rebuild.
    expect(shouldFreezeOutgoingFrame({ ...drawable, previewPainted: false })).toBe(true);
  });

  it("will not draw a video that has nothing to draw", () => {
    // drawImage of a zero-width or undecoded video throws, and the catch
    // would swallow it - so the guard is here rather than in the try.
    expect(shouldFreezeOutgoingFrame({ previewPainted: false, readyState: 0, videoWidth: 1920 })).toBe(false);
    expect(shouldFreezeOutgoingFrame({ previewPainted: false, readyState: 2, videoWidth: 0 })).toBe(false);
  });
});
