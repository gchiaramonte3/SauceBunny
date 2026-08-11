import { describe, expect, it } from "vitest";
import {
  IDLE_KEEP, KEEP_START_DELAY_MS, KEEP_YIELD_MS, keepBadge, keepProgress,
  reduceKeep, shouldHandOff, shouldTransfer, type KeepState,
} from "./stream-keep";
import { DOWNSHIFT_STALLS, DOWNSHIFT_WINDOW_MS } from "./stream-rung";

const watch = (at = 0, relayed = false): KeepState =>
  reduceKeep(IDLE_KEEP, { t: "watch", blake3: "abc", total: 1000, relayed, at });

/** Advance to a running copy the way real time does: watch, then tick past
 *  the start delay. */
const running = (at = 0): KeepState =>
  reduceKeep(watch(at), { t: "tick", at: at + KEEP_START_DELAY_MS });

describe("starting a copy", () => {
  it("does not start until the live stream has settled", () => {
    const s = watch(0);
    expect(s.phase).toBe("waiting");
    expect(shouldTransfer(s)).toBe(false);
    // One millisecond short is still short.
    expect(reduceKeep(s, { t: "tick", at: KEEP_START_DELAY_MS - 1 }).phase).toBe("waiting");
    expect(reduceKeep(s, { t: "tick", at: KEEP_START_DELAY_MS }).phase).toBe("keeping");
  });

  it("refuses to pull a whole file through a RELAY", () => {
    // The ladder already caps a relayed path at its lowest rung because that
    // traffic crosses n0's public infrastructure. Quietly pulling gigabytes
    // through it is the same bargain, much larger.
    const s = watch(0, true);
    expect(s.phase).toBe("off");
    expect(s.reason).toBe("relayed");
    expect(shouldTransfer(s)).toBe(false);
    // And a tick must not talk it into starting.
    expect(reduceKeep(s, { t: "tick", at: 10 * KEEP_START_DELAY_MS }).phase).toBe("off");
  });

  it("says why, when it declines for a reason worth saying", () => {
    expect(keepBadge(watch(0, true))).toMatch(/relayed/i);
    expect(keepBadge(IDLE_KEEP)).toBeNull(); // not watching: say nothing
  });
});

describe("yielding to the picture", () => {
  it("backs off when the live stream stalls", () => {
    const s = reduceKeep(running(0), { t: "stall", at: 20_000 });
    expect(s.phase).toBe("yielded");
    expect(shouldTransfer(s)).toBe(false);
  });

  it("does NOT restart the clock on a copy that has not begun", () => {
    // Stalls during startup are the pipeline's own; letting them push out
    // `waiting` would mean a wobbly start postpones the copy indefinitely.
    const s = watch(0);
    const after = reduceKeep(s, { t: "stall", at: 5_000 });
    expect(after).toBe(s);
    expect(reduceKeep(after, { t: "tick", at: KEEP_START_DELAY_MS }).phase).toBe("keeping");
  });

  it("stays out of the way for a full downshift window", () => {
    const s = reduceKeep(running(0), { t: "stall", at: 20_000 });
    expect(reduceKeep(s, { t: "tick", at: 20_000 + KEEP_YIELD_MS - 1 }).phase).toBe("yielded");
    expect(reduceKeep(s, { t: "tick", at: 20_000 + KEEP_YIELD_MS }).phase).toBe("keeping");
  });

  it("CANNOT be the second stall in a downshift — the whole derivation", () => {
    // The ladder downshifts on DOWNSHIFT_STALLS inside DOWNSHIFT_WINDOW_MS.
    // Yielding for a full window means the stall that made us yield has aged
    // out before we resume, so a stall we then cause is a lone one.
    expect(KEEP_YIELD_MS).toBeGreaterThanOrEqual(DOWNSHIFT_WINDOW_MS);
    expect(DOWNSHIFT_STALLS).toBeGreaterThan(1);

    const stalledAt = 20_000;
    const s = reduceKeep(running(0), { t: "stall", at: stalledAt });
    const resumeAt = stalledAt + KEEP_YIELD_MS;
    expect(reduceKeep(s, { t: "tick", at: resumeAt }).phase).toBe("keeping");
    // By the time the copy is back on the wire, the stall it answered for is
    // outside the window the ladder is counting.
    expect(resumeAt - stalledAt).toBeGreaterThanOrEqual(DOWNSHIFT_WINDOW_MS);
  });

  it("keeps counting progress while yielded, since bytes already landed", () => {
    const s = reduceKeep(running(0), { t: "stall", at: 20_000 });
    expect(reduceKeep(s, { t: "progress", received: 400, total: 1000 }).received).toBe(400);
  });
});

describe("finishing, and handing off", () => {
  it("hands off only when the finished file is the one on screen", () => {
    const s = reduceKeep(running(0), { t: "done", path: "/c/abc.mp4", at: 99 });
    expect(s.phase).toBe("done");
    expect(shouldHandOff(s, "abc")).toBe(true);
    // The host loaded something else while the copy was finishing. Swapping
    // now would put the PREVIOUS file on screen, and the handoff is designed
    // to be invisible — nothing would announce the mistake.
    expect(shouldHandOff(s, "def")).toBe(false);
    expect(shouldHandOff(s, null)).toBe(false);
  });

  it("never hands off a copy that has not finished", () => {
    expect(shouldHandOff(running(0), "abc")).toBe(false);
    expect(shouldHandOff(watch(0), "abc")).toBe(false);
    const failed = reduceKeep(running(0), { t: "failed", at: 5 });
    expect(shouldHandOff(failed, "abc")).toBe(false);
  });

  it("reports a finished copy as complete even if the last progress was stale", () => {
    let s = running(0);
    s = reduceKeep(s, { t: "progress", received: 900, total: 1000 });
    s = reduceKeep(s, { t: "done", path: "/c/abc.mp4", at: 99 });
    expect(keepProgress(s)).toBe(1);
  });
});

describe("abandoning", () => {
  it("stop clears everything, so nothing can be handed off later", () => {
    const s = reduceKeep(running(0), { t: "stop", at: 50 });
    expect(s.blake3).toBeNull();
    expect(shouldTransfer(s)).toBe(false);
    expect(shouldHandOff(s, "abc")).toBe(false);
  });

  it("a late event after stop cannot resurrect the copy", () => {
    // The transfer is cancelled asynchronously, so events arriving after stop
    // are ordinary rather than exceptional.
    const stopped = reduceKeep(running(0), { t: "stop", at: 50 });
    expect(reduceKeep(stopped, { t: "progress", received: 999, total: 1000 })).toBe(stopped);
    expect(reduceKeep(stopped, { t: "done", path: "/c/abc.mp4", at: 60 }).phase).toBe("off");
    expect(reduceKeep(stopped, { t: "failed", at: 60 }).phase).toBe("off");
  });

  it("a finished copy is not undone by a late failure", () => {
    const done = reduceKeep(running(0), { t: "done", path: "/c/abc.mp4", at: 99 });
    expect(reduceKeep(done, { t: "failed", at: 100 })).toBe(done);
  });

  it("watching a different file replaces the copy rather than merging", () => {
    const s = reduceKeep(running(0), { t: "watch", blake3: "xyz", total: 55, relayed: false, at: 200 });
    expect(s.blake3).toBe("xyz");
    expect(s.received).toBe(0);
    expect(s.total).toBe(55);
    expect(s.phase).toBe("waiting");
  });
});

describe("progress and copy", () => {
  it("is null until the size is known, then clamped", () => {
    expect(keepProgress({ ...IDLE_KEEP, total: 0, received: 5 })).toBeNull();
    expect(keepProgress({ ...IDLE_KEEP, total: 100, received: -5 })).toBe(0);
    expect(keepProgress({ ...IDLE_KEEP, total: 100, received: 250 })).toBe(1);
  });

  it("never reads as an error, because a failed keep costs nothing held", () => {
    const failed = reduceKeep(running(0), { t: "failed", at: 5 });
    expect(keepBadge(failed)).toBe("Could not save a copy");
    expect(keepBadge(failed)).not.toMatch(/error|fail(ed|ure)\b/i);
  });

  it("has a line for every phase a user can be sitting in", () => {
    let s = running(0);
    expect(keepBadge(watch(0))).toBeTruthy();
    expect(keepBadge(s)).toMatch(/Saving/);
    s = reduceKeep(s, { t: "progress", received: 500, total: 1000 });
    expect(keepBadge(s)).toBe("Saving a copy · 50%");
    expect(keepBadge(reduceKeep(s, { t: "stall", at: 1 }))).toMatch(/paused/);
    expect(keepBadge(reduceKeep(s, { t: "done", path: "/p", at: 1 }))).toMatch(/own copy/);
  });
});
