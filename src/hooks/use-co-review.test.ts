import { describe, expect, it } from "vitest";
import { advertisedPosition, decideChase, type ChaseInput } from "./use-co-review";
import { setScrubbing, subscribeScrub } from "../lib/playhead-store";

// The two confirmed RC3 failure modes from the 2026-07-18 review, pinned as
// pure decision tests (the hook wires decideChase into the transport
// heartbeat; these sequences replay the exact bug reports).

const base: ChaseInput = {
  justLoaded: false,
  localSeekHot: false,
  playing: false,
  curSeconds: 100,
  expectedSeconds: 100,
  hostScrubbed: false, hostStepped: false, sinceLastChaseMs: 9999,
  pendingChaseSeconds: null,
};

/** The hook derives both from the same delta, so a scrub IS a step - any
 *  case modelling a host scrub must set both, as the hook would. */
const scrubbed = { hostScrubbed: true, hostStepped: true };

describe("co-review chase decisions", () => {
  it("paused host double-scrub: the yielded edge survives, the guest lands on P2", () => {
    // Host scrubs to P1; the chase's own correction armed the latch, so the
    // NEXT heartbeat (host now at P2) arrives with the latch hot.
    const yielded = decideChase({
      ...base, ...scrubbed, localSeekHot: true, sinceLastChaseMs: 9999,
      curSeconds: 50, expectedSeconds: 80,
    });
    expect(yielded.seekSeconds).toBeNull();
    // THE fix: yielding must not consume the scrub edge.
    expect(yielded.commitHostPos).toBe(false);

    // Latch expired; because the edge was not consumed, hostScrubbed is
    // still true and the paused guest finally jumps to P2.
    const after = decideChase({
      ...base, ...scrubbed, sinceLastChaseMs: 9999, curSeconds: 50, expectedSeconds: 80,
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

  it("leaves small playing drift alone but corrects a real gap", () => {
    // Under tolerance: a clock estimate is never perfect and a normal offset
    // must not order a seek on every 500ms heartbeat.
    const calm = decideChase({ ...base, playing: true, curSeconds: 100, expectedSeconds: 100.6 });
    expect(calm.seekSeconds).toBeNull();
    const real = decideChase({ ...base, playing: true, curSeconds: 100, expectedSeconds: 103 });
    expect(real.seekSeconds).toBe(103);
  });

  it("will not issue a second chase seek while the first is still landing", () => {
    const hot = decideChase({
      ...base, playing: true, curSeconds: 100, expectedSeconds: 110, sinceLastChaseMs: 200,
    });
    expect(hot.seekSeconds).toBeNull();
    const settled = decideChase({
      ...base, playing: true, curSeconds: 100, expectedSeconds: 110, sinceLastChaseMs: 1500,
    });
    expect(settled.seekSeconds).toBe(110);
  });

  it("the just-loaded snap ignores the cooldown", () => {
    const d = decideChase({
      ...base, justLoaded: true, curSeconds: 0, expectedSeconds: 640, sinceLastChaseMs: 0,
    });
    expect(d.seekSeconds).toBe(640);
  });
});

describe("paused frame-stepping (the audit's top finding)", () => {
  // A 24fps step is 0.0417s: an order of magnitude under the 0.25s scrub
  // threshold, so the old paused branch ignored it - and because the no-op
  // branch commits the host position, fifty steps in a row never accumulated
  // past the threshold either. The room reviewed different frames while the
  // source bar said "frame accurate".
  it("a single 24fps step reaches the paused guest", () => {
    const d = decideChase({
      ...base, hostStepped: true, hostScrubbed: false,
      curSeconds: 100, expectedSeconds: 100 + 1 / 24,
    });
    expect(d.seekSeconds, "the step was swallowed").toBe(100 + 1 / 24);
    expect(d.commitHostPos).toBe(true);
  });

  it("a static host still never yanks a wandering paused guest", () => {
    // The guest wandered 5s away and the host has NOT moved: parked is
    // correct, and this is the property the old threshold was protecting.
    const d = decideChase({
      ...base, hostStepped: false, hostScrubbed: false,
      curSeconds: 105, expectedSeconds: 100,
    });
    expect(d.seekSeconds).toBeNull();
  });

  it("a guest already on the stepped frame is left alone", () => {
    const d = decideChase({
      ...base, hostStepped: true, hostScrubbed: false,
      curSeconds: 100 + 1 / 24, expectedSeconds: 100 + 1 / 24,
    });
    expect(d.seekSeconds).toBeNull();
  });
});

describe("advertisedPosition, what a presenter tells the room mid-drag", () => {
  it("advertises the live playhead when nobody is dragging", () => {
    expect(advertisedPosition(12.5, false, null)).toEqual({ position: 12.5, held: null });
  });

  it("holds the frame the room was already on, for the whole drag", () => {
    // THE FIX. Each distinct position advertised mid-drag costs every guest a
    // seek, and on a web source a seek is a full ffmpeg stream rebuild - so a
    // drag used to spend guests several rebuilds chasing frames nobody chose.
    const a = advertisedPosition(20, true, null);
    expect(a).toEqual({ position: 20, held: 20 });
    // The playhead runs away under the pointer; the advertisement does not.
    expect(advertisedPosition(41, true, a.held).position).toBe(20);
    expect(advertisedPosition(78, true, a.held).position).toBe(20);
    expect(advertisedPosition(9, true, a.held).position).toBe(20);
  });

  it("releases to wherever the drag stopped", () => {
    const held = advertisedPosition(20, true, null).held;
    // One seek for the room, to the only frame that was ever chosen.
    expect(advertisedPosition(96.25, false, held)).toEqual({ position: 96.25, held: null });
  });

  it("holds a paused presenter's position at zero without treating it as unset", () => {
    // `held ?? live` must not re-arm on a legitimate 0 - the top of a clip is
    // exactly where a review starts, so this is the common case, not an edge.
    const a = advertisedPosition(0, true, null);
    expect(a.held).toBe(0);
    expect(advertisedPosition(55, true, a.held).position).toBe(0);
  });
});

describe("the scrub flag the heartbeat reads", () => {
  it("notifies on real changes only, so settling sends exactly one beat", () => {
    const seen: boolean[] = [];
    const off = subscribeScrub((a) => seen.push(a));
    setScrubbing(true);
    setScrubbing(true);   // still the same drag
    setScrubbing(false);
    setScrubbing(false);
    off();
    setScrubbing(true);   // nobody listening any more
    expect(seen).toEqual([true, false]);
    setScrubbing(false);
  });
});

describe("the chase does not re-order a seek it is still waiting on", () => {
  // A web seek rebuilds the whole ffmpeg pipeline and takes SECONDS; the
  // cooldown is one. Without this guard the chase re-issues the same position
  // it is already heading to, and each re-issue throws away the rebuild that
  // was about to deliver the picture - so a guest never settles and the
  // monitor stays on its own black. Reported twice as "scrubbing in a live
  // session and not seeing the frames".
  const chasing: ChaseInput = {
    justLoaded: false, localSeekHot: false, playing: true,
    curSeconds: 100, expectedSeconds: 140, hostScrubbed: true, hostStepped: true,
    sinceLastChaseMs: 9999, pendingChaseSeconds: null,
  };

  it("orders the first correction", () => {
    expect(decideChase(chasing).seekSeconds).toBe(140);
  });

  it("does NOT order it again while the player is still on its way", () => {
    // Same destination, player has not arrived: this is the same instruction
    // arriving twice, not a new correction.
    const d = decideChase({ ...chasing, pendingChaseSeconds: 140 });
    expect(d.seekSeconds, "the chase restarted the rebuild it was waiting on").toBeNull();
    // It must still consume the host position, or the scrub edge is lost and
    // a paused guest strands - the failure a previous fix here caused.
    expect(d.commitHostPos).toBe(true);
  });

  it("DOES order a new one when the target has genuinely moved", () => {
    // The presenter scrubbed somewhere else while we were catching up.
    expect(decideChase({ ...chasing, expectedSeconds: 400, pendingChaseSeconds: 140 }).seekSeconds)
      .toBe(400);
  });

  it("stops holding once the player has arrived", () => {
    // Arrived at the pending target and the host has moved on a little: a
    // real drift correction, which must not be suppressed.
    const d = decideChase({ ...chasing, curSeconds: 140, expectedSeconds: 141.2, pendingChaseSeconds: 140 });
    expect(d.seekSeconds).toBe(141.2);
  });

  it("never blocks the just-loaded snap", () => {
    // That one must always fire: it is what puts a joining guest on the
    // room's frame at all.
    expect(decideChase({ ...chasing, justLoaded: true, pendingChaseSeconds: 140 }).seekSeconds)
      .toBe(140);
  });
});
