import { describe, expect, it } from "vitest";
import { mayHideScrubOverlay, shouldFreezeOutgoingFrame } from "./scrub-freeze";

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

describe("mayHideScrubOverlay", () => {
  const settled = { settleArmed: false, rebuildPending: false, hasSourceBuffer: true };

  it("hides once the gesture has settled and the pipeline is live", () => {
    expect(mayHideScrubOverlay(settled)).toBe(true);
  });

  it("holds while the gesture is still running", () => {
    expect(mayHideScrubOverlay({ ...settled, settleArmed: true })).toBe(false);
  });

  it("HOLDS ACROSS A REBUILD, which is the five-second bug", () => {
    // The rebuild assigns a fresh MediaSource, and the element fires
    // `loadeddata` for that still-empty source. Hiding on it tore the overlay
    // down at exactly the moment it held the only picture, leaving black for
    // the ~3s ffmpeg needs to deliver a fragment.
    expect(
      mayHideScrubOverlay({ ...settled, rebuildPending: true }),
      "the overlay was hidden while a rebuild was about to start",
    ).toBe(false);
    expect(
      mayHideScrubOverlay({ ...settled, hasSourceBuffer: false }),
      "the overlay was hidden while the pipeline had no SourceBuffer",
    ).toBe(false);
  });
});
