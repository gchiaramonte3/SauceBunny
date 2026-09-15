// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AafTrackTranscript } from "../bindings/AafTrackTranscript";
import { multitrackFixture, multitrackTranscript } from "../test/multitrack-fixture";
import { useMultitrackTranscription } from "./use-multitrack-transcription";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
beforeEach(() => {
  vi.clearAllMocks(); mocks.listen.mockResolvedValue(() => {});
  mocks.invoke.mockImplementation((command: string) => command === "list_whisper_models" ? Promise.resolve([]) : command === "parakeet_model_downloaded" ? Promise.resolve(true) : Promise.resolve());
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

describe("multitrack jobs", () => {
  it("snapshots the requested regeneration model and replaces only the successful target", async () => {
    const pending = deferred<AafTrackTranscript>(), receive = vi.fn(), base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => command === "list_whisper_models" ? Promise.resolve([{ id: "large-v3", name: "Large v3", downloaded: true }]) : command === "aaf_transcribe_track" ? pending.promise : base(command, args));
    const { result } = renderHook(() => useMultitrackTranscription(multitrackFixture(), receive));
    await waitFor(() => expect(result.current.models).toHaveLength(1));
    let work!: Promise<void>;
    act(() => { work = result.current.start(["track-2"], 0, 24000, { engine: "whisper", modelId: "large-v3" }); });
    expect(receive).not.toHaveBeenCalled();
    expect(mocks.invoke.mock.calls.find(([command]) => command === "aaf_transcribe_track")![1]).toMatchObject({ trackId: "track-2", engine: "whisper", modelId: "large-v3", startFrame: 0, durationFrames: 24000 });
    act(() => result.current.setEngine("parakeet"));
    await act(async () => { pending.resolve(multitrackTranscript("track-2")); await work; });
    expect(receive).toHaveBeenCalledTimes(1); expect(receive.mock.calls[0][0].track_id).toBe("track-2");
    await act(async () => result.current.start(["track-1"], 0, 24000, { engine: "whisper", modelId: "not-installed" }));
    expect(result.current.error).toContain("not installed"); expect(receive).toHaveBeenCalledTimes(1);
  });
  it("rechecks installed models when returning from the in-app Settings page", async () => {
    let installed = false;
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => command === "parakeet_model_downloaded" ? Promise.resolve(installed) : base(command, args));
    const document = multitrackFixture(); const receive = vi.fn();
    const { result, rerender } = renderHook(({ active }) => useMultitrackTranscription(document, receive, active), { initialProps: { active: true } });
    await act(async () => {});
    expect(result.current.ready).toBe(false);
    rerender({ active: false }); installed = true;
    rerender({ active: true });
    await waitFor(() => expect(result.current.ready).toBe(true));
  });
  it("rejects an old readiness response after a newer model check", async () => {
    const oldCheck = deferred<boolean>(); let checks = 0;
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => command === "parakeet_model_downloaded" ? ++checks === 1 ? oldCheck.promise : Promise.resolve(true) : base(command, args));
    const { result } = renderHook(() => useMultitrackTranscription(multitrackFixture(), vi.fn()));
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => oldCheck.resolve(false));
    expect(result.current.ready).toBe(true);
  });
  it("stops following tracks but reconciles a successful result committed before Stop", async () => {
    const pending = deferred<AafTrackTranscript>(); const onTranscript = vi.fn();
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => command === "aaf_transcribe_track" ? pending.promise : base(command, args));
    const { result } = renderHook(() => useMultitrackTranscription(multitrackFixture(), onTranscript));
    await waitFor(() => expect(result.current.ready).toBe(true));
    let work!: Promise<void>;
    act(() => { work = result.current.start(["track-1", "track-2"], 120, 240); });
    const call = mocks.invoke.mock.calls.find(([command]) => command === "aaf_transcribe_track")!;
    expect(call[1]).toMatchObject({ startFrame: 120, durationFrames: 240, trackId: "track-1" });
    expect(typeof call[1].jobId).toBe("string");
    act(() => result.current.stop());
    expect(mocks.invoke).toHaveBeenCalledWith("cancel_job", { jobId: call[1].jobId });
    await act(async () => { pending.resolve(multitrackTranscript()); await work; });
    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "aaf_transcribe_track")).toHaveLength(1);
    expect(result.current.status).toContain("Stopped");
    expect(result.current.report).toMatchObject({ saved: 1, stopped: true });
    expect(result.current.resolution).toBeNull();
  });
  it("does not count a cancelled native job as a saved or failed track", async () => {
    let reject!: (cause: unknown) => void;
    const pending = new Promise<AafTrackTranscript>((_resolve, fail) => { reject = fail; });
    const receive = vi.fn(), base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => command === "aaf_transcribe_track" ? pending : base(command, args));
    const { result } = renderHook(() => useMultitrackTranscription(multitrackFixture(), receive));
    let work!: Promise<void>;
    act(() => { work = result.current.start(["track-1", "track-2"], 0, 240); });
    act(() => result.current.stop());
    await act(async () => { reject({ kind: "cancelled" }); await work; });
    expect(receive).not.toHaveBeenCalled();
    expect(result.current.report).toMatchObject({ saved: 0, failures: [], stopped: true });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "aaf_transcribe_track")).toHaveLength(1);
  });
  it("rejects the prior document's committed response without clobbering a newer run", async () => {
    const old = deferred<AafTrackTranscript>(), fresh = deferred<AafTrackTranscript>(), receive = vi.fn();
    const document = multitrackFixture(), other = { ...document, id: "other-sequence" }, base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => command === "aaf_transcribe_track" ? args.documentId === document.id ? old.promise : fresh.promise : base(command, args));
    const { result, rerender } = renderHook(({ source }) => useMultitrackTranscription(source, receive), { initialProps: { source: document } });
    let oldWork!: Promise<void>, freshWork!: Promise<void>;
    act(() => { oldWork = result.current.start(["track-1", "track-2"], 0, 240); });
    const oldJob = mocks.invoke.mock.calls.find(([command]) => command === "aaf_transcribe_track")![1].jobId;
    rerender({ source: other });
    expect(mocks.invoke).toHaveBeenCalledWith("cancel_job", { jobId: oldJob });
    act(() => { freshWork = result.current.start(["track-3"], 0, 240); });
    await act(async () => { old.resolve(multitrackTranscript()); await oldWork; });
    expect(receive).not.toHaveBeenCalled(); expect(result.current.loading).toBe(true);
    await act(async () => { fresh.resolve(multitrackTranscript("track-3")); await freshWork; });
    expect(receive).toHaveBeenCalledTimes(1); expect(receive.mock.calls[0][0].track_id).toBe("track-3");
    expect(result.current.report).toMatchObject({ saved: 1, stopped: false });
  });
  it("continues after a failed track and does not report full success", async () => {
    const onTranscript = vi.fn(); const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => command === "aaf_transcribe_track" ? args.trackId === "track-1" ? Promise.reject(new Error("Audio unavailable")) : Promise.resolve(multitrackTranscript(args.trackId)) : base(command, args));
    const { result } = renderHook(() => useMultitrackTranscription(multitrackFixture(), onTranscript));
    await act(async () => result.current.start(["track-1", "track-2"], 0, 240));
    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(result.current.status).toContain("1 failed"); expect(result.current.resolution).toBe("error");
    expect(result.current.error).toBeNull();
    expect(result.current.report).toMatchObject({ requested: 2, saved: 1, failures: [{ trackId: "track-1", message: "Audio unavailable" }] });
  });
  it("unmount cancels the owned job and ignores its late result", async () => {
    const pending = deferred<AafTrackTranscript>(); const onTranscript = vi.fn(); const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => command === "aaf_transcribe_track" ? pending.promise : base(command, args));
    const { result, unmount } = renderHook(() => useMultitrackTranscription(multitrackFixture(), onTranscript));
    act(() => { void result.current.start(["track-1"], 0, 240); });
    unmount(); await act(async () => pending.resolve(multitrackTranscript()));
    expect(mocks.invoke.mock.calls.some(([command]) => command === "cancel_job")).toBe(true);
    expect(onTranscript).not.toHaveBeenCalled();
  });
  it("counts a saved timing-review result without claiming clean success", async () => {
    const receive = vi.fn(), base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => command === "aaf_transcribe_track" ? Promise.resolve({ ...multitrackTranscript(), status: "review" }) : base(command, args));
    const { result } = renderHook(() => useMultitrackTranscription(multitrackFixture(), receive));
    await act(async () => result.current.start(["track-1"], 0, 240));
    expect(receive).toHaveBeenCalledTimes(1);
    expect(result.current.report).toMatchObject({ saved: 1, review: 1, failures: [] });
    expect(result.current.resolution).toBeNull();
    expect(result.current.status).toContain("timing review");
  });
});
