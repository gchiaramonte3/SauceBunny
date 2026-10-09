// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AafSpeech } from "../bindings/AafSpeech";
import type { EditDocument } from "../bindings/EditDocument";
import { multitrackFixture } from "../test/multitrack-fixture";
import { forgetSequence } from "../lib/edit-words-cache";
import { useEditSources } from "./use-edit-sources";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), changed: [] as ((event: { payload: string }) => void)[] }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, handler: (event: { payload: string }) => void) => { mocks.changed.push(handler); return () => undefined; }),
}));

const document: EditDocument = {
  schema_version: 1, title: "Kitchen", edit_rate: { numerator: 24, denominator: 1 }, start_timecode_frames: 86_400,
  sources: [{ id: "s1", name: "Kitchen", document_id: "sequence-test" }],
  tracks: [
    { id: "rosa", name: "Rosa", kind: "sound", source_tracks: { s1: "track-1" } },
    { id: "sam", name: "Sam", kind: "sound", source_tracks: { s1: "track-2" } },
  ],
  segments: [], mutes: [], markers: [],
};
let said = "Okay";
const speech = (trackId: string): AafSpeech => ({
  track_id: trackId, floor_db: -96, measured: false, activity: [], reactions: [],
  words: [{ cue_id: `${trackId}-c`, text: said, start_sample: 16_000, end_sample: 24_000 }],
});
const calls = (command: string) => mocks.invoke.mock.calls.filter(([name]) => name === command);
const saved = (id: string) => act(() => { for (const handler of mocks.changed) handler({ payload: id }); });

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks(); said = "Okay";
  forgetSequence("sequence-test");
  mocks.invoke.mockImplementation((command: string, args: Record<string, unknown>) => {
    if (command === "aaf_open") return Promise.resolve(multitrackFixture());
    if (command === "aaf_ownership") return Promise.resolve(null);
    if (command === "aaf_speech") return Promise.resolve(speech(args.trackId as string));
    return Promise.resolve(undefined);
  });
});

it("a tab reopened over a sequence already read asks the app for nothing", async () => {
  // HEAT 1: 98 mics, 25 s of reading on every tab switch.
  const first = renderHook(() => useEditSources(document));
  await waitFor(() => expect(first.result.current.loading).toBe(false));
  expect(calls("aaf_speech")).toHaveLength(2);
  // String Outs reads only the manifest; the transcripts stay in the app.
  expect(calls("aaf_open").map(([, args]) => args)).toEqual([{ documentId: "sequence-test", transcripts: false }]);
  const words = first.result.current.words;
  first.unmount();
  mocks.invoke.mockClear();

  const again = renderHook(() => useEditSources(document));
  await waitFor(() => expect(again.result.current.loading).toBe(false));
  expect(mocks.invoke).not.toHaveBeenCalled();
  // The very same list, so what was placed from it is reused as well.
  expect(again.result.current.words).toBe(words);
});

it("a saved sequence is read again behind the words on screen", async () => {
  const { result } = renderHook(() => useEditSources(document));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.words.map((word) => word.text)).toEqual(["Okay", "Okay"]);
  mocks.invoke.mockClear();
  said = "Hello";

  // A transcript finished in AAF Audio saves the sequence.
  saved("sequence-test");
  // Nothing empties or says it is reading while the new words come in.
  expect(result.current.loading).toBe(false);
  expect(result.current.words.map((word) => word.text)).toEqual(["Okay", "Okay"]);
  await waitFor(() => expect(result.current.words.map((word) => word.text)).toEqual(["Hello", "Hello"]));
  expect(calls("aaf_speech")).toHaveLength(2);
  expect(result.current.loading).toBe(false);
});

it("another sequence being saved reads nothing again", async () => {
  const { result } = renderHook(() => useEditSources(document));
  await waitFor(() => expect(result.current.loading).toBe(false));
  mocks.invoke.mockClear();
  saved("another-sequence");
  await act(async () => { await Promise.resolve(); });
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(result.current.words).toHaveLength(2);
});
