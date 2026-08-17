import { describe, expect, it } from "vitest";
import { audioAnchorWaitMs, audioVitals, shouldRetakeAnchor } from "./av-clock";

describe("shouldRetakeAnchor — the silent-Opus regression", () => {
  // The reported scenario, in numbers: a 5.5s AV1 + Opus file. AV1 decodes on
  // WebCodecs hardware in ~50ms, so the video loop anchors at its deadline;
  // libopus is still instantiating. Its first buffer (20ms of audio at media
  // time 0) is handed over 800ms after the clock started, i.e. entirely in the
  // past. Without the retake this chunk is dropped, and so is every chunk
  // after it, forever: perfect picture, no sound.
  const opusFirstBufferAfterColdStart = {
    firstOfGeneration: true,
    scheduledCount: 0,
    wouldLandAt: 0.0,
    chunkDuration: 0.02,
    now: 0.8,
  };

  it("takes the clock back when video anchored during decoder warm-up", () => {
    expect(shouldRetakeAnchor(opusFirstBufferAfterColdStart)).toBe(true);
  });

  it("does NOT retake once any audio has been scheduled", () => {
    // Nothing may rewind the clock after the listener has heard something.
    expect(shouldRetakeAnchor({ ...opusFirstBufferAfterColdStart, scheduledCount: 1 })).toBe(false);
  });

  it("does NOT retake on later chunks — a mid-playback hiccup must drop, not rewind", () => {
    // This is the case the drop rule exists for: one late chunk after a stall.
    // Re-anchoring here would rewind the master clock by the whole lateness.
    expect(shouldRetakeAnchor({ ...opusFirstBufferAfterColdStart, firstOfGeneration: false })).toBe(false);
  });

  it("does NOT retake a chunk that is merely late but still partly playable", () => {
    // 20ms chunk landing 10ms ago: half of it is still ahead of the clock, so
    // the normal path trims and plays it. Only a chunk whose ENTIRE duration
    // has elapsed is evidence the anchor itself is wrong.
    expect(shouldRetakeAnchor({
      firstOfGeneration: true, scheduledCount: 0,
      wouldLandAt: 0.99, chunkDuration: 0.02, now: 1.0,
    })).toBe(false);
  });

  it("does NOT retake when audio won the anchor race normally (warm decoder)", () => {
    // The healthy path: the first buffer lands slightly AHEAD of the clock.
    expect(shouldRetakeAnchor({
      firstOfGeneration: true, scheduledCount: 0,
      wouldLandAt: 1.05, chunkDuration: 0.02, now: 1.0,
    })).toBe(false);
  });

  it("treats an exactly-elapsed chunk as retakeable (boundary)", () => {
    expect(shouldRetakeAnchor({
      firstOfGeneration: true, scheduledCount: 0,
      wouldLandAt: 0.5, chunkDuration: 0.1, now: 0.6,
    })).toBe(true);
  });
});

describe("audioAnchorWaitMs", () => {
  it("waits far longer for a cold decoder than a warm one", () => {
    // The bug was a fixed 500ms wait: long enough for a hardware decoder,
    // far too short for a WASM instantiate.
    expect(audioAnchorWaitMs(false)).toBeGreaterThan(audioAnchorWaitMs(true));
    expect(audioAnchorWaitMs(true)).toBe(500);
  });

  it("keeps the cold wait bounded so a dead audio track cannot freeze the picture", () => {
    expect(audioAnchorWaitMs(false)).toBeLessThanOrEqual(3000);
  });
});

describe("audioVitals", () => {
  const base = { scheduled: 0, dropped: 0, contextState: "running", gain: 1 };

  it("warns when the loop ran and scheduled nothing", () => {
    // The reported bug, as a number: h264/aac decoded, picture perfect, and
    // not one buffer ever handed to the speakers. Before this the log for that
    // run was indistinguishable from a healthy one.
    const v = audioVitals({ ...base, scheduled: 0, dropped: 0 });
    expect(v.tag).toBe("warn");
    expect(v.message).toContain("nothing reached the speakers");
  });

  it("does NOT warn on heavy dropping while audio is still being heard", () => {
    // Dropping late chunks is how playback re-syncs after a stall, so a big
    // drop count next to real scheduling is recovery working. Warning here
    // would train the reader to ignore the one line that matters.
    const v = audioVitals({ ...base, scheduled: 120, dropped: 400 });
    expect(v.tag).toBe("info");
    expect(v.message).toContain("audio: playing -");
  });

  it("distinguishes muted from broken", () => {
    // A running context at zero gain is a user with the volume down. Calling
    // that healthy is technically true and useless; calling it broken sends
    // someone hunting a decoder bug that is not there.
    const v = audioVitals({ ...base, scheduled: 120, gain: 0 });
    expect(v.tag).toBe("info");
    expect(v.message).toContain("muted");
  });

  it("names a suspended context, the silent-with-a-frozen-clock case", () => {
    const v = audioVitals({ ...base, scheduled: 0, contextState: "suspended" });
    expect(v.message).toContain("context suspended");
    expect(v.tag).toBe("warn");
  });

  it("always reports all four vitals, so one line is enough to triage", () => {
    const v = audioVitals({ scheduled: 7, dropped: 3, contextState: "running", gain: 0.5 });
    expect(v.message).toContain("7 scheduled");
    expect(v.message).toContain("3 dropped");
    expect(v.message).toContain("context running");
    expect(v.message).toContain("gain 0.50");
  });
});
