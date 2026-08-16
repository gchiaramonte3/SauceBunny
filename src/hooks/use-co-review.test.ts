import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  hostScrubbed: false, sinceLastChaseMs: 9999,
};

describe("co-review chase decisions", () => {
  it("paused host double-scrub: the yielded edge survives, the guest lands on P2", () => {
    // Host scrubs to P1; the chase's own correction armed the latch, so the
    // NEXT heartbeat (host now at P2) arrives with the latch hot.
    const yielded = decideChase({
      ...base, localSeekHot: true, hostScrubbed: true, sinceLastChaseMs: 9999,
      curSeconds: 50, expectedSeconds: 80,
    });
    expect(yielded.seekSeconds).toBeNull();
    // THE fix: yielding must not consume the scrub edge.
    expect(yielded.commitHostPos).toBe(false);

    // Latch expired; because the edge was not consumed, hostScrubbed is
    // still true and the paused guest finally jumps to P2.
    const after = decideChase({
      ...base, hostScrubbed: true, sinceLastChaseMs: 9999, curSeconds: 50, expectedSeconds: 80,
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

/**
 * State updaters stay pure.
 *
 * React 18 StrictMode double-invokes every updater in development, and keeps
 * the SECOND result. So an updater that also does work - writes a file, drains
 * a queue, bumps a ref - runs that work twice, and any part of its own answer
 * that depended on the work is computed from the already-drained state.
 *
 * This was live here. The `reviewDoc` snapshot handler merged, replayed the
 * ops the author had posted before any doc existed, and emptied
 * `pendingOpsRef` inside a single `setSessionDoc(prev => ...)`. Second pass:
 * queue empty, ops not replayed, and that is the doc React kept. The author's
 * own comments vanished, in exactly the case the replay was written for.
 *
 * The lib tests around `adoptSnapshot` cannot catch this - a pure function
 * tested for purity passes by construction, which mutation testing confirmed:
 * gutting the replay failed one test, and making it impure failed none. The
 * defect was never in the merge logic. It was in WHERE that logic ran, so
 * that is what this reads.
 */
describe("setSessionDoc updaters do no work of their own", () => {
  const SRC = readFileSync(resolve(__dirname, "./use-co-review.ts"), "utf8");

  /** The argument text of every `setSessionDoc(...)` call, paren-matched. */
  function updaterBodies(): string[] {
    const out: string[] = [];
    let i = SRC.indexOf("setSessionDoc(");
    while (i !== -1) {
      let depth = 0;
      let j = i + "setSessionDoc".length;
      const start = j;
      for (; j < SRC.length; j += 1) {
        if (SRC[j] === "(") depth += 1;
        else if (SRC[j] === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      out.push(SRC.slice(start, j));
      i = SRC.indexOf("setSessionDoc(", j);
    }
    return out;
  }

  it("finds the updaters, so this is not passing over an empty list", () => {
    const bodies = updaterBodies();
    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies.some((b) => b.includes("adoptSnapshot"))).toBe(true);
  });

  it("never persists from inside an updater", () => {
    // A disk write per render pass, and the write is of pre-merge state.
    const bad = updaterBodies().filter((b) => /persistDoc(Ref)?\b/.test(b));
    expect(bad, "Persist before calling setSessionDoc, using the ref for prev.").toEqual([]);
  });

  it("never mutates a ref from inside an updater", () => {
    // The specific bug: `pendingOpsRef.current = []` inside the updater made
    // the second invocation compute a different answer from the first.
    const bad = updaterBodies().filter((b) => /Ref\.current\s*=[^=]/.test(b));
    expect(bad, "Drain outside the updater and pass the value in.").toEqual([]);
  });

  it("never pushes to a ref's array from inside an updater", () => {
    const bad = updaterBodies().filter((b) => /Ref\.current\.(push|pop|shift|splice)\s*\(/.test(b));
    expect(bad, "Same reason: it would run twice per commit.").toEqual([]);
  });
});
