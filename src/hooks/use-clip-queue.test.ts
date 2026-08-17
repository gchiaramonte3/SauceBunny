// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useClipQueue } from "./use-clip-queue";

/**
 * The clip queue runner, testable for the first time.
 *
 * It exports every queued item in sequence, and the interesting parts are all
 * about what it REFUSES to do: it will not start while a single export owns
 * the shared cancel token, it stops the whole run when an item reports
 * cancelled (returning that item to "queued" rather than marking it done or
 * failed), and it survives the queue being cleared underneath it mid-run.
 * None of that had a test — it lived in the middle of a 6,000-line component,
 * and the only way to reach it was to export real files.
 *
 * `runLocalClipExport` is injected, so these tests drive the branch decisions
 * without encoding anything.
 */

const h = vi.hoisted(() => ({
  results: [] as unknown[],
  calls: [] as Array<{ destPath: string }>,
}));

type Deps = Parameters<typeof useClipQueue>[0];

function item(id: string, over: Record<string, unknown> = {}) {
  return {
    id, filename: `clip-${id}`, title: `Clip ${id}`, status: "queued",
    fps: 25, inFrames: 0, outFrames: 50, format: "video",
    source: { kind: "file", path: `/in/${id}.mov` }, thumbnail: null,
    ...over,
  };
}

function deps(queue: unknown[], over: Partial<Deps> = {}): Deps {
  const clipQueueRef = { current: queue };
  return {
    metadata: null, metadataRef: { current: { title: "x" } },
    sourceKind: "file", localFilePath: "/in/a.mov",
    exportOpts: { folder: "/out", filename: "clip", format: "video", reencode: false, inTc: "", outTc: "" },
    fps: 25, inFrames: 0, outFrames: 50,
    queueRunning: false,
    clipQueueRef,
    queueResolverRef: { current: null },
    localExportCancelRef: { current: null },
    runLocalClipExport: async (args: { destPath: string }) => {
      h.calls.push({ destPath: args.destPath });
      return (h.results.shift() ?? { kind: "ok", bytesWritten: 10, finalPath: args.destPath }) as never;
    },
    appendLog: vi.fn(), pushNotification: vi.fn(),
    cookiesBrowserOrNone: () => undefined, pushMarksUndo: vi.fn(),
    setClipQueue: vi.fn((fn: (p: unknown[]) => unknown[]) => {
      // Keep the ref in step, the way React state would — the runner reads
      // clipQueueRef.current between items to notice a cleared queue.
      if (typeof fn === "function") clipQueueRef.current = fn(clipQueueRef.current);
    }),
    setQueueOpen: vi.fn(), setQueueRunning: vi.fn(), setStatus: vi.fn(),
    setProgress: vi.fn(), setJobId: vi.fn(), setRecents: vi.fn(),
    setInFrames: vi.fn(), setOutFrames: vi.fn(),
    ...over,
  } as unknown as Deps;
}

beforeEach(() => { h.results.length = 0; h.calls.length = 0; });
afterEach(() => vi.clearAllMocks());

describe("the queue runner refuses to start", () => {
  it("when a single export already owns the cancel token", async () => {
    // The whole reason the export button and the queue share one token owner.
    // Starting here would clobber it and strand the Stop button for both.
    const d = deps([item("a")], { localExportCancelRef: { current: { cancelled: false } } });
    const { result } = renderHook(() => useClipQueue(d));
    await result.current.handleExportQueue();
    expect(h.calls, "the queue started while a single export was running").toHaveLength(0);
    expect(d.pushNotification).toHaveBeenCalledWith(
      "info", "Export in progress", expect.stringContaining("Wait"));
  });

  it("with no output folder", async () => {
    const d = deps([item("a")], { exportOpts: { folder: null, filename: "c", format: "video", reencode: false, inTc: "", outTc: "" } as never });
    const { result } = renderHook(() => useClipQueue(d));
    await result.current.handleExportQueue();
    expect(h.calls).toHaveLength(0);
    expect(d.setQueueRunning).not.toHaveBeenCalled();
  });

  it("when it is already running", async () => {
    const d = deps([item("a")], { queueRunning: true });
    const { result } = renderHook(() => useClipQueue(d));
    await result.current.handleExportQueue();
    expect(h.calls).toHaveLength(0);
  });

  it("when nothing is queued", async () => {
    // Items already done must not be re-exported.
    const d = deps([item("a", { status: "done" })]);
    const { result } = renderHook(() => useClipQueue(d));
    await result.current.handleExportQueue();
    expect(h.calls).toHaveLength(0);
    expect(d.setQueueRunning, "flipped the running flag for an empty run").not.toHaveBeenCalled();
  });
});

describe("a run that proceeds", () => {
  it("exports every queued item in order", async () => {
    // The canary: without this the refusals above could all pass on a runner
    // that never exports anything.
    const d = deps([item("a"), item("b"), item("c")]);
    const { result } = renderHook(() => useClipQueue(d));
    await result.current.handleExportQueue();
    expect(h.calls.map((c) => c.destPath)).toEqual([
      "/out/clip-a.mp4", "/out/clip-b.mp4", "/out/clip-c.mp4",
    ]);
    expect(d.setQueueRunning).toHaveBeenCalledWith(true);
    expect(d.setQueueRunning).toHaveBeenLastCalledWith(false);
  });

  it("reports a clean run as complete", async () => {
    const d = deps([item("a"), item("b")]);
    const { result } = renderHook(() => useClipQueue(d));
    await result.current.handleExportQueue();
    expect(d.pushNotification).toHaveBeenCalledWith(
      "success", "Queue complete", expect.stringContaining("2 clips"));
  });

  it("counts failures separately and still finishes the rest", async () => {
    // "unsupported" and "error" both land in the failure branch — there is no
    // ffmpeg fallback for local clips — and neither stops the run.
    h.results = [
      { kind: "unsupported", reason: "10-bit ProRes" },
      { kind: "ok", bytesWritten: 5, finalPath: "/out/clip-b.mp4" },
    ];
    const d = deps([item("a"), item("b")]);
    const { result } = renderHook(() => useClipQueue(d));
    await result.current.handleExportQueue();
    expect(h.calls, "a failed item stopped the run").toHaveLength(2);
    expect(d.pushNotification).toHaveBeenCalledWith(
      "error", "Queue finished with errors", expect.stringContaining("1 ok"));
  });

  it("STOPS on a cancelled item and leaves it queued", async () => {
    // Cancel is not a failure: the item goes back to "queued" so Stop then
    // Export resumes rather than skipping it, and the remaining items are
    // never touched.
    h.results = [{ kind: "cancelled" }];
    const d = deps([item("a"), item("b"), item("c")]);
    const { result } = renderHook(() => useClipQueue(d));
    await result.current.handleExportQueue();
    expect(h.calls, "the run continued past a cancel").toHaveLength(1);
    expect(d.pushNotification).toHaveBeenCalledWith(
      "info", "Queue stopped", expect.stringContaining("rest still queued"));
    const left = (d.clipQueueRef.current as Array<{ id: string; status: string }>);
    expect(left.find((c) => c.id === "a")?.status, "a cancelled item did not return to queued").toBe("queued");
  });

  it("skips an item the user removed mid-run", async () => {
    // The queue can be cleared while the runner is between items; it re-reads
    // the ref each time rather than trusting the list it started with.
    // The clearing has to be wired BEFORE renderHook: the hook destructures
    // its props once, so replacing a dependency afterwards changes nothing —
    // the original closure keeps running. That mistake made this test report
    // the runner as broken when it was fine.
    const d = deps([item("a"), item("b")]);
    const ref = d.clipQueueRef as { current: unknown[] };
    (d as { runLocalClipExport: unknown }).runLocalClipExport = async (args: { destPath: string }) => {
      h.calls.push({ destPath: args.destPath });
      ref.current = [];   // the user clears the queue after the first item
      return { kind: "ok", bytesWritten: 10, finalPath: args.destPath } as never;
    };
    const { result } = renderHook(() => useClipQueue(d));
    await result.current.handleExportQueue();
    expect(h.calls, "the runner exported an item that had been removed").toHaveLength(1);
  });
});
