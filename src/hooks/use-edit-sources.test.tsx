// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { AafSpeech } from "../bindings/AafSpeech";
import type { EditDocument } from "../bindings/EditDocument";
import { multitrackFixture, multitrackGroupFixture } from "../test/multitrack-fixture";
import { useEditSources } from "./use-edit-sources";
import type { AafOwnership } from "../bindings/AafOwnership";
import { setBleedHidden } from "../lib/bleed-hidden";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

const document: EditDocument = {
  schema_version: 1, title: "Kitchen", edit_rate: { numerator: 24, denominator: 1 }, start_timecode_frames: 86_400,
  sources: [{ id: "s1", name: "Kitchen", document_id: "sequence-test" }],
  tracks: [
    { id: "rosa", name: "Rosa", kind: "sound", source_tracks: { s1: "track-1" } },
    { id: "sam", name: "Sam", kind: "sound", source_tracks: { s1: "track-2" } },
  ],
  segments: [], mutes: [], markers: [],
};
const speech = (trackId: string, measured: boolean): AafSpeech => ({
  track_id: trackId, floor_db: measured ? -60 : -96, measured,
  activity: measured ? [[16_000, 32_000]] : [], reactions: [],
  words: [{ cue_id: `${trackId}-c`, text: "Okay", start_sample: 16_000, end_sample: 24_000 }],
});
const calls = (command: string, build?: boolean) =>
  mocks.invoke.mock.calls.filter(([name, args]) => name === command && (build === undefined || args.build === build));
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

let built: Set<string>;
let labels: AafOwnership | undefined;
beforeEach(() => {
  vi.clearAllMocks(); built = new Set(); labels = undefined;
  mocks.invoke.mockImplementation((command: string, args: Record<string, unknown>) => {
    const track = args?.trackId as string;
    if (command === "aaf_open") return Promise.resolve(multitrackFixture());
    if (command === "aaf_ownership") return Promise.resolve(labels);
    if (command === "aaf_speech") {
      if (args.build) built.add(track);
      return Promise.resolve(speech(track, built.has(track)));
    }
    // A range request never builds: it answers only for a finished overview.
    if (command === "aaf_waveform") return built.has(track) ? Promise.resolve({ track_id: track, peaks: [[-0.5, 0.5]] }) : Promise.reject(new Error("not built"));
    return Promise.resolve(undefined);
  });
});

it("shows every lane's words without building a single waveform", async () => {
  const { result } = renderHook(() => useEditSources(document));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.words.map((word) => word.track)).toEqual(["rosa", "sam"]);
  expect(calls("aaf_speech", false)).toHaveLength(2);
  expect(calls("aaf_speech", true)).toHaveLength(0);
  expect(calls("aaf_waveform")).toHaveLength(0);
  // Nothing was measured, so an empty audible map is not silence.
  expect(result.current.measured).toBe(false);
  expect(result.current.measuring).toBe(false);
});

it("with Waveforms on, measures lane by lane and says when every mic is measured", async () => {
  const { result, rerender } = renderHook(({ waveforms }) => useEditSources(document, waveforms), { initialProps: { waveforms: false } });
  await waitFor(() => expect(result.current.loading).toBe(false));
  rerender({ waveforms: true });
  await waitFor(() => expect(result.current.measured).toBe(true));
  expect(result.current.measuring).toBe(false);
  expect(calls("aaf_speech", true).map(([, args]) => args.trackId)).toEqual(["track-1", "track-2"]);
  expect(result.current.peaks.get("s1:rosa")).toEqual([[-0.5, 0.5]]);
  expect(result.current.audible.get("s1")).toEqual([[1, 2], [1, 2]]);
  // Waveform range requests only; nothing asked aaf_waveform to build.
  expect(calls("aaf_waveform").every(([, args]) => args.startFrame === 0 && typeof args.durationFrames === "number")).toBe(true);
});

it("a lane already measured on disk is read, not rebuilt", async () => {
  built = new Set(["track-1", "track-2"]);
  const { result, rerender } = renderHook(({ waveforms }) => useEditSources(document, waveforms), { initialProps: { waveforms: false } });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.measured).toBe(true);
  rerender({ waveforms: true });
  await waitFor(() => expect(result.current.peaks.size).toBe(2));
  expect(calls("aaf_speech", true)).toHaveLength(0);
});

it("turning Waveforms off stops the build in flight", async () => {
  const pending = deferred<AafSpeech>();
  const base = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command: string, args: Record<string, unknown>) =>
    command === "aaf_speech" && args.build ? pending.promise : base(command, args));
  const { result, rerender } = renderHook(({ waveforms }) => useEditSources(document, waveforms), { initialProps: { waveforms: true } });
  await waitFor(() => expect(calls("aaf_speech", true)).toHaveLength(1));
  expect(result.current.measuring).toBe(true);
  const { jobId } = calls("aaf_speech", true)[0][1];
  rerender({ waveforms: false });
  expect(mocks.invoke).toHaveBeenCalledWith("cancel_job", { jobId });
  expect(result.current.measuring).toBe(false);
  await act(async () => pending.resolve(speech("track-1", true)));
  expect(result.current.measured).toBe(false);
  expect(calls("aaf_speech", true)).toHaveLength(1);
});

it("reads a group angle's words but measures only mics that are heard: on a track, or a main track of the sequence", async () => {
  // Sam's mic is an alternate in Rosa's group (the grouped sequence), and he is on no track.
  const base = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command: string, args: Record<string, unknown>) => command === "aaf_open" ? Promise.resolve(multitrackGroupFixture()) : base(command, args));
  const grouped: EditDocument = { ...document, tracks: [document.tracks[0], { ...document.tracks[1], featured: false }] };
  const { result, rerender } = renderHook(({ edit }) => useEditSources(edit, true), { initialProps: { edit: grouped } });
  await waitFor(() => expect(result.current.loading).toBe(false));
  await waitFor(() => expect(result.current.measuring).toBe(false));
  expect(result.current.measured).toBe(true);
  // Sam's words are there for Ask and the source pane; his waveform was never built.
  expect(result.current.words.map((word) => word.track)).toEqual(["rosa", "sam"]);
  expect(calls("aaf_speech", true).map(([, args]) => args.trackId)).toEqual(["track-1"]);
  expect(result.current.audible.get("s1")).toEqual([[1, 2]]);
  const reads = calls("aaf_speech", false).length;
  rerender({ edit: { ...grouped, tracks: [document.tracks[0], { ...document.tracks[1], featured: true }] } });
  await waitFor(() => expect(calls("aaf_speech", true).map(([, args]) => args.trackId)).toEqual(["track-1", "track-2"]));
  await waitFor(() => expect(result.current.audible.get("s1")).toEqual([[1, 2], [1, 2]]));
  // Giving him a track measured him; nobody's words were read again.
  expect(calls("aaf_speech", false)).toHaveLength(reads);
});

it("measures a sequence's main mics before anyone is patched, so the Source view has waveforms", async () => {
  // A new string out patches nobody; Rosa's and Sam's are the sequence's own tracks.
  const fresh: EditDocument = { ...document, tracks: document.tracks.map((track) => ({ ...track, featured: false })) };
  const { result } = renderHook(() => useEditSources(fresh, true));
  // Waiting for `measuring` to be false is not enough: it is false before
  // measuring starts, so under a loaded suite the calls were read too early.
  await waitFor(() => expect(calls("aaf_speech", true).map(([, args]) => args.trackId)).toEqual(["track-1", "track-2"]));
  await waitFor(() => expect(result.current.measuring).toBe(false));
});

it("is not measured while words are still being read, nor when a mic's words failed", async () => {
  built = new Set(["track-1", "track-2"]);
  const pending = deferred<AafSpeech>();
  const base = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command: string, args: Record<string, unknown>) =>
    command === "aaf_speech" && args.trackId === "track-2" && !args.build ? pending.promise : base(command, args));
  const { result } = renderHook(() => useEditSources(document));
  await waitFor(() => expect(calls("aaf_speech", false)).toHaveLength(2));
  // Nothing has loaded, so nothing is known to be silent.
  expect(result.current.measured).toBe(false);
  await act(async () => pending.reject(new Error("offline")));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.errors.join()).toContain("offline");
  expect(result.current.measured).toBe(false);
});

it("giving someone a track mid-build measures them next without cancelling the build in flight", async () => {
  const pending = deferred<AafSpeech>();
  const base = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command: string, args: Record<string, unknown>) =>
    command === "aaf_speech" && args.build && args.trackId === "track-1" ? pending.promise.then((speech) => { built.add("track-1"); return speech; }) : base(command, args));
  const grouped: EditDocument = { ...document, tracks: [document.tracks[0], { ...document.tracks[1], featured: false }] };
  const { result, rerender } = renderHook(({ edit }) => useEditSources(edit, true), { initialProps: { edit: grouped } });
  await waitFor(() => expect(calls("aaf_speech", true)).toHaveLength(1));
  rerender({ edit: { ...grouped, tracks: [document.tracks[0], { ...document.tracks[1], featured: true }] } });
  expect(mocks.invoke).not.toHaveBeenCalledWith("cancel_job", expect.anything());
  await act(async () => pending.resolve(speech("track-1", true)));
  await waitFor(() => expect(result.current.measured).toBe(true));
  expect(calls("aaf_speech", true).map(([, args]) => args.trackId)).toEqual(["track-1", "track-2"]);
});

it("marks Sam's copy of Rosa's word as hers only while the editor hides bleed", async () => {
  labels = { document_id: "sequence-test", measured: ["track-1", "track-2"], missing: [], stamp: "s", warnings: [], voices: 0,
    counts: { owner: 0, bleed: 1, overtalk: 0, offmic: 0, unsure: 0, other: 0 },
    words: [{ track_id: "track-2", cue_id: "track-2-c", index: 0, label: "bleed", heard_on: "track-1", delta_db: -12, manual: false }] };
  const { result } = renderHook(() => useEditSources(document));
  await waitFor(() => expect(result.current.loading).toBe(false));
  const sams = () => result.current.words.find((word) => word.track === "sam");
  // Off, the default: String Outs reads every mic as it was heard.
  expect(sams()?.heardOn).toBeUndefined();
  await act(() => setBleedHidden(true));
  expect(sams()?.heardOn).toBe("track-1");
  await act(() => setBleedHidden(false));
  expect(sams()?.heardOn).toBeUndefined();
});

it("one track's W builds that track's waveform alone; the next W builds the next", async () => {
  const { result, rerender } = renderHook(({ lanes }) => useEditSources(document, false, lanes), { initialProps: { lanes: new Set<string>() as ReadonlySet<string> } });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(calls("aaf_speech", true)).toHaveLength(0);
  rerender({ lanes: new Set(["sam"]) });
  await waitFor(() => expect(result.current.peaks.get("s1:sam")).toEqual([[-0.5, 0.5]]));
  // Rosa's W is off: her mic was never read for a waveform.
  expect(calls("aaf_speech", true).map(([, args]) => args.trackId)).toEqual(["track-2"]);
  expect(result.current.peaks.has("s1:rosa")).toBe(false);
  rerender({ lanes: new Set(["sam", "rosa"]) });
  await waitFor(() => expect(result.current.peaks.get("s1:rosa")).toEqual([[-0.5, 0.5]]));
  expect(calls("aaf_speech", true).map(([, args]) => args.trackId)).toEqual(["track-2", "track-1"]);
});
