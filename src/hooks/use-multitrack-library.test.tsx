// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMultitrackLibrary } from "./use-multitrack-library";
import { multitrackFixture, multitrackTranscript } from "../test/multitrack-fixture";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), changed: null as null | (() => void) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (_: string, fn: () => void) => { mocks.changed = fn; return () => {}; }) }));
beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);
it("reconciles committed results after each native save and after reopening", async () => {
  const disk = multitrackFixture();
  mocks.invoke.mockImplementation(async command => command === "aaf_list" ? [{ id: disk.id, name: disk.manifest.name, source_path: disk.source_path, track_count: 3, transcribed_tracks: disk.transcripts.length }] : structuredClone(disk));
  const { result, rerender } = renderHook(({ visible }) => useMultitrackLibrary(visible), { initialProps: { visible: true } });
  await act(async () => {}); expect(result.current.entries).toHaveLength(0);
  disk.transcripts.push({ ...multitrackTranscript(), status: "empty", cues: [] });
  await act(async () => mocks.changed?.());
  expect(result.current.entries[0].title).toBe("Interview.aaf");
  act(() => result.current.select(disk.id));
  await waitFor(() => expect(result.current.document?.transcripts).toHaveLength(1));
  rerender({ visible: false }); disk.transcripts.push(multitrackTranscript("track-2"));
  rerender({ visible: true });
  await waitFor(() => expect(result.current.document?.transcripts).toHaveLength(2));
  expect(result.current.entries).toHaveLength(1);
});
it("rejects a delayed older document read after a newer commit event", async () => {
  let finish!: (value: ReturnType<typeof multitrackFixture>) => void, reads = 0;
  const disk = multitrackFixture(); disk.transcripts = [multitrackTranscript()];
  mocks.invoke.mockImplementation(async command => {
    if (command === "aaf_list") return [];
    if (++reads === 1) return new Promise(resolve => { finish = resolve; });
    return structuredClone(disk);
  });
  const { result } = renderHook(() => useMultitrackLibrary(true));
  act(() => result.current.select(disk.id)); await waitFor(() => expect(reads).toBe(1));
  await act(async () => mocks.changed?.());
  await waitFor(() => expect(result.current.document?.transcripts).toHaveLength(1));
  await act(async () => finish(multitrackFixture()));
  expect(result.current.document?.transcripts).toHaveLength(1);
});
