import { describe, expect, it } from "vitest";
import {
  CHANGE_COOLDOWN_MS,
  DEFAULT_RUNG,
  DOWNSHIFT_WINDOW_MS,
  LOWEST_RUNG,
  RUNGS,
  UPSHIFT_CLEAN_MS,
  UPSHIFT_REPEAT_CLEAN_MS,
  initialRungState,
  isRungHeight,
  needsRebuild,
  reduceRung,
  rungBadge,
  rungFor,
  type RungEvent,
  type RungState,
} from "./stream-rung";

const T0 = 1_000_000;
/**
 * A moment far enough past T0 that the start-up cooldown has elapsed.
 *
 * Fixtures below stall at T1 rather than T0 because the machine (correctly)
 * discounts stalls within CHANGE_COOLDOWN_MS of a rung change, and a session's
 * initial pipeline build counts as one. The first seconds of ANY stream are
 * start-up buffering, not evidence about the network.
 */
const T1 = T0 + CHANGE_COOLDOWN_MS + 1;

/** Feed a sequence of events and return the final state. */
function run(s: RungState, ...events: RungEvent[]): RungState {
  return events.reduce(reduceRung, s);
}

const stall = (at: number): RungEvent => ({ t: "stall", at });
const tick = (at: number): RungEvent => ({ t: "tick", at });

describe("the ladder itself", () => {
  it("runs widest to narrowest, with monotonically falling video bitrate", () => {
    // Order is load-bearing: downshift is "index + 1" and upshift is
    // "index - 1", so a ladder sorted the other way inverts the whole policy.
    for (let i = 1; i < RUNGS.length; i += 1) {
      expect(RUNGS[i].height).toBeLessThan(RUNGS[i - 1].height);
      expect(RUNGS[i].videoKbps).toBeLessThan(RUNGS[i - 1].videoKbps);
    }
  });

  it("never drops audio below 96k, even on the bottom rung", () => {
    // The deliberate asymmetry. In a review tool a reviewer who cannot make
    // out a word has lost the session; one looking at soft 360p has not.
    for (const r of RUNGS) expect(r.audioKbps).toBeGreaterThanOrEqual(96);
    expect(rungFor(LOWEST_RUNG).audioKbps).toBe(96);
  });

  it("resolves an unknown height to a sane rung instead of crashing", () => {
    // The wire is not typed. A peer on a different build can send anything.
    expect(rungFor(999 as never).height).toBe(DEFAULT_RUNG);
    expect(isRungHeight(999)).toBe(false);
    expect(isRungHeight("720")).toBe(false);
    expect(isRungHeight(720)).toBe(true);
  });
});

describe("downshift", () => {
  it("ignores a single stall", () => {
    // One stall is a hiccup. Rebuilding the pipeline for it costs more than
    // it saves.
    const s = run(initialRungState(T0), stall(T1));
    expect(s.current).toBe(DEFAULT_RUNG);
  });

  it("drops one rung on two stalls inside the window", () => {
    const s = run(initialRungState(T0), stall(T1), stall(T1 + 1000));
    expect(s.current).toBe(540);
  });

  it("drops only ONE rung, however bad the burst", () => {
    // Each change is a full rebuild, and a rebuild is itself a stall risk.
    // Falling to the floor on one bad moment guarantees a bad picture for the
    // next minute at least.
    const s = run(
      initialRungState(T0),
      stall(T1), stall(T1 + 100), stall(T1 + 200), stall(T1 + 300),
    );
    expect(s.current).toBe(540);
  });

  it("discounts the stalls a rung change causes itself", () => {
    // The bug this rule exists for: a rebuild empties the buffer, the <video>
    // fires `waiting` on its own, and those self-inflicted stalls satisfied
    // the downshift rule immediately — so one bad burst walked the ladder two
    // rungs at a time, each step manufacturing the evidence for the next.
    const dropped = run(initialRungState(T0), stall(T1), stall(T1 + 100));
    expect(dropped.current).toBe(540);
    // Two more stalls, both inside the cooldown that follows the change.
    const after = run(dropped, stall(T1 + 200), stall(T1 + 300));
    expect(after.current).toBe(540);
    // Past the cooldown they count again — the rule delays evidence, it does
    // not discard the network's opinion.
    const later = T1 + 100 + CHANGE_COOLDOWN_MS + 1;
    expect(run(after, stall(later), stall(later + 100)).current).toBe(360);
  });

  it("discounts start-up buffering, because a session start is a build too", () => {
    const s = run(initialRungState(T0), stall(T0 + 500), stall(T0 + 900));
    expect(s.current).toBe(DEFAULT_RUNG);
  });

  it("forgets stalls older than the window", () => {
    const s = run(
      initialRungState(T0),
      stall(T1),
      stall(T1 + DOWNSHIFT_WINDOW_MS + 1), // the first has expired
    );
    expect(s.current).toBe(DEFAULT_RUNG);
  });

  it("counts a stall exactly at the window edge as still inside it", () => {
    const s = run(initialRungState(T0), stall(T1), stall(T1 + DOWNSHIFT_WINDOW_MS));
    expect(s.current).toBe(540);
  });

  it("walks all the way down and then stops", () => {
    let s = initialRungState(T0);
    let at = T1;
    for (let step = 0; step < 6; step += 1) {
      s = run(s, stall(at), stall(at + 100));
      at += 100_000;
    }
    expect(s.current).toBe(LOWEST_RUNG);
  });

  it("keeps resetting the clean clock while stalling at the bottom", () => {
    // Otherwise a connection that is still failing would satisfy the upshift
    // timer and climb straight back into the wall it just hit.
    let s = initialRungState(T0, "auto");
    let at = T1;
    s = run(s, stall(at), stall(at + 100));                       // 540
    at += CHANGE_COOLDOWN_MS + 1;
    s = run(s, stall(at), stall(at + 100));                       // 360
    at += CHANGE_COOLDOWN_MS + 1;
    const stillFailing = run(s, stall(at), stall(at + 100));
    expect(stillFailing.current).toBe(LOWEST_RUNG);
    expect(stillFailing.cleanSince).toBe(at + 100);
  });
});

describe("upshift", () => {
  /** Down to 540, with the clock at `at`. */
  function lowered(at = T1 + 1000): RungState {
    const s = run(initialRungState(T0), stall(T1), stall(at));
    expect(s.current).toBe(540);
    return s;
  }

  it("does not climb before the clean window has elapsed", () => {
    const s = lowered();
    expect(run(s, tick(s.cleanSince + UPSHIFT_CLEAN_MS - 1)).current).toBe(540);
  });

  it("climbs one rung after a clean window", () => {
    const s = lowered();
    expect(run(s, tick(s.cleanSince + UPSHIFT_CLEAN_MS)).current).toBe(720);
  });

  it("needs a LONGER clean window for a second climb", () => {
    // "Never twice without a clean 120s". Without this, a flaky connection
    // ratchets back to the top in two minutes and starts the cycle again.
    let s = lowered();
    s = run(s, tick(s.cleanSince + UPSHIFT_CLEAN_MS));
    expect(s.current).toBe(720);
    expect(run(s, tick(s.cleanSince + UPSHIFT_CLEAN_MS)).current).toBe(720);
    expect(run(s, tick(s.cleanSince + UPSHIFT_REPEAT_CLEAN_MS)).current).toBe(1080);
  });

  it("stops at the top", () => {
    let s = lowered();
    let at = s.cleanSince;
    for (let i = 0; i < 5; i += 1) {
      at += UPSHIFT_REPEAT_CLEAN_MS;
      s = run(s, tick(at));
    }
    expect(s.current).toBe(1080);
  });

  it("a stall inside the clean window restarts the wait", () => {
    const s = lowered();
    const nearlyThere = s.cleanSince + UPSHIFT_CLEAN_MS - 1000;
    const interrupted = run(s, stall(nearlyThere));
    expect(run(interrupted, tick(nearlyThere + 500)).current).toBe(540);
    expect(run(interrupted, tick(nearlyThere + UPSHIFT_CLEAN_MS)).current).toBe(720);
  });

  it("never oscillates: a stall-then-climb cycle nets no worse than the floor", () => {
    // The property the asymmetry exists to guarantee. Alternate two stalls
    // with a bare-minimum clean window and the rung must not thrash upward.
    let s = initialRungState(T0);
    let at = T1;
    const seen = new Set<number>();
    for (let i = 0; i < 20; i += 1) {
      s = run(s, stall(at), stall(at + 100));
      at += UPSHIFT_CLEAN_MS + 10;
      s = run(s, tick(at));
      seen.add(s.current);
    }
    // It settles at or below the default; it never sits at 1080 under this
    // much stalling.
    expect(s.current).toBeLessThanOrEqual(DEFAULT_RUNG);
    expect(seen.has(1080)).toBe(false);
  });
});

describe("a pinned rung", () => {
  it("starts where it was pinned", () => {
    expect(initialRungState(T0, 1080).current).toBe(1080);
  });

  it("ignores stalls entirely", () => {
    // Pinning is a user decision on a known connection, not a hint.
    const s = run(initialRungState(T0, 1080), stall(T1), stall(T1 + 1), stall(T1 + 2));
    expect(s.current).toBe(1080);
  });

  it("ignores ticks entirely", () => {
    const s = run(initialRungState(T0, 360), tick(T0 + UPSHIFT_REPEAT_CLEAN_MS * 5));
    expect(s.current).toBe(360);
  });

  it("returning to auto restarts from the default, not from where it was", () => {
    // A pinned 1080 that failed is not evidence about the network. Resuming
    // auto from 1080 would repeat the failure the user just worked around.
    const pinned = initialRungState(T0, 1080);
    const back = run(pinned, { t: "prefer", pref: "auto", at: T0 + 5000 });
    expect(back.current).toBe(DEFAULT_RUNG);
    expect(back.stalls).toEqual([]);
  });

  it("switching pins takes effect immediately", () => {
    const s = run(initialRungState(T0), { t: "prefer", pref: 360, at: T0 + 1 });
    expect(s.current).toBe(360);
    expect(s.pref).toBe(360);
  });
});

describe("a relayed path (R6)", () => {
  const relayed = (at: number): RungEvent => ({ t: "path", relayed: true, at });
  const direct = (at: number): RungEvent => ({ t: "path", relayed: false, at });

  it("forces the lowest rung", () => {
    // Kilobytes of control traffic through n0's public relay was an accepted
    // cost. Megabits of the user's media is a different bargain, and this is
    // the app's only automatic answer to it.
    const s = run(initialRungState(T0), relayed(T0 + 1));
    expect(s.current).toBe(LOWEST_RUNG);
    expect(s.ceiling).toBe(LOWEST_RUNG);
  });

  it("holds the floor against every upshift while relayed", () => {
    let s = run(initialRungState(T0), relayed(T0 + 1));
    let at = T0 + 1;
    for (let i = 0; i < 10; i += 1) {
      at += UPSHIFT_REPEAT_CLEAN_MS;
      s = run(s, tick(at));
    }
    expect(s.current).toBe(LOWEST_RUNG);
  });

  it("caps a PINNED rung too", () => {
    // Otherwise the pin becomes a way to opt out of the relay policy without
    // being told that is what you are doing.
    const s = run(initialRungState(T0, 1080), relayed(T0 + 1));
    expect(s.current).toBe(LOWEST_RUNG);
  });

  it("lets a late hole-punch raise the ceiling without jumping the picture", () => {
    // iroh can upgrade a relayed path to direct mid-session. Raising the
    // ceiling re-enables the normal climb; it deliberately does NOT snap
    // straight to 1080, which would be an unearned rebuild.
    const s = run(initialRungState(T0), relayed(T0 + 1), direct(T0 + 10_000));
    expect(s.ceiling).toBe(1080);
    expect(s.current).toBe(LOWEST_RUNG);
    const climbed = run(s, tick(s.cleanSince + UPSHIFT_CLEAN_MS));
    expect(climbed.current).toBe(540);
  });

  it("is a no-op when the path has not changed", () => {
    const s = initialRungState(T0);
    expect(run(s, direct(T0 + 1))).toBe(s); // same object: no rebuild
  });
});

describe("needsRebuild", () => {
  it("is true only when the rung actually moved", () => {
    const a = initialRungState(T0);
    expect(needsRebuild(a, run(a, stall(T1)))).toBe(false);
    expect(needsRebuild(a, run(a, stall(T1), stall(T1 + 100)))).toBe(true);
  });

  it("is false for a tick that changed nothing", () => {
    // At the top there is nowhere to climb, so even an enormous clean stretch
    // must not report a rebuild. (Starting from the DEFAULT would legitimately
    // climb to 1080 — the first version of this test asserted otherwise and
    // was simply wrong about the policy.)
    const top = initialRungState(T0, 1080);
    const auto = reduceRung(top, { t: "prefer", pref: "auto", at: T0 });
    const climbed = run(auto, tick(T0 + UPSHIFT_REPEAT_CLEAN_MS * 3));
    expect(climbed.current).toBe(1080);
    expect(needsRebuild(climbed, run(climbed, tick(T0 + UPSHIFT_REPEAT_CLEAN_MS * 9)))).toBe(false);
  });
});

describe("the badge", () => {
  it("stays silent in the one case that is not worth reporting", () => {
    // Auto sitting at the default is the expected state. Saying so on screen
    // in perpetuity trains people to stop reading the chip, which costs us
    // the one message that genuinely matters (relayed).
    expect(rungBadge(initialRungState(T0))).toBe("");
  });

  it("says nothing when auto is sitting at the default", () => {
    // A badge that is always on screen stops being read.
    expect(rungBadge(initialRungState(T0))).toBe("");
  });

  it("names the rung once auto has moved off the default", () => {
    expect(rungBadge(run(initialRungState(T0), stall(T1), stall(T1 + 100)))).toBe("540p");
  });

  it("always names a pinned rung, including the default", () => {
    expect(rungBadge(initialRungState(T0, 720))).toBe("720p");
  });

  it("says so when the media is being relayed", () => {
    // The one case the user must be told about without asking: their file is
    // crossing a third party's machines.
    expect(rungBadge(run(initialRungState(T0), { t: "path", relayed: true, at: T0 })))
      .toBe("360p · relayed");
  });
});
