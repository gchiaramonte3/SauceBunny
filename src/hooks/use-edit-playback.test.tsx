// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EditDocument } from "../bindings/EditDocument";
import type { EditAudioState } from "../lib/edit-audio";
import { useEditPlayback } from "./use-edit-playback";

const engines = vi.hoisted(() => [] as Array<{ fps: number; notify: (state: EditAudioState) => void; calls: Array<[string, ...unknown[]]> }>);
vi.mock("../lib/edit-audio", () => ({
  EditAudio: class {
    record: (typeof engines)[number];
    constructor(fps: number, notify: (state: EditAudioState) => void) { this.record = { fps, notify, calls: [] }; engines.push(this.record); }
    setDocument(...args: unknown[]) { this.record.calls.push(["setDocument", ...args]); }
    setLevel(...args: unknown[]) { this.record.calls.push(["setLevel", ...args]); }
    setTrackLevel(...args: unknown[]) { this.record.calls.push(["setTrackLevel", ...args]); }
    seek(...args: unknown[]) { this.record.calls.push(["seek", ...args]); return Promise.resolve(); }
    toggle() { this.record.calls.push(["toggle"]); return Promise.resolve(); }
    pause() { this.record.calls.push(["pause"]); }
    scrub(...args: unknown[]) { this.record.calls.push(["scrub", ...args]); }
    close() { this.record.calls.push(["close"]); }
  },
}));

const document: EditDocument = {
  schema_version: 1, title: "Edit", edit_rate: { numerator: 24000, denominator: 1001 }, start_timecode_frames: 0,
  sources: [{ id: "S1", name: "One", document_id: "d1" }],
  tracks: [{ id: "T1", name: "Ann", kind: "sound", source_tracks: { S1: "a1" } }],
  segments: [{ kind: "source", id: "g1", source: "S1", in_frame: 0, out_frame: 48 }], mutes: [], markers: [],
};

beforeEach(() => { engines.length = 0; });

describe("useEditPlayback", () => {
  it("creates one engine on first use, at the edit's rate, with the edit and the audible tracks", async () => {
    const { result } = renderHook(() => useEditPlayback({ document, audible: ["T1"], active: true }));
    expect(engines).toHaveLength(0);
    await act(() => result.current.toggle());
    expect(engines).toHaveLength(1);
    expect(engines[0].fps).toBeCloseTo(23.976, 3);
    expect(engines[0].calls.map(([name]) => name)).toEqual(["setDocument", "setLevel", "toggle"]);
    expect(engines[0].calls[0]).toEqual(["setDocument", document, ["T1"], {}]);
    act(() => engines[0].notify({ frame: 12, rate: 1, busy: false, error: null }));
    expect(result.current).toMatchObject({ frame: 12, playing: true });
    await act(() => result.current.toggle());
    expect(engines).toHaveLength(1);
  });
  it("seeks parked or playing according to the current state, and scrubs and pauses the same engine", async () => {
    const { result } = renderHook(() => useEditPlayback({ document, audible: ["T1"], active: true }));
    await act(() => result.current.seek(10));
    expect(engines[0].calls.at(-1)).toEqual(["seek", 10, 0]);
    act(() => engines[0].notify({ frame: 10, rate: 1, busy: false, error: null }));
    await act(() => result.current.seek(20));
    expect(engines[0].calls.at(-1)).toEqual(["seek", 20, 1]);
    act(() => { result.current.scrub(30); result.current.pause(); });
    expect(engines[0].calls.slice(-2)).toEqual([["scrub", 30], ["pause"]]);
  });
  it("re-plans on a new edit or mix, applies levels, and closes when inactive", async () => {
    const { result, rerender } = renderHook((props: { audible: string[]; active: boolean }) => useEditPlayback({ document, ...props }),
      { initialProps: { audible: ["T1"], active: true } });
    await act(() => result.current.seek(0));
    rerender({ audible: ["T1"], active: true });
    expect(engines[0].calls.filter(([name]) => name === "setDocument")).toHaveLength(1);
    rerender({ audible: [], active: true });
    expect(engines[0].calls.at(-1)).toEqual(["setDocument", document, [], {}]);
    act(() => { result.current.setVolume(.5); result.current.setTrackLevel("T1", 2); });
    expect(engines[0].calls).toContainEqual(["setLevel", .5, false]);
    expect(engines[0].calls).toContainEqual(["setTrackLevel", "T1", 2]);
    rerender({ audible: [], active: false });
    expect(engines[0].calls.at(-1)).toEqual(["close"]);
    await act(() => result.current.toggle());
    expect(engines).toHaveLength(1);
  });
});
