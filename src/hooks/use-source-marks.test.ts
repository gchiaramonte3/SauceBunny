// @vitest-environment jsdom
//
// The per-source marks handshake, tested through the exact sequence that
// shipped broken TWICE. An adversarial review of the 0.4.2 release notes
// traced both: re-opening the same source erased its stored marks (the
// restore latch never cleared, so the reset's nulls were saved over the
// row), and a cold web fetch restored unclamped marks because the real
// duration lands after the restore. Every test here drives the hook with
// real state the way App does - key goes null and comes back, duration
// arrives late - rather than poking the effects in isolation.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { useSourceMarks } from "./use-source-marks";
import { marksFor, setSourceMarks } from "../lib/source-marks";

const KEY = "/movies/cut-a.mov";

/** A tiny stand-in for App: real useState for marks, key and duration
 *  driven by the test, the hook wired exactly as the call site wires it. */
function harness(initialKey: string | null, initialDuration = 3000) {
  return renderHook(
    ({ k, dur }: { k: string | null; dur: number }) => {
      const [inFrames, setInFrames] = useState<number | null>(null);
      const [outFrames, setOutFrames] = useState<number | null>(null);
      useSourceMarks({
        reviewSourceKey: k, durationFrames: dur,
        inFrames, outFrames, setInFrames, setOutFrames,
      });
      return { inFrames, outFrames, setInFrames, setOutFrames };
    },
    { initialProps: { k: initialKey, dur: initialDuration } },
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

/**
 * App's resetForNewSource nulls the marks AND the metadata (so the key) in
 * one synchronous call, which React 18 batches into ONE commit - the save
 * effect never sees "key still loaded, marks freshly null". Model that
 * faithfully: setters and rerender inside a single act(). An earlier draft
 * of this file split them into two commits and "found" an erase the real
 * app cannot hit, while a user's intentional clear (G while the source is
 * loaded) genuinely should forget the row and is tested separately.
 */
function unload(h: ReturnType<typeof harness>) {
  act(() => {
    h.result.current.setInFrames(null);
    h.result.current.setOutFrames(null);
    h.rerender({ k: null, dur: 0 });
  });
}

describe("restore", () => {
  it("restores stored marks when the source loads", () => {
    setSourceMarks(KEY, { inFrames: 100, outFrames: 200 });
    const h = harness(KEY);
    expect(h.result.current.inFrames).toBe(100);
    expect(h.result.current.outFrames).toBe(200);
  });

  it("does not delete the stored row while restoring", () => {
    // The save effect runs in the same commit as the restore, before the
    // restored state lands. A two-state latch let it write {null,null} there,
    // which the store treats as "forget the entry".
    setSourceMarks(KEY, { inFrames: 100, outFrames: 200 });
    harness(KEY);
    expect(marksFor(KEY)).toEqual({ inFrames: 100, outFrames: 200 });
  });
});

describe("the re-open sequence that erased marks", () => {
  it("key null and back: marks restore again and the row survives", () => {
    setSourceMarks(KEY, { inFrames: 100, outFrames: 200 });
    const h = harness(KEY);
    expect(h.result.current.inFrames).toBe(100);

    // resetForNewSource: marks and key nulled in one batch, then the same
    // source finishes loading again.
    unload(h);
    h.rerender({ k: KEY, dur: 3000 });

    expect(h.result.current.inFrames, "re-open lost the marks on screen").toBe(100);
    expect(h.result.current.outFrames).toBe(200);
    expect(marksFor(KEY), "re-open erased the stored row").toEqual({ inFrames: 100, outFrames: 200 });
  });

  it("marks set in session A survive into session B of the same source", () => {
    const h = harness(KEY);
    act(() => {
      h.result.current.setInFrames(50);
      h.result.current.setOutFrames(90);
    });
    expect(marksFor(KEY)).toEqual({ inFrames: 50, outFrames: 90 });

    unload(h);
    h.rerender({ k: KEY, dur: 3000 });
    expect(h.result.current.inFrames).toBe(50);
    expect(h.result.current.outFrames).toBe(90);
  });

  it("clearing marks on purpose still forgets the row", () => {
    // The latch must not make an intentional G (clear) sticky.
    setSourceMarks(KEY, { inFrames: 100, outFrames: 200 });
    const h = harness(KEY);
    act(() => {
      h.result.current.setInFrames(null);
      h.result.current.setOutFrames(null);
    });
    expect(marksFor(KEY)).toEqual({ inFrames: null, outFrames: null });
  });
});

describe("late-arriving duration", () => {
  it("clamps a restored mark once the real duration lands", () => {
    // The cold web fetch: key appears while duration is unknown (0), so the
    // restore cannot clamp; the real duration arrives afterwards.
    setSourceMarks(KEY, { inFrames: 100, outFrames: 5000 });
    const h = harness(KEY, 0);
    expect(h.result.current.outFrames).toBe(5000);

    h.rerender({ k: KEY, dur: 3000 });
    expect(h.result.current.inFrames).toBe(100);
    expect(h.result.current.outFrames, "mark past the end was not pulled in").toBe(2999);
  });

  it("drops the pair when clamping collapses the range", () => {
    setSourceMarks(KEY, { inFrames: 4000, outFrames: 5000 });
    const h = harness(KEY, 0);
    h.rerender({ k: KEY, dur: 3000 });
    expect(h.result.current.inFrames).toBeNull();
    expect(h.result.current.outFrames).toBeNull();
  });

  it("leaves in-range marks alone when duration arrives", () => {
    setSourceMarks(KEY, { inFrames: 100, outFrames: 200 });
    const h = harness(KEY, 0);
    h.rerender({ k: KEY, dur: 3000 });
    expect(h.result.current.inFrames).toBe(100);
    expect(h.result.current.outFrames).toBe(200);
  });
});

describe("switching sources", () => {
  it("each source keeps its own marks across a switch", () => {
    const KEY_B = "/movies/cut-b.mov";
    setSourceMarks(KEY, { inFrames: 10, outFrames: 20 });
    setSourceMarks(KEY_B, { inFrames: 30, outFrames: 40 });

    const h = harness(KEY);
    expect(h.result.current.inFrames).toBe(10);

    unload(h);
    h.rerender({ k: KEY_B, dur: 3000 });
    expect(h.result.current.inFrames).toBe(30);
    expect(h.result.current.outFrames).toBe(40);

    expect(marksFor(KEY)).toEqual({ inFrames: 10, outFrames: 20 });
    expect(marksFor(KEY_B)).toEqual({ inFrames: 30, outFrames: 40 });
  });
});
