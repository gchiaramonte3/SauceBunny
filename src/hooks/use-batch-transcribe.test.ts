// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useBatchTranscribe } from "./use-batch-transcribe";

const h = vi.hoisted(() => ({
  calls: [] as string[],
  /** Parks `new_job_id` so a cancel can land inside the round trip. */
  gate: null as null | { release: () => void; reached: Promise<void> },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => {
    h.calls.push(cmd);
    if (cmd === "new_job_id") {
      if (h.gate) { await new Promise<void>((r) => { h.gate!.release = r; }); }
      return "job-1";
    }
    return "";
  },
}));

/**
 * Cancelling a batch.
 *
 * `cancel` does two things: it marks the state cancelled so the loop stops
 * handing out work, and it kills the Rust job so the file already being
 * transcribed stops too. The second half reads `jobRef`, which is only set
 * AFTER `new_job_id` comes back from Rust.
 *
 * So there is a window - short, one round trip - where a cancel finds no job
 * to kill. The queue stops, and the file whose id was in flight starts anyway
 * and runs to the end, minutes after the user pressed Stop.
 */
const FILES = [{ path: "/a.mov", name: "a.mov" }, { path: "/b.mov", name: "b.mov" }];
const SETTINGS = {
  outDir: "/out", modelId: "base", engine: "whisper", language: "en",
  detectSpeakers: false, expectedSpeakers: 0,
};

describe("useBatchTranscribe cancel", () => {
  beforeEach(() => { h.calls = []; h.gate = null; });

  it("does not start a file whose job id was in flight when Stop was pressed", async () => {
    h.gate = { release: () => {}, reached: Promise.resolve() };
    const { result } = renderHook(() => useBatchTranscribe());

    let started: Promise<void>;
    await act(async () => {
      started = result.current.start(FILES, SETTINGS);
      // Let the loop reach `await invoke("new_job_id")` and park there.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(h.calls).toContain("new_job_id");
    expect(h.calls).not.toContain("transcribe_local_file");

    // Stop, while the id is still in flight. jobRef is null, so cancel_job
    // has nothing to kill - this is the whole window.
    await act(async () => { result.current.cancel(); });
    expect(h.calls).not.toContain("cancel_job");

    // The id arrives. The file must NOT start.
    await act(async () => { h.gate!.release(); await started; });
    expect(h.calls).not.toContain("transcribe_local_file");
  });

  it("settles the batch instead of leaving a row running forever", async () => {
    // `finished` requires nothing running. A row abandoned in "running" would
    // leave the status strip saying "Transcribing a.mov" for the rest of the
    // session.
    h.gate = { release: () => {}, reached: Promise.resolve() };
    const { result } = renderHook(() => useBatchTranscribe());
    let started: Promise<void>;
    await act(async () => {
      started = result.current.start(FILES, SETTINGS);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => { result.current.cancel(); });
    await act(async () => { h.gate!.release(); await started; });

    const items = result.current.state.items;
    expect(items.every((i) => i.status !== "running")).toBe(true);
    // Nothing ran, so nothing failed: not started is "skipped", not "error".
    expect(items.map((i) => i.status)).toEqual(["skipped", "skipped"]);
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
