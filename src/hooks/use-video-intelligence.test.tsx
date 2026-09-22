// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVideoIntelligence, useVideoForegroundPriority } from "./use-video-intelligence";
import type { VideoProgress } from "../bindings/VideoProgress";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), unlisten: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
const response = { models: [], sources: [], hits: [], answers: [] };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { vi.resetAllMocks(); mocks.listen.mockResolvedValue(mocks.unlisten); mocks.invoke.mockResolvedValue(response); });
afterEach(cleanup);

describe("video worker ownership", () => {
  it("observes only owned live progress and reports native errors without swallowing the reason", async () => {
    let reject!: (error: unknown) => void;
    const gate = new Promise((_, no) => { reject = no; });
    mocks.invoke.mockReturnValue(gate);
    const observer = { progress: vi.fn(), error: vi.fn() };
    const { result } = renderHook(() => useVideoIntelligence());
    let operation!: Promise<unknown>;
    act(() => { operation = result.current.run({ operation: "models" }, false, observer); });
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledOnce());
    const id = mocks.invoke.mock.calls[0][1].jobId;
    const listener = mocks.listen.mock.calls[0][1] as (event: { payload: VideoProgress }) => void;
    const progress = { job_id: id, phase: "loading-model", completed: 0, total: 0 };
    act(() => { listener({ payload: { ...progress, job_id: "foreign" } }); listener({ payload: progress }); });
    expect(observer.progress).toHaveBeenCalledExactlyOnceWith(progress);
    await act(async () => { reject(new Error("Decoder failure")); await operation; });
    expect(observer.error).toHaveBeenCalledExactlyOnceWith("Decoder failure");
    act(() => listener({ payload: progress }));
    expect(observer.progress).toHaveBeenCalledOnce();
  });
  it("one paused player cannot release another player's foreground priority", () => {
    const first = renderHook(({ busy }) => useVideoForegroundPriority(busy), { initialProps: { busy: true } });
    const second = renderHook(({ busy }) => useVideoForegroundPriority(busy), { initialProps: { busy: true } });
    first.rerender({ busy: false });
    expect(mocks.invoke).toHaveBeenLastCalledWith("video_set_foreground_busy", { busy: true });
    second.unmount();
    expect(mocks.invoke).toHaveBeenLastCalledWith("video_set_foreground_busy", { busy: false });
  });
  it("does no inference or downloads on mount", () => {
    renderHook(() => useVideoIntelligence());
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("Stop before listener registration prevents native startup", async () => {
    const gate = deferred<() => void>(); mocks.listen.mockReturnValue(gate.promise);
    const { result } = renderHook(() => useVideoIntelligence());
    let operation!: Promise<unknown>;
    act(() => { operation = result.current.run({ operation: "index", paths: ["/chosen.mp4"] }); });
    act(() => result.current.stop());
    await act(async () => { gate.resolve(mocks.unlisten); await operation; });
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.unlisten).toHaveBeenCalledOnce();
    expect(result.current.busy).toBe(false);
  });
  it("ignores foreign progress, cancels its own child, and rejects late results", async () => {
    const gate = deferred<typeof response>();
    mocks.invoke.mockImplementation((command) => command === "video_intelligence_run" ? gate.promise : Promise.resolve());
    const { result } = renderHook(() => useVideoIntelligence());
    let operation!: Promise<unknown>;
    act(() => { operation = result.current.run({ operation: "sources" }); });
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledOnce());
    const id = mocks.invoke.mock.calls[0][1].jobId;
    const listener = mocks.listen.mock.calls[0][1] as (event: { payload: VideoProgress }) => void;
    act(() => listener({ payload: { job_id: "another", phase: "indexing", completed: 1, total: 2 } }));
    expect(result.current.progress).toBeNull();
    act(() => result.current.stop());
    expect(mocks.invoke).toHaveBeenCalledWith("cancel_job", { jobId: id });
    let value: unknown;
    await act(async () => { gate.resolve(response); value = await operation; });
    expect(value).toBeNull();
    expect(result.current.busy).toBe(false);
  });
  it("unmount stops an active worker without publishing results", async () => {
    const gate = deferred<typeof response>();
    mocks.invoke.mockImplementation((command) => command === "video_intelligence_run" ? gate.promise : Promise.resolve());
    const { result, unmount } = renderHook(() => useVideoIntelligence());
    let operation!: Promise<unknown>;
    act(() => { operation = result.current.run({ operation: "models" }); });
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledOnce());
    unmount();
    expect(mocks.invoke.mock.calls[1][0]).toBe("cancel_job");
    gate.resolve(response);
    expect(await operation).toBeNull();
  });
});
