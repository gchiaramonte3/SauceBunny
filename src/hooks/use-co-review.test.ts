import { describe, expect, it } from "vitest";
import { decideChase, type ChaseInput } from "./use-co-review";

// The two confirmed RC3 failure modes from the 2026-07-18 review, pinned as
// pure decision tests (the hook wires decideChase into the transport
// heartbeat; these sequences replay the exact bug reports).

const base: ChaseInput = {
  justLoaded: false,
  localSeekHot: false,
  playing: false,
  curSeconds: 100,
  expectedSeconds: 100,
  hostScrubbed: false,
};

describe("co-review chase decisions", () => {
  it("paused host double-scrub: the yielded edge survives, the guest lands on P2", () => {
    // Host scrubs to P1; the chase's own correction armed the latch, so the
    // NEXT heartbeat (host now at P2) arrives with the latch hot.
    const yielded = decideChase({
      ...base, localSeekHot: true, hostScrubbed: true,
      curSeconds: 50, expectedSeconds: 80,
    });
    expect(yielded.seekSeconds).toBeNull();
    // THE fix: yielding must not consume the scrub edge.
    expect(yielded.commitHostPos).toBe(false);

    // Latch expired; because the edge was not consumed, hostScrubbed is
    // still true and the paused guest finally jumps to P2.
    const after = decideChase({
      ...base, hostScrubbed: true, curSeconds: 50, expectedSeconds: 80,
    });
    expect(after.seekSeconds).toBe(80);
    expect(after.commitHostPos).toBe(true);
  });

  it("guest frame-steps during host playback: the latch protects them", () => {
    const d = decideChase({
      ...base, playing: true, localSeekHot: true,
      curSeconds: 90, expectedSeconds: 100,
    });
    expect(d.seekSeconds).toBeNull();
    expect(d.commitHostPos).toBe(false);
  });

  it("playing: drift beyond 0.5s chases, small drift does not", () => {
    expect(decideChase({ ...base, playing: true, curSeconds: 99.8, expectedSeconds: 100 }).seekSeconds).toBeNull();
    expect(decideChase({ ...base, playing: true, curSeconds: 98, expectedSeconds: 100 }).seekSeconds).toBe(100);
  });

  it("paused: a glance at a nearby frame is not yanked back", () => {
    const d = decideChase({ ...base, curSeconds: 101.5, expectedSeconds: 100, hostScrubbed: false });
    expect(d.seekSeconds).toBeNull();
    expect(d.commitHostPos).toBe(true);
  });

  it("just-loaded guest snaps to the host even with the latch hot", () => {
    const d = decideChase({
      ...base, justLoaded: true, localSeekHot: true,
      curSeconds: 0, expectedSeconds: 640,
    });
    expect(d.seekSeconds).toBe(640);
  });
});
