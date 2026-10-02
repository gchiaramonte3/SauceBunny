// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { startShotDialogue } from "./dialogue";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), record: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("../transcript-history", () => ({ recordTranscript: mocks.record }));
vi.mock("../job-id", () => ({ newJobId: () => "owned-job" }));
const handlers = new Map<string, (event: { payload: never }) => void>();
const off = vi.fn();
const observer = () => ({ preview: vi.fn(), phase: vi.fn(), note: vi.fn() });
const send = (name: string, payload: object) => handlers.get(name)?.({ payload: payload as never });
const args = () => mocks.invoke.mock.calls.find(call => call[0] === "transcribe_local_file")?.[1].args;
const savedPath = () => `${args().output_dir}/${args().filename}.srt`;
async function started() { await vi.waitFor(() => expect(args()).toBeTruthy()); }
const done = (success = true) => send("transcript-done", { job_id: "owned-job", success, path: savedPath(), error: success ? null : "Cancelled" });
beforeEach(() => {
  vi.resetAllMocks(); handlers.clear(); localStorage.clear();
  localStorage.setItem("cp-defaults-v2", JSON.stringify({ whisperModel: "base.en", transcriptLibrary: "/library", transcriptionLanguage: "en", expectedSpeakers: 2 }));
  mocks.listen.mockImplementation(async (name, handler) => { handlers.set(name, handler); return off; });
  mocks.invoke.mockImplementation(async command => command === "list_whisper_models" ? [{ id: "base.en", downloaded: true }]
    : command === "read_text_file_capped" ? "saved speech" : undefined);
});
describe("analysis dialogue uses the Clip pipeline", () => {
  it("leaves the unique suffix intact for long Unicode source names", async () => {
    const job = startShotDialogue(`/source/${"🎞️".repeat(80)}.mp4`, 10, observer());
    await started();
    expect(new TextEncoder().encode(args().filename).length).toBeLessThan(180);
    expect(args().filename).toMatch(/-dialogue-owned-job$/);
    expect(args().filename).not.toContain("\uFFFD");
    done(); await job.result;
  });
  it("registers before dispatch, publishes Whisper before diarization, and records the committed file", async () => {
    const callbacks = observer(), job = startShotDialogue("/source/Clip.mp4", 158, callbacks);
    await started();
    expect(handlers.size).toBe(4);
    expect(args()).toMatchObject({ input_path: "/source/Clip.mp4", model_id: "base.en", engine: "whisper", detect_speakers: true,
      expected_speakers: 2, speed: "fast", language: "en", duration_seconds: 158, local_only: true });
    send("transcript-preview", { job_id: "owned-job", path: savedPath() });
    await vi.waitFor(() => expect(callbacks.preview).toHaveBeenCalledWith("saved speech"));
    expect(mocks.record).not.toHaveBeenCalled();
    send("transcript-phase", { job_id: "owned-job", phase: "diarize-process" });
    expect(callbacks.phase).toHaveBeenCalledWith("Detecting speakers…", null);
    done();
    expect((await job.result).raw).toBe("saved speech");
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ srtPath: savedPath(), sourcePath: "/source/Clip.mp4" }));
    expect(off).toHaveBeenCalledTimes(4);
  });
  it("does not download missing models or silently select another one", async () => {
    mocks.invoke.mockResolvedValue([{ id: "tiny.en", downloaded: true }]);
    await expect(startShotDialogue("/clip.mp4", 10, observer()).result).rejects.toThrow("select an installed Whisper");
    expect(args()).toBeUndefined(); expect(mocks.listen).not.toHaveBeenCalled();
  });
  it("ignores other jobs and wrong preview paths", async () => {
    const callbacks = observer(), job = startShotDialogue("/clip.mp4", 10, callbacks);
    await started();
    send("transcript-preview", { job_id: "other", path: savedPath() });
    send("transcript-preview", { job_id: "owned-job", path: "/not-ours.srt" });
    send("transcript-phase", { job_id: "other", phase: "whisper" });
    send("transcript-done", { job_id: "other", success: true, path: "/not-ours.srt" });
    expect(callbacks.preview).not.toHaveBeenCalled(); expect(callbacks.phase).not.toHaveBeenCalled();
    done(); await job.result;
  });
  it("Stop drains and records a late committed save without publishing it", async () => {
    const callbacks = observer(), job = startShotDialogue("/clip.mp4", 10, callbacks);
    const rejected = expect(job.result).rejects.toThrow("Dialogue cancelled");
    await started(); job.cancel();
    expect(mocks.invoke).toHaveBeenCalledWith("cancel_job", { jobId: "owned-job" });
    send("transcript-preview", { job_id: "owned-job", path: savedPath() }); done();
    await rejected;
    expect(mocks.record).toHaveBeenCalledOnce(); expect(callbacks.preview).not.toHaveBeenCalled();
  });
  it("Stop before setup never dispatches a recognizer", async () => {
    const job = startShotDialogue("/clip.mp4", 10, observer()); job.cancel();
    await expect(job.result).rejects.toThrow("Dialogue cancelled");
    expect(args()).toBeUndefined();
  });
  it("cleans up listeners after an IPC failure", async () => {
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, ...rest) => command === "transcribe_local_file" ? Promise.reject(new Error("spawn failed")) : original(command, ...rest));
    await expect(startShotDialogue("/clip.mp4", 10, observer()).result).rejects.toThrow("spawn failed");
    expect(off).toHaveBeenCalledTimes(4); expect(mocks.record).not.toHaveBeenCalled();
  });
});
