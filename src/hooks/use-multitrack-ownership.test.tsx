// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { AafDocument } from "../bindings/AafDocument";
import type { AafOwnership } from "../bindings/AafOwnership";
import { multitrackFixture, multitrackTranscript } from "../test/multitrack-fixture";
import { useMultitrackOwnership } from "./use-multitrack-ownership";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

const answer: AafOwnership = { document_id: "sequence-test", measured: ["track-1", "track-2"], missing: [], words: [], stamp: "1",
  counts: { owner: 0, bleed: 0, overtalk: 0, offmic: 0, unsure: 0, other: 0 }, warnings: [], voices: 0 };
const passes = () => mocks.invoke.mock.calls.filter(([command]) => command === "aaf_ownership").length;
const transcribed = (): AafDocument => ({ ...multitrackFixture(), transcripts: [multitrackTranscript()] });

beforeEach(() => { vi.clearAllMocks(); mocks.invoke.mockImplementation(async () => answer); });

it("runs the bleed pass when the words or the editor's calls change, not for every new document", async () => {
  const document = transcribed();
  const { rerender } = renderHook(({ doc }) => useMultitrackOwnership(doc), { initialProps: { doc: document } });
  await waitFor(() => expect(passes()).toBe(1));
  // A label save and a shoot date: each a new document, every word where it was.
  rerender({ doc: { ...document, labels: [{ ...document.labels[0], owner_name: "Alexandra" }] } });
  rerender({ doc: { ...document, shoot_date_override: "2026-10-05" } });
  await act(async () => {});
  expect(passes()).toBe(1);
  const calls = [{ track_id: "track-1", cue_id: "cue-1", label: "bleed" as const, heard_on: "track-2" }];
  rerender({ doc: { ...document, ownership: calls } });
  await waitFor(() => expect(passes()).toBe(2));
  rerender({ doc: { ...document, ownership: calls, transcripts: [multitrackTranscript()] } });
  await waitFor(() => expect(passes()).toBe(3));
});

it("keeps one pass in flight when the panel is shown again before it ends", async () => {
  let finish!: (value: AafOwnership) => void;
  mocks.invoke.mockImplementation(() => new Promise<AafOwnership>((resolve) => { finish = resolve; }));
  const document = transcribed();
  const { result, rerender } = renderHook(({ active }) => useMultitrackOwnership(document, active), { initialProps: { active: true } });
  await waitFor(() => expect(passes()).toBe(1));
  rerender({ active: false }); rerender({ active: true });
  await act(async () => {});
  expect(passes()).toBe(1);
  await act(async () => finish(answer));
  expect(result.current.ownership).toEqual(answer);
});

it("saving the editor's call leaves the reload to the document it changes", async () => {
  const document = transcribed();
  const { result, rerender } = renderHook(({ doc }) => useMultitrackOwnership(doc), { initialProps: { doc: document } });
  await waitFor(() => expect(passes()).toBe(1));
  await act(async () => result.current.setCue("track-1", "cue-1", "owner", null));
  expect(mocks.invoke).toHaveBeenCalledWith("aaf_set_cue_ownership", { documentId: document.id, trackId: "track-1", cueId: "cue-1", label: "owner", heardOn: null });
  expect(passes()).toBe(1);
  // The change event's re-read brings the call back in the document.
  rerender({ doc: { ...document, ownership: [{ track_id: "track-1", cue_id: "cue-1", label: "owner" }] } });
  await waitFor(() => expect(passes()).toBe(2));
});
