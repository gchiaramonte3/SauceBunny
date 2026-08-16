// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useBatchTranscribe } from "./use-batch-transcribe";

const h = vi.hoisted(() => ({
  calls: [] as string[],
  args: [] as unknown[],
  /** Parks `transcribe_local_file` - the long await the loop actually has. */
  gate: null as null | { release: () => void },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, a?: unknown) => {
    h.calls.push(cmd);
    h.args.push(a);
    if (cmd === "transcribe_local_file" && h.gate) {
      await new Promise<void>((r) => { h.gate!.release = r; });
    }
    return "";
  },
}));

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
  h.gate = { release: () => {} };
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
  beforeEach(() => { h.calls = []; h.args = []; h.gate = null; });

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

    await act(async () => { h.gate!.release(); await started(); });
  });

  it("does not start the next file when Stop lands during the current one", async () => {
    const { result, started } = await startParked();
    expect(h.calls.filter((c) => c === "transcribe_local_file")).toHaveLength(1);

    await act(async () => { result.current.cancel(); });
    await act(async () => { h.gate!.release(); await started(); });

    // b.mov must never have been picked up.
    expect(h.calls.filter((c) => c === "transcribe_local_file")).toHaveLength(1);
  });

  it("settles the batch instead of leaving a row running forever", async () => {
    // `finished` requires nothing running. A row abandoned in "running" would
    // leave the status strip saying "Transcribing a.mov" for the rest of the
    // session.
    const { result, started } = await startParked();
    await act(async () => { result.current.cancel(); });
    await act(async () => { h.gate!.release(); await started(); });

    const items = result.current.state.items;
    expect(items.every((i) => i.status !== "running")).toBe(true);
    // a.mov was cancelled mid-flight; b.mov was never started, so it is
    // "skipped" rather than "error" - nothing ran, so nothing failed.
    expect(items[1].status).toBe("skipped");
    expect(result.current.progress.finished).toBe(true);
    expect(result.current.progress.failed).toBe(0);
  });

  it("runs the whole batch when nobody cancels", async () => {
    const { result } = renderHook(() => useBatchTranscribe());
    await act(async () => { await result.current.start(FILES, SETTINGS); });
    expect(h.calls.filter((c) => c === "transcribe_local_file")).toHaveLength(2);
    expect(result.current.state.items.map((i) => i.status)).toEqual(["done", "done"]);
    expect(result.current.progress.finished).toBe(true);
  });
});
