// @vitest-environment jsdom
//
// The coarse playhead subscription - the mechanism behind the review
// composer's re-render cut. useSyncExternalStore bails when the snapshot is
// Object.is-equal, so flooring to whole seconds means 23 of every 24 frame
// ticks produce NO re-render for a subscriber whose output is h:mm:ss text.

import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePlayheadSecondsCoarse } from "./playhead-store";
import { setPlayheadFrames } from "./playhead-store";

const FPS = 24;

afterEach(() => act(() => setPlayheadFrames(0)));

describe("usePlayheadSecondsCoarse", () => {
  it("re-renders once per second, not once per frame", () => {
    let renders = 0;
    const h = renderHook(() => { renders++; return usePlayheadSecondsCoarse(FPS); });
    const before = renders;
    // A full second of frame ticks inside second 4.
    for (let f = 96; f < 120; f++) act(() => setPlayheadFrames(f));
    expect(h.result.current).toBe(4);
    // One re-render for the 3->4 boundary; the other 23 ticks bailed.
    expect(renders - before).toBe(1);
  });

  it("fine mode tracks every frame - the armed range edge shows a timecode", () => {
    let renders = 0;
    const h = renderHook(() => { renders++; return usePlayheadSecondsCoarse(FPS, true, true); });
    const before = renders;
    for (let f = 96; f < 100; f++) act(() => setPlayheadFrames(f));
    expect(renders - before).toBe(4);
    expect(h.result.current).toBeCloseTo(99 / FPS);
  });

  it("inactive pins to null and ignores ticks entirely", () => {
    let renders = 0;
    renderHook(() => { renders++; return usePlayheadSecondsCoarse(FPS, false); });
    const before = renders;
    for (let f = 1; f < 50; f++) act(() => setPlayheadFrames(f));
    expect(renders - before).toBe(0);
  });
});
