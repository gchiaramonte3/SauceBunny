// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { multitrackFixture } from "../test/multitrack-fixture";
import { audibleTracks, useMultitrackAudition } from "./use-multitrack-audition";
const controls = vi.hoisted(() => ({ warm: vi.fn().mockResolvedValue(undefined), seek: vi.fn().mockResolvedValue(undefined), shuttle: vi.fn(), pause: vi.fn(), suspend: vi.fn(), close: vi.fn(), setTracks: vi.fn(), setLevel: vi.fn(), setTrackLevel: vi.fn(), setScrubbing: vi.fn(), scrub: vi.fn() }));
vi.mock("../lib/multitrack-audio", () => ({ MultitrackAudio: class { constructor() { return controls; } } }));
beforeEach(() => vi.clearAllMocks());
describe("multitrack audition controls", () => {
  it("supports independent, additive solo and mute without a transcription selection", () => {
    const { result } = renderHook(() => useMultitrackAudition(multitrackFixture(), true));
    act(() => { result.current.toggleSolo("track-1"); result.current.toggleSolo("track-2"); });
    expect([...result.current.solo]).toEqual(["track-1", "track-2"]);
    act(() => result.current.toggleMute("track-2"));
    expect(audibleTracks(["track-1", "track-2", "track-3"], result.current.solo, result.current.mute)).toEqual(["track-1"]);
    act(() => result.current.toggleSolo("track-1")); expect([...result.current.solo]).toEqual(["track-2"]);
    act(() => result.current.toggleSolo("track-2"));
    expect(audibleTracks(["track-1", "track-2", "track-3"], result.current.solo, result.current.mute)).toEqual(["track-1", "track-3"]);
  });
  it("defaults audio scrub on, keeps seek independent of solo, and suspends on departure", async () => {
    const fixture = multitrackFixture();
    const { result, rerender, unmount } = renderHook(({ active }) => useMultitrackAudition(fixture, active), { initialProps: { active: true } });
    expect(result.current.scrubbing).toBe(true);
    await act(async () => result.current.seek(240, "track-2", false));
    expect(controls.seek).toHaveBeenCalledWith(240, 0); expect(result.current.solo.size).toBe(0);
    expect(controls.setScrubbing).toHaveBeenCalledWith(true);
    rerender({ active: false }); expect(controls.suspend).toHaveBeenCalled();
    unmount(); expect(controls.close).toHaveBeenCalled();
  });
});
