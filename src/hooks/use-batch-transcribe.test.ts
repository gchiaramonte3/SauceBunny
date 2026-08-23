// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useBatchTranscribe } from "./use-batch-transcribe";

const h = vi.hoisted(() => ({
  calls: [] as string[],
  args: [] as unknown[],
  /** Job ids the loop has started, in order. */
  waiting: [] as string[],
  /** The live `transcript-done` subscriber, if the loop has one attached. */
  sub: null as null | ((e: { payload: unknown }) => void),
  /** When true, every started job completes on its own on the next tick. */
  auto: true,
}));

/**
 * The wait is on the EVENT now, not on the invoke, and that is why this file
 * was rewritten.
 *
 * `transcribe_local_file` spawns the pipeline and returns in milliseconds, so
 * the invoke never was "the long await the loop actually has" — the gate that
 * used to sit here described a blocking command that does not exist. The loop
 * marked each file done the instant it started one: a folder of twelve
 * reported finished in about fifty milliseconds while twelve whisper
 * processes fought over the machine, and Stop had nothing left to kill. These
 * mocks drive `transcript-done`, which is what the loop actually waits for.
 */
function fireDone(jobId: string, ok = true, err?: string) {
  h.sub?.({ payload: { job_id: jobId, success: ok, code: ok ? 0 : 1, path: null, error: err ?? null } });
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, a?: unknown) => {
    h.calls.push(cmd);
    h.args.push(a);
    if (cmd === "transcribe_local_file") {
      const job = (a as { args?: { job_id?: string } } | undefined)?.args?.job_id;
      if (job) {
        h.waiting.push(job);
        // The real backend finishes some time later; "later" is a tick here.
        if (h.auto) setTimeout(() => fireDone(job), 0);
      }
    }
    return "";
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    if (name !== "transcript-done") return () => {};
    h.sub = cb;
    return () => { if (h.sub === cb) h.sub = null; };
  },
}));

/** Complete whichever job the loop is currently parked on. */
function finishCurrent(ok = true, err?: string) {
  const job = h.waiting.at(-1);
  if (job) fireDone(job, ok, err);
}

/**
 * Cancelling a batch.
 *
 * `cancel` does two things: it marks the state cancelled so the loop stops
 * handing out work, and it kills the Rust job so the file already being
 * transcribed stops too. The second half reads `jobRef`.
 *
 * This file used to test a window in that second half. The id came from
 * `await invoke("new_job_id")`, so between picking a file up and having
 * something to cancel it with there was a round trip in which `jobRef` was
 * still null - a Stop landing there stopped the QUEUE but not the file, which
 * transcribed to the end minutes after the user pressed it.
 *
 * That window is gone by construction: the id is minted synchronously in the
 * renderer (lib/job-id), so there is no instant where a file is in flight and
 * unkillable. What these tests now hold down is the half that is still real -
 * the loop awaits one file per turn, so a cancel during file 1 must be seen
 * before file 2 is picked up - plus the new invariant, that a cancel during a
 * running file finds a job id to kill.
 */
const FILES = [{ path: "/a.mov", name: "a.mov" }, { path: "/b.mov", name: "b.mov" }];
const SETTINGS = {
  outDir: "/out", modelId: "base", engine: "whisper", language: "en",
  detectSpeakers: false, expectedSpeakers: 0,
};

/** Start the batch and let it park inside the first file's transcription. */
async function startParked() {
  h.auto = false;
  const { result } = renderHook(() => useBatchTranscribe());
  let started!: Promise<void>;
  await act(async () => {
    started = result.current.start(FILES, SETTINGS);
    await Promise.resolve();
    await Promise.resolve();
  });
  return { result, started: () => started };
}

describe("useBatchTranscribe cancel", () => {
  beforeEach(() => { h.calls = []; h.args = []; h.waiting = []; h.sub = null; h.auto = true; });

  it("never asks the backend for a job id", () => {
    // The id is local now. If this ever fails, the round trip is back and the
    // window it opened is back with it.
    expect(h.calls).not.toContain("new_job_id");
  });

  it("has something to kill the moment a file is in flight", async () => {
    // Cancel during the FIRST file kills it, rather than finding jobRef null
    // and letting it run to the end.
    //
    // Scope, checked by mutation: this fails if jobRef is never set, and does
    // NOT fail if the id merely arrives a tick late - the parked await is the
    // transcription, well after the assignment, so the test cannot see a
    // one-tick delay ahead of it. The synchronousness itself is structural,
    // and lib/job-id.test.ts is what holds it down.
    const { result, started } = await startParked();
    expect(h.calls).toContain("transcribe_local_file");

    await act(async () => { result.current.cancel(); });
    expect(h.calls).toContain("cancel_job");
    const killed = h.args[h.calls.indexOf("cancel_job")] as { jobId?: string };
    expect(killed.jobId).toBeTruthy();

    await act(async () => { finishCurrent(true); await started(); });
  });

  it("does not start the next file when Stop lands during the current one", async () => {
    const { result, started } = await startParked();
    expect(h.calls.filter((c) => c === "transcribe_local_file")).toHaveLength(1);

    await act(async () => { result.current.cancel(); });
    await act(async () => { finishCurrent(true); await started(); });

    // b.mov must never have been picked up.
    expect(h.calls.filter((c) => c === "transcribe_local_file")).toHaveLength(1);
  });

  it("settles the batch instead of leaving a row running forever", async () => {
    // `finished` requires nothing running. A row abandoned in "running" would
    // leave the status strip saying "Transcribing a.mov" for the rest of the
    // session.
    const { result, started } = await startParked();
    await act(async () => { result.current.cancel(); });
    await act(async () => { finishCurrent(true); await started(); });

    const items = result.current.state.items;
    expect(items.every((i) => i.status !== "running")).toBe(true);
    // a.mov was cancelled mid-flight; b.mov was never started, so it is
    // "skipped" rather than "error" - nothing ran, so nothing failed.
    expect(items[1].status).toBe("skipped");
    expect(result.current.progress.finished).toBe(true);
    expect(result.current.progress.failed).toBe(0);
  });

  it("does not start file 2 until file 1 has actually finished", async () => {
    // THE bug this rewrite exists for. `transcribe_local_file` spawns and
    // returns, so awaiting the invoke meant the loop moved straight on: all N
    // files started at once, each loading its own copy of the whisper model,
    // and a folder of twelve could bring an 8 GB Mac to its knees.
    const { result } = await startParked();
    const started = () => h.calls.filter((c) => c === "transcribe_local_file").length;
    expect(started(), "the loop ran ahead before file 1 reported done").toBe(1);
    await act(async () => { finishCurrent(true); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(started()).toBe(2);
    void result;
  });

  it("reports a file done only when its pipeline ended, not when it started", async () => {
    // The visible half: the batch bar used to flash and vanish while nothing
    // had been written yet.
    const { result } = await startParked();
    expect(result.current.state.items[0].status).toBe("running");
    await act(async () => { finishCurrent(true); await Promise.resolve(); });
    expect(result.current.state.items[0].status).toBe("done");
  });

  it("records a failed file as an error and carries on", async () => {
    const { result } = await startParked();
    await act(async () => { finishCurrent(false, "unsupported codec"); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.state.items[0].status).toBe("error");
    expect(result.current.state.items[0].error).toContain("unsupported codec");
    expect(h.calls.filter((c) => c === "transcribe_local_file")).toHaveLength(2);
  });

  it("runs the whole batch when nobody cancels", async () => {
    const { result } = renderHook(() => useBatchTranscribe());
    await act(async () => { await result.current.start(FILES, SETTINGS); });
    expect(h.calls.filter((c) => c === "transcribe_local_file")).toHaveLength(2);
    expect(result.current.state.items.map((i) => i.status)).toEqual(["done", "done"]);
    expect(result.current.progress.finished).toBe(true);
  });
});
