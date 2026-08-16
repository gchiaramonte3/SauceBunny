// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useTranscriptListeners } from "./use-transcript-listeners";

/**
 * `transcript-done` has THREE branches and the middle one is the interesting
 * one: a run that ends with the literal error "Cancelled" is the user pressing
 * Stop, and anything else — including a bare exit-code string from a whisper
 * that actually crashed — has to fall through to the error branch.
 *
 * The comment in the handler says exactly that, and until this hook came out
 * of App.tsx there was no way to check it. Absorbing a crash as a cancel is
 * the failure that matters: the button returns to idle, no error is shown, and
 * the user waits for a transcript that is never coming.
 *
 * The listeners are captured rather than mocked away — `listen` is stubbed to
 * record each handler by event name, so the tests drive the real handler
 * bodies with synthetic payloads.
 */

const h = vi.hoisted(() => ({
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
  unlistened: 0,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    h.handlers.set(name, cb);
    return () => { h.unlistened += 1; };
  },
}));

vi.mock("../lib/transcript-history", () => ({ recordTranscript: vi.fn() }));

const JOB = "job-1";

function deps() {
  return {
    appendLog: vi.fn(),
    refreshWhisperModels: vi.fn(),
    notify: vi.fn(),
    pushNotification: vi.fn(),
    logRunTotals: vi.fn(),
    setTranscriptState: vi.fn(),
    setTranscriptResolution: vi.fn(),
    setTranscriptError: vi.fn(),
    setTranscriptProgress: vi.fn(),
    setTranscriptPhase: vi.fn(),
    setActiveTranscript: vi.fn(),
    setTranscriptArrivedTick: vi.fn(),
    transcriptJobIdRef: { current: JOB as string | null },
    txChannelRef: { current: "whisper" },
    clipSourceKeyRef: { current: "src-key" as string | null },
    localFilePathRef: { current: "/M/a.mov" as string | null },
    metadataRef: { current: null },
    stageClockRef: { current: { phase: null as string | null, at: 0 } },
  } as unknown as Parameters<typeof useTranscriptListeners>[0];
}

async function mount() {
  const d = deps();
  const r = renderHook(() => useTranscriptListeners(d));
  await waitFor(() => expect(h.handlers.has("transcript-done")).toBe(true));
  return { d, ...r };
}

const fire = (name: string, payload: unknown) => h.handlers.get(name)!({ payload });

beforeEach(() => { h.handlers.clear(); h.unlistened = 0; });
afterEach(() => vi.clearAllMocks());

describe("the hook subscribes", () => {
  it("registers every pipeline event, and unregisters them on unmount", async () => {
    // If this ever drops one the symptom is a pipeline that runs and reports
    // nothing, so the count is asserted rather than eyeballed.
    const { unmount } = await mount();
    expect([...h.handlers.keys()].sort()).toEqual([
      "model-download-done", "transcript-done", "transcript-log",
      "transcript-phase", "transcript-progress",
    ]);
    unmount();
    await waitFor(() => expect(h.unlistened).toBe(5));
  });
});

describe("transcript-done", () => {
  it("loads the transcript and records history on success", async () => {
    const { d } = await mount();
    fire("transcript-done", { job_id: JOB, success: true, path: "/T/a.srt" });
    expect(d.setTranscriptState).toHaveBeenCalledWith("done");
    expect(d.setTranscriptResolution).toHaveBeenCalledWith("success");
    expect(d.setTranscriptError).toHaveBeenCalledWith(null);
    expect(d.setActiveTranscript).toHaveBeenCalledWith(
      { path: "/T/a.srt", origin: "whisper", sourceKey: "src-key" });
    expect(d.notify).toHaveBeenCalledWith("Transcript ready", "a.srt");
  });

  it("treats the literal 'Cancelled' as a user Stop, with no error flash", async () => {
    const { d } = await mount();
    fire("transcript-done", { job_id: JOB, success: false, error: "Cancelled" });
    expect(d.setTranscriptState).toHaveBeenCalledWith("idle");
    expect(d.setTranscriptResolution).toHaveBeenCalledWith(null);
    expect(d.setTranscriptError).toHaveBeenCalledWith(null);
    // A cancel is not a failure: no toast, no OS notification.
    expect(d.notify).not.toHaveBeenCalled();
    expect(d.pushNotification).not.toHaveBeenCalled();
  });

  it("does NOT absorb a crash as a cancel", async () => {
    // The distinction the handler exists for. Rust maps signal-kills to
    // "Cancelled", so a bare exit-code message means whisper actually died —
    // corrupt model, unreadable WAV, OOM. Reporting idle here would leave the
    // user waiting for a transcript that is never coming.
    const { d } = await mount();
    fire("transcript-done", { job_id: JOB, success: false, error: "exited with code 1" });
    expect(d.setTranscriptState).toHaveBeenCalledWith("error");
    expect(d.setTranscriptResolution).toHaveBeenCalledWith("error");
    expect(d.setTranscriptState).not.toHaveBeenCalledWith("idle");
    expect(d.pushNotification).toHaveBeenCalled();
  });

  it("surfaces a skipped diarization on an otherwise successful run", async () => {
    // Success WITH an error string: the transcript is fine but speakers were
    // not detected. It used to reach the pipeline log only, so a user who
    // asked for speakers just got none and no explanation.
    const { d } = await mount();
    fire("transcript-done", { job_id: JOB, success: true, path: "/T/a.srt", error: "diarizer unavailable" });
    expect(d.setTranscriptState).toHaveBeenCalledWith("done");
    expect(d.pushNotification).toHaveBeenCalledWith(
      "info", "Speakers not detected", "diarizer unavailable");
  });

  it("ignores an event for a different job", async () => {
    // Two runs in a session: the second must not be steered by the first's
    // late-arriving completion.
    const { d } = await mount();
    fire("transcript-done", { job_id: "someone-else", success: true, path: "/T/x.srt" });
    expect(d.setTranscriptState).not.toHaveBeenCalled();
    expect(d.setActiveTranscript).not.toHaveBeenCalled();
  });
});

describe("transcript-phase", () => {
  it("resets the meter on a stage change, because each stage owns 0-100", async () => {
    const { d } = await mount();
    fire("transcript-phase", { job_id: JOB, phase: "extract" });
    expect(d.setTranscriptProgress).toHaveBeenCalledWith(0);
    expect(d.setTranscriptPhase).toHaveBeenCalledWith("extract");
  });

  it("does not reset the meter when the same phase repeats", async () => {
    // Otherwise a repeated marker would stutter the pill back to 0 mid-stage.
    const { d } = await mount();
    d.stageClockRef.current = { phase: "whisper", at: Date.now() };
    fire("transcript-phase", { job_id: JOB, phase: "whisper" });
    expect(d.setTranscriptProgress).not.toHaveBeenCalled();
    expect(d.setTranscriptPhase).toHaveBeenCalledWith("whisper");
  });
});

describe("model-download-done", () => {
  it("refreshes the model list on success, and is NOT job-gated", async () => {
    // The only handler here without a job check: a model download is not a
    // transcription run, and gating it on the transcript job id would drop it.
    const { d } = await mount();
    fire("model-download-done", { job_id: "unrelated", success: true, path: "/m/small.bin" });
    expect(d.refreshWhisperModels).toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledWith("Whisper model ready", "small.bin");
  });

  it("reports a failed download without touching the model list", async () => {
    const { d } = await mount();
    fire("model-download-done", { job_id: "x", success: false, error: "network" });
    expect(d.refreshWhisperModels).not.toHaveBeenCalled();
    expect(d.pushNotification).toHaveBeenCalledWith("error", "Model download failed", "network");
  });
});
