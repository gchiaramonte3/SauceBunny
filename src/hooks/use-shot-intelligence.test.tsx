// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useShotIntelligence } from "./use-shot-intelligence";

const mocks = vi.hoisted(() => ({ run: vi.fn(), stop: vi.fn(), start: vi.fn(), cancel: vi.fn(), invoke: vi.fn(), save: vi.fn(), create: vi.fn(), validate: vi.fn(), audioCreate: vi.fn(), nativeError: "" }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("./use-video-intelligence", () => ({ useVideoIntelligence: () => ({ run: mocks.run, stop: mocks.stop, error: mocks.nativeError }) }));
vi.mock("../lib/scene-analysis/client", () => ({ startSceneAnalysis: mocks.start }));
vi.mock("../lib/scene-analysis/evidence", () => ({ createSceneEvidence: mocks.create, createAudioEvidence: mocks.audioCreate, saveSceneEvidence: mocks.save,
  shotBatches: () => [[{ id: 1, start_us: 0, end_us: 1000, transcript: "hello" }]], validateShotAnswers: mocks.validate }));
const source = { path: "/clip.mp4", sha256: "a".repeat(64), duration_us: 1000, origin_us: 0 };
const proxy = { path: "/proxy.mp4", source };
const evidence = { id: "b".repeat(64), shots: [{ id: 1 }], proxy };
const answer = { shots: [{ id: 1, text: "A visible frame" }] };
const models = { models: [{ id: "qwen3.5-9b-video", ready: true }] };
const audio = { analysis_id: evidence.id, source, audio_track_index: 0, status: "no-audio", windows: [] };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  vi.resetAllMocks();
  mocks.nativeError = "";
  mocks.run.mockImplementation(async ({ operation }) => operation === "models" ? models : operation === "prepare-shot-proxy"
    ? { scene_proxy: proxy } : operation === "inspect-video" ? { analysis_source: source }
      : operation === "analyze-audio" ? { audio_analysis: audio } : { shot_analysis: answer });
  mocks.audioCreate.mockImplementation((_evidence, audio) => audio);
  mocks.start.mockReturnValue({ result: Promise.resolve({ boundaries: [] }), cancel: mocks.cancel });
  mocks.create.mockResolvedValue(evidence); mocks.save.mockResolvedValue(undefined);
  mocks.invoke.mockResolvedValue("1\n00:00:00,000 --> 00:00:01,000\nhello\n");
});
afterEach(cleanup);

describe("shot analysis ownership", () => {
  it("never loads models, decodes, or downloads on mount", () => {
    renderHook(() => useShotIntelligence("/clip.mp4", null));
    expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled();
  });
  it("saves immutable detection before inference and passes source-bound speech", async () => {
    const { result } = renderHook(() => useShotIntelligence("/clip.mp4", "/clip.srt"));
    await act(() => result.current.start());
    expect(mocks.create.mock.calls[0][2][0].text).toBe("hello");
    expect(mocks.save).toHaveBeenCalledWith(evidence);
    expect(mocks.run.mock.calls.map(call => call[0].operation)).toEqual(["models", "prepare-shot-proxy", "inspect-video", "analyze-shots", "analyze-audio"]);
    expect(mocks.validate).toHaveBeenCalledWith(evidence, expect.any(Array), answer);
    expect(result.current.complete).toBe(true); expect(result.current.answers).toEqual(answer.shots);
    expect(mocks.run).toHaveBeenLastCalledWith({ operation: "analyze-audio", path: source.path,
      source_sha256: source.sha256, analysis_id: evidence.id, origin_us: source.origin_us, duration_us: source.duration_us, audio_track_index: 0 });
    expect(mocks.audioCreate).toHaveBeenCalledWith(evidence, audio);
    expect(result.current.audio).toEqual({ status: "ready", evidence: audio });
  });
  it("refuses missing weights before preparing video, without automatic download", async () => {
    mocks.run.mockResolvedValue({ models: [] });
    const { result } = renderHook(() => useShotIntelligence("/clip.mp4", null));
    await act(() => result.current.start());
    expect(mocks.run).toHaveBeenCalledTimes(1); expect(mocks.start).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/Models/);
  });
  it("Stop before native readiness prevents decoding even if a late response succeeds", async () => {
    const gate = deferred<typeof models>(); mocks.run.mockReturnValue(gate.promise);
    const { result } = renderHook(() => useShotIntelligence("/clip.mp4", null));
    let operation!: Promise<void>;
    act(() => { operation = result.current.start(); result.current.stop(); });
    await act(async () => { gate.resolve(models); await operation; });
    expect(mocks.stop).toHaveBeenCalledOnce(); expect(mocks.start).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(false); expect(result.current.error).toBe("");
  });
  it("Stop during detector cleanup rejects even a racing successful result", async () => {
    const gate = deferred<object>(); mocks.start.mockReturnValue({ result: gate.promise, cancel: mocks.cancel });
    const { result } = renderHook(() => useShotIntelligence("/clip.mp4", null));
    let operation!: Promise<void>;
    act(() => { operation = result.current.start(); });
    await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
    act(() => result.current.stop());
    await act(async () => { gate.resolve({ boundaries: [] }); await operation; });
    expect(mocks.cancel).toHaveBeenCalledOnce(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("Stop while evidence commits does not launch a model or publish stale shots", async () => {
    const gate = deferred<void>(); mocks.save.mockReturnValue(gate.promise);
    const { result } = renderHook(() => useShotIntelligence("/clip.mp4", null));
    let operation!: Promise<void>;
    act(() => { operation = result.current.start(); });
    await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
    act(() => result.current.stop());
    await act(async () => { gate.resolve(); await operation; });
    expect(mocks.run.mock.calls.some(call => call[0].operation === "analyze-shots")).toBe(false);
    expect(result.current.evidence).toBeNull();
  });
  it("source changes immediately hide results and permit a new run only after the old operation drains", async () => {
    const gate = deferred<object>(); mocks.run.mockImplementation(({ operation }) => operation === "models" ? Promise.resolve(models) : gate.promise);
    const { result, rerender } = renderHook(({ path }) => useShotIntelligence(path, null), { initialProps: { path: "/clip.mp4" } });
    let operation!: Promise<void>;
    act(() => { operation = result.current.start(); });
    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(2));
    rerender({ path: "/other.mp4" });
    expect(result.current.evidence).toBeNull(); expect(result.current.draining).toBe(true);
    await act(async () => { gate.resolve({ scene_proxy: proxy }); await operation; });
    expect(result.current.draining).toBe(false); expect(mocks.start).not.toHaveBeenCalled();
  });
  it("unmount cancels and rejects late native output", async () => {
    const gate = deferred<typeof models>(); mocks.run.mockReturnValue(gate.promise);
    const { result, unmount } = renderHook(() => useShotIntelligence("/clip.mp4", null));
    let operation!: Promise<void>;
    act(() => { operation = result.current.start(); }); unmount();
    gate.resolve(models); await operation;
    expect(mocks.stop).toHaveBeenCalledOnce(); expect(mocks.start).not.toHaveBeenCalled();
  });
  it("resuming playback cancels browser decoding as well as native work", async () => {
    const gate = deferred<object>(); mocks.start.mockReturnValue({ result: gate.promise, cancel: mocks.cancel });
    const { result, rerender } = renderHook(({ busy }) => useShotIntelligence("/clip.mp4", null, null, 0, busy), { initialProps: { busy: false } });
    let operation!: Promise<void>;
    act(() => { operation = result.current.start(); });
    await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
    rerender({ busy: true });
    expect(mocks.cancel).toHaveBeenCalledOnce();
    await act(async () => { gate.resolve({ boundaries: [] }); await operation; });
    expect(result.current.error).toContain("priority"); expect(mocks.save).not.toHaveBeenCalled();
    await act(() => result.current.start());
    expect(mocks.start).toHaveBeenCalledOnce();
  });
});

describe("optional source audio", () => {
  function holdAudio() {
    const gate = deferred<unknown>();
    const original = mocks.run.getMockImplementation()!;
    mocks.run.mockImplementation(request => request.operation === "analyze-audio" ? gate.promise : original(request));
    return gate;
  }
  it("native audio failure retains complete visuals and exposes its actual reason only as audio feedback", async () => {
    const gate = holdAudio();
    const { result } = renderHook(() => useShotIntelligence("/clip.mp4", null));
    let operation!: Promise<void>;
    act(() => { operation = result.current.start(); });
    await waitFor(() => expect(result.current.audio.status).toBe("analyzing"));
    expect(result.current.answers).toEqual(answer.shots);
    mocks.nativeError = "Native audio decoding changed source timing";
    await act(async () => { gate.resolve(null); await operation; });
    expect(result.current.audio.status).toBe("unavailable");
    expect(result.current.audioError).toBe(mocks.nativeError);
    expect(result.current.nativeError).toBe(""); expect(result.current.error).toBe("");
    expect(result.current.evidence).toBe(evidence); expect(result.current.answers).toEqual(answer.shots);
    expect(result.current.complete).toBe(true); expect(result.current.busy).toBe(false);
  });
  it("rejects audio that fails source association without discarding shot descriptions", async () => {
    mocks.audioCreate.mockImplementation(() => { throw new Error("Unrelated audio source"); });
    const { result } = renderHook(() => useShotIntelligence("/clip.mp4", null));
    await act(() => result.current.start());
    expect(result.current.audio.status).toBe("unavailable"); expect(result.current.audioError).toContain("Unrelated audio source");
    expect(result.current.answers).toEqual(answer.shots); expect(result.current.complete).toBe(true);
  });
  it("Stop rejects a late successful audio response but preserves already completed visual work", async () => {
    const gate = holdAudio();
    const { result } = renderHook(() => useShotIntelligence("/clip.mp4", null));
    let operation!: Promise<void>;
    act(() => { operation = result.current.start(); });
    await waitFor(() => expect(result.current.audio.status).toBe("analyzing"));
    act(() => result.current.stop());
    await act(async () => { gate.resolve({ audio_analysis: audio }); await operation; });
    expect(mocks.stop).toHaveBeenCalledOnce(); expect(mocks.audioCreate).not.toHaveBeenCalled();
    expect(result.current.audio.status).toBe("stopped"); expect(result.current.complete).toBe(false);
    expect(result.current.answers).toEqual(answer.shots); expect(result.current.busy).toBe(false);
  });
  it.each(["source", "revision", "transcript"])("a changed %s cannot borrow pending audio", async kind => {
    const gate = holdAudio();
    const { result, rerender } = renderHook(({ path, revision, transcript }) => useShotIntelligence(path, transcript, "source-a", revision),
      { initialProps: { path: "/clip.mp4", revision: 0, transcript: "/clip.srt" } });
    let operation!: Promise<void>;
    act(() => { operation = result.current.start(); });
    await waitFor(() => expect(result.current.audio.status).toBe("analyzing"));
    rerender({ path: kind === "source" ? "/other.mp4" : "/clip.mp4", revision: kind === "revision" ? 1 : 0,
      transcript: kind === "transcript" ? "/new.srt" : "/clip.srt" });
    expect(result.current.audio.status).toBe("not-started"); expect(result.current.draining).toBe(true);
    await act(async () => { gate.resolve({ audio_analysis: audio }); await operation; });
    expect(mocks.audioCreate).not.toHaveBeenCalled(); expect(result.current.evidence).toBeNull();
    expect(result.current.answers).toEqual([]); expect(result.current.draining).toBe(false);
  });
  it("unmount during audio requests Stop and never adopts its output", async () => {
    const gate = holdAudio();
    const { result, unmount } = renderHook(() => useShotIntelligence("/clip.mp4", null));
    let operation!: Promise<void>;
    act(() => { operation = result.current.start(); });
    await waitFor(() => expect(result.current.audio.status).toBe("analyzing"));
    unmount(); gate.resolve({ audio_analysis: audio }); await operation;
    expect(mocks.stop).toHaveBeenCalledOnce(); expect(mocks.audioCreate).not.toHaveBeenCalled();
  });
});
