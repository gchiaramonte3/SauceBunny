// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useShotIntelligence } from "./use-shot-intelligence";
import type { AnalysisPipelineEvent } from "../lib/scene-analysis/pipeline";
import type { VideoRunObserver } from "./use-video-intelligence";
import type { PictureModelId } from "../lib/picture-model";

const mocks = vi.hoisted(() => ({ run: vi.fn(), stop: vi.fn(), start: vi.fn(), cancel: vi.fn(), invoke: vi.fn(), save: vi.fn(), create: vi.fn(), validate: vi.fn(), audioCreate: vi.fn(), nativeError: "", emitTo: vi.fn(), dialogue: vi.fn(), dialogueCancel: vi.fn() }));
vi.mock("../lib/scene-analysis/dialogue", () => ({ startShotDialogue: mocks.dialogue }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emitTo: mocks.emitTo }));
vi.mock("./use-video-intelligence", () => ({ useVideoIntelligence: () => ({ run: mocks.run, stop: mocks.stop, error: mocks.nativeError }) }));
vi.mock("../lib/scene-analysis/client", () => ({ startSceneAnalysis: mocks.start }));
vi.mock("../lib/scene-analysis/evidence", () => ({ createSceneEvidence: mocks.create, createAudioEvidence: mocks.audioCreate, saveSceneEvidence: mocks.save,
  shotBatches: () => [[{ id: 1, start_us: 0, end_us: 1000, transcript: "hello" }]], validateShotAnswers: mocks.validate }));
const source = { path: "/clip.mp4", sha256: "a".repeat(64), duration_us: 1000, origin_us: 0 };
const proxy = { path: "/proxy.mp4", source, frame_count: 24 };
const evidence = { id: "b".repeat(64), shots: [{ id: 1 }], proxy };
const answer = { model_id: "qwen3.5-9b-video", shots: [{ id: 1, text: "A visible frame", picture_description: "A visible frame", transcript_summary: null }] };
const models = { models: [{ id: "qwen3.5-9b-video", ready: true }] };
const audio = { analysis_id: evidence.id, source, audio_track_index: 0, status: "no-audio", windows: [] };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  vi.resetAllMocks();
  mocks.emitTo.mockResolvedValue(undefined);
  mocks.nativeError = "";
  mocks.dialogue.mockImplementation(() => ({ result: Promise.reject(new Error("Whisper unavailable")), cancel: mocks.dialogueCancel }));
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
  const logs = () => mocks.emitTo.mock.calls.map(call => call[2] as AnalysisPipelineEvent);
  it("keeps the starting model when the saved default changes during preparation", async () => {
    const gate = deferred<object>(), original = mocks.run.getMockImplementation()!;
    mocks.run.mockImplementation((request, ...rest) => request.operation === "models" ? gate.promise : original(request, ...rest));
    const { result, rerender } = renderHook(({ model }) => useShotIntelligence("/clip.mp4", "/clip.srt", null, 0, false, model),
      { initialProps: { model: "qwen3.5-9b-video" as PictureModelId } });
    let operation!: Promise<void>;
    act(() => { operation = result.current.start(); });
    rerender({ model: "qwen3.5-4b-video" });
    await act(async () => { gate.resolve(models); await operation; });
    expect(result.current.complete).toBe(true);
    expect(result.current.modelUsed).toBe("qwen3.5-9b-video");
    expect(mocks.run.mock.calls.find(call => call[0].operation === "analyze-shots")?.[0].model_id).toBe("qwen3.5-9b-video");
  });
  it.each(["stop", "failure"])("retains completed live rows after %s and rejects late progress", async action => {
    const gate = deferred<object | null>(), original = mocks.run.getMockImplementation()!;
    mocks.run.mockImplementation((request, ...rest) => request.operation === "analyze-shots" ? gate.promise : original(request, ...rest));
    const { result } = renderHook(() => useShotIntelligence("/clip.mp4", "/clip.srt"));
    let operation!: Promise<void>;
    act(() => { operation = result.current.start(); });
    await waitFor(() => expect(mocks.run.mock.calls.some(call => call[0].operation === "analyze-shots")).toBe(true));
    const observer = mocks.run.mock.calls.find(call => call[0].operation === "analyze-shots")![2] as VideoRunObserver;
    act(() => observer.progress?.({ job_id: "job", phase: "shot-complete", completed: 1, total: 1, shot_analysis: answer as never }));
    expect(result.current.answers).toEqual(answer.shots);
    act(() => { if (action === "stop") result.current.stop(); else observer.error?.("Model stopped"); });
    await act(async () => { gate.resolve(null); await operation; });
    act(() => observer.progress?.({ job_id: "job", phase: "shot-complete", completed: 2, total: 2, shot_analysis: answer as never }));
    expect(result.current.answers).toEqual(answer.shots); expect(result.current.complete).toBe(false);
  });
  it("rejects a mismatched live model before painting it", async () => {
    const original = mocks.run.getMockImplementation()!;
    mocks.run.mockImplementation(async (request, preserve, observer: VideoRunObserver) => {
      if (request.operation !== "analyze-shots") return original(request, preserve, observer);
      observer.progress?.({ job_id: "job", phase: "shot-complete", completed: 1, total: 1,
        shot_analysis: { ...answer, model_id: "wrong" } as never });
      return { shot_analysis: answer };
    });
    const { result } = renderHook(() => useShotIntelligence("/clip.mp4", "/clip.srt"));
    await act(() => result.current.start());
    expect(result.current.answers).toEqual([]); expect(result.current.error).toContain("Unexpected live shot");
    expect(mocks.stop).toHaveBeenCalledOnce();
  });
  it("shows Whisper dialogue before speakers finish, then runs picture inference without competing jobs", async () => {
    const gate = deferred<{ raw: string; path: string; warning: string }>();
    mocks.dialogue.mockReturnValue({ result: gate.promise, cancel: mocks.dialogueCancel });
    mocks.create.mockResolvedValue({ ...evidence, shots: [{ id: 1, start_us: 0, end_us: 1000 }] });
    const { result } = renderHook(() => useShotIntelligence("/clip.mp4", null));
    let operation!: Promise<void>;
    act(() => { operation = result.current.start(); });
    await waitFor(() => expect(mocks.dialogue).toHaveBeenCalledOnce());
    expect(mocks.run.mock.calls.some(call => call[0].operation === "analyze-shots")).toBe(false);
    act(() => mocks.dialogue.mock.calls[0][2].preview("1\n00:00:00,000 --> 00:00:00,001\nHello\n"));
    expect(result.current.dialogue.text[1]).toBe("Hello");
    expect(result.current.dialogue.status).toBe("analyzing");
    await act(async () => {
      gate.resolve({ raw: "1\n00:00:00,000 --> 00:00:00,001\n[SPEAKER_00] Hello\n", path: "/saved.srt", warning: "" });
      await operation;
    });
    expect(result.current.dialogue.text[1]).toContain("SPEAKER_00");
    expect(result.current.dialogue.status).toBe("ready"); expect(result.current.complete).toBe(true);
    await act(() => result.current.start());
    expect(mocks.dialogue).toHaveBeenCalledOnce(); // Retry reuses this source's committed dialogue.
  });
  it("cancels dialogue on source change and never adopts the old speech or starts its picture model", async () => {
    const gate = deferred<{ raw: string; path: string; warning: string }>();
    mocks.dialogue.mockReturnValue({ result: gate.promise, cancel: mocks.dialogueCancel });
    const { result, rerender } = renderHook(({ path }) => useShotIntelligence(path, null), { initialProps: { path: "/clip.mp4" } });
    let operation!: Promise<void>;
    act(() => { operation = result.current.start(); });
    await waitFor(() => expect(mocks.dialogue).toHaveBeenCalledOnce());
    rerender({ path: "/new.mp4" });
    expect(mocks.dialogueCancel).toHaveBeenCalledOnce();
    await act(async () => { gate.resolve({ raw: "old", path: "/saved.srt", warning: "" }); await operation; });
    expect(result.current.dialogue.text).toEqual({}); expect(result.current.evidence).toBeNull();
    expect(mocks.run.mock.calls.some(call => call[0].operation === "analyze-shots")).toBe(false);
  });
  it("fills a completed shot before batch delivery and reconciles without duplicates", async () => {
    const gate = deferred<object>();
    const original = mocks.run.getMockImplementation()!;
    mocks.run.mockImplementation((request, ...rest) => request.operation === "analyze-shots" ? gate.promise : original(request, ...rest));
    const { result } = renderHook(() => useShotIntelligence("/clip.mp4", null));
    let operation!: Promise<void>;
    act(() => { operation = result.current.start(); });
    await waitFor(() => expect(mocks.run.mock.calls.some(call => call[0].operation === "analyze-shots")).toBe(true));
    const observer = mocks.run.mock.calls.find(call => call[0].operation === "analyze-shots")![2] as VideoRunObserver;
    act(() => {
      observer.progress?.({ job_id: "job", phase: "loading-model", completed: 0, total: 0 });
      observer.progress?.({ job_id: "job", phase: "shot-complete", completed: 1, total: 1, shot_analysis: answer as never });
    });
    await waitFor(() => expect(logs().some(row => row.message.includes("Shot 1 of 1 ready"))).toBe(true));
    expect(result.current.answers).toEqual(answer.shots);
    expect(logs().some(row => row.message.includes("Received"))).toBe(false);
    await act(async () => { gate.resolve({ shot_analysis: answer }); await operation; });
    await waitFor(() => expect(logs().at(-1)?.status).toBe("finished"));
    const text = logs().map(row => row.message).join("\n");
    expect(text).toContain("Qwen3.5 9B"); expect(text).toContain("24 frames");
    expect(text).toContain("No transcript supplied"); expect(text).toContain("Received 1 of 1");
    expect(text).toContain("no audio track"); expect(logs().at(-1)?.tag).toBe("warn"); // Missing Whisper is an honest partial result.
    expect(result.current.answers).toHaveLength(1);
  });
  it.each(["user", "playback", "source", "unmount"])("logs why %s stops work and ignores late model progress", async reason => {
    const gate = deferred<object>(); mocks.run.mockReturnValue(gate.promise);
    const { result, rerender, unmount } = renderHook(({ path, busy }) => useShotIntelligence(path, null, null, 0, busy),
      { initialProps: { path: "/clip.mp4", busy: false } });
    let operation!: Promise<void>;
    act(() => { operation = result.current.start(); });
    const observer = mocks.run.mock.calls[0][2] as VideoRunObserver;
    if (reason === "user") act(() => result.current.stop());
    if (reason === "playback") rerender({ path: "/clip.mp4", busy: true });
    if (reason === "source") rerender({ path: "/different.mp4", busy: false });
    if (reason === "unmount") unmount();
    observer.progress?.({ job_id: "job", phase: "loading-model", completed: 0, total: 0 });
    await act(async () => { gate.resolve(models); await operation; });
    await waitFor(() => expect(logs().at(-1)?.status).toBe("finished"));
    const why = { user: "requested by user", playback: "took priority", source: "source or transcript changed", unmount: "panel closed" }[reason];
    expect(logs().at(-1)?.message).toContain(why);
    expect(logs().filter(row => row.status === "finished")).toHaveLength(1);
    expect(logs().some(row => row.message.includes("Loading") || row.message.includes("Analysis complete"))).toBe(false);
  });
  it("logs a native decoder failure with its actual stage and reason", async () => {
    const original = mocks.run.getMockImplementation()!;
    mocks.run.mockImplementation(async (request, preserve, observer: VideoRunObserver) => {
      if (request.operation !== "prepare-shot-proxy") return original(request, preserve, observer);
      observer.error?.("Source: clip.mp4. Codec: av1. Stage: decoder preflight. Decode failed.");
      return null;
    });
    const { result } = renderHook(() => useShotIntelligence("/clip.mp4", null));
    await act(() => result.current.start());
    await waitFor(() => expect(logs().at(-1)?.status).toBe("finished"));
    expect(logs().at(-1)?.tag).toBe("err");
    expect(logs().at(-1)?.message).toContain("Codec: av1. Stage: decoder preflight");
    expect(result.current.error).toContain("Decode failed");
  });
  it("never loads models, decodes, or downloads on mount", () => {
    renderHook(() => useShotIntelligence("/clip.mp4", null));
    expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled();
  });
  it("saves immutable detection before inference and passes source-bound speech", async () => {
    const { result } = renderHook(() => useShotIntelligence("/clip.mp4", "/clip.srt"));
    await act(() => result.current.start());
    expect(mocks.create.mock.calls[0][2][0].text).toBe("hello");
    expect(mocks.dialogue).not.toHaveBeenCalled();
    expect(mocks.save).toHaveBeenCalledWith(evidence);
    expect(mocks.run.mock.calls.map(call => call[0].operation)).toEqual(["models", "prepare-shot-proxy", "inspect-video", "analyze-shots", "analyze-audio"]);
    expect(mocks.validate).toHaveBeenCalledWith(evidence, expect.any(Array), answer);
    expect(result.current.complete).toBe(true); expect(result.current.answers).toEqual(answer.shots);
    expect(mocks.run).toHaveBeenLastCalledWith({ operation: "analyze-audio", path: source.path,
      source_sha256: source.sha256, analysis_id: evidence.id, origin_us: source.origin_us, duration_us: source.duration_us, audio_track_index: 0 }, false, expect.any(Object));
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
  it("uses the installed music model without downloading or running two audio classifiers", async () => {
    const original = mocks.run.getMockImplementation()!;
    const music = { ...audio, labels: [] };
    mocks.run.mockImplementation(request => request.operation === "models"
      ? Promise.resolve({ models: [...models.models, { id: "ast-audioset", ready: true }] })
      : request.operation === "analyze-music" ? Promise.resolve({ music_analysis: music }) : original(request));
    const { result } = renderHook(() => useShotIntelligence("/clip.mp4", null));
    await act(() => result.current.start());
    expect(mocks.run.mock.calls.map(call => call[0].operation)).toEqual(["models", "prepare-shot-proxy", "inspect-video", "analyze-shots", "analyze-music"]);
    expect(mocks.audioCreate).toHaveBeenCalledWith(evidence, music);
    expect(result.current.audio).toEqual({ status: "ready", evidence: music });
  });
  it.each(["stop", "source", "unmount", "playback", "failure"])("installed music analysis respects %s without borrowing a late result", async kind => {
    const gate = deferred<unknown>();
    const original = mocks.run.getMockImplementation()!;
    mocks.run.mockImplementation(request => request.operation === "models"
      ? Promise.resolve({ models: [...models.models, { id: "ast-audioset", ready: true }] })
      : request.operation === "analyze-music" ? gate.promise : original(request));
    const { result, rerender, unmount } = renderHook(({ path, busy }) => useShotIntelligence(path, null, null, 0, busy),
      { initialProps: { path: "/clip.mp4", busy: false } });
    let operation!: Promise<void>;
    act(() => { operation = result.current.start(); });
    await waitFor(() => expect(result.current.audio.status).toBe("analyzing"));
    expect(mocks.run).toHaveBeenLastCalledWith(expect.objectContaining({ operation: "analyze-music" }), false, expect.any(Object));
    if (kind === "stop") act(() => result.current.stop());
    if (kind === "source") rerender({ path: "/other.mp4", busy: false });
    if (kind === "playback") rerender({ path: "/clip.mp4", busy: true });
    if (kind === "unmount") unmount();
    if (kind === "failure") mocks.nativeError = "Music model failed";
    await act(async () => {
      gate.resolve(kind === "failure" ? null : { music_analysis: { ...audio, labels: [] } });
      await operation;
    });
    expect(mocks.audioCreate).not.toHaveBeenCalled();
    expect(mocks.run.mock.calls.some(call => call[0].operation === "analyze-audio" || call[0].operation === "download")).toBe(false);
    if (kind !== "failure") expect(mocks.stop).toHaveBeenCalledOnce();
    if (kind !== "unmount") {
      expect(result.current.busy).toBe(false);
      expect(result.current.answers).toEqual(kind === "source" ? [] : answer.shots);
      expect(result.current.complete).toBe(kind === "failure");
    }
    if (kind === "failure") expect(result.current.audioError).toBe("Music model failed");
  });
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
