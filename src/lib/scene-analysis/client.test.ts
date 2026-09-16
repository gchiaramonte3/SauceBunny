import { describe, expect, it, vi } from "vitest";
import { startSceneAnalysis, type SceneReader, type SceneWorker } from "./client";
import type { WorkerInboundMessage, WorkerOutboundMessage } from "./contracts";
import type { SceneAnalysisResult } from "./mediabunny-scene-analysis";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  return { promise: new Promise<T>((yes, no) => { resolve = yes; reject = no; }), resolve, reject };
}
class FakeWorker implements SceneWorker {
  onmessage: SceneWorker["onmessage"] = null;
  onerror: SceneWorker["onerror"] = null;
  postMessage = vi.fn<(message: WorkerInboundMessage, transfer?: Transferable[]) => void>();
  terminate = vi.fn();
  receive(message: WorkerOutboundMessage) { this.onmessage?.({ data: message } as MessageEvent<WorkerOutboundMessage>); }
}
const evidence = { source: { frameCount: 705 }, boundaries: [] } as unknown as SceneAnalysisResult;
function setup(reader?: SceneReader) {
  const worker = new FakeWorker();
  const io = reader ?? { size: vi.fn(async () => 1000), read: vi.fn(async (_path: string, start: number, end: number) => new ArrayBuffer(end - start)) };
  const progress = vi.fn();
  const job = startSceneAnalysis("/media/clip.mp4", progress, () => worker, io);
  const result = job.result.catch(error => error as Error & { code: string });
  const probe = (supported = true) => worker.receive({ type: "CAPABILITIES", runId: job.runId,
    capabilities: { worker: true, mediaBunny: true, mediaBunnyVersion: "1.52.3", videoDecoder: supported, offscreenCanvas: true, fullFrame: supported } });
  return { worker, io, progress, job, result, probe };
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("full-frame worker native bridge", () => {
  it("probes first, queues sensitivity 95 and transfers only requested compressed bytes", async () => {
    const h = setup();
    expect(h.worker.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "PROBE", runId: h.job.runId }, undefined);
    expect(h.io.size).not.toHaveBeenCalled();
    h.probe(); h.probe(); await tick();
    expect(h.io.size).toHaveBeenCalledTimes(1);
    expect(h.worker.postMessage.mock.calls[1][0]).toEqual({ type: "START", runId: h.job.runId,
      file: { native: true, name: "clip.mp4", size: 1000 }, config: { sensitivity: 95 } });
    h.worker.receive({ type: "READ_RANGE", runId: h.job.runId, requestId: 3, start: 100, end: 110 }); await tick();
    expect(h.io.read).toHaveBeenCalledWith("/media/clip.mp4", 100, 110);
    const [reply, transfer] = h.worker.postMessage.mock.calls[2];
    expect(reply.type).toBe("RANGE_RESULT");
    expect(transfer?.[0]).toBe((reply as Extract<WorkerInboundMessage, { type: "RANGE_RESULT" }>).bytes);
    h.worker.receive({ type: "RESULT", runId: h.job.runId, result: evidence });
    expect(await h.result).toBe(evidence); expect(h.worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported capability before touching the local file", async () => {
    const h = setup(); h.probe(false);
    expect(await h.result).toMatchObject({ code: "UNSUPPORTED_API" });
    expect(h.io.size).not.toHaveBeenCalled(); expect(h.worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("Stop during pending size inspection cannot start a late decoder", async () => {
    const size = deferred<number>();
    const h = setup({ size: () => size.promise, read: vi.fn() }); h.probe(); h.job.cancel();
    expect(await h.result).toMatchObject({ code: "ABORTED" }); size.resolve(1000); await tick();
    expect(h.worker.postMessage).toHaveBeenCalledTimes(1);
  });

  it("ignores all stale run traffic including file reads and completion", async () => {
    const h = setup(); h.probe(); await tick();
    h.worker.receive({ type: "READ_RANGE", runId: "old", requestId: 1, start: 0, end: 10 });
    h.worker.receive({ type: "RESULT", runId: "old", result: evidence });
    h.worker.receive({ type: "PROGRESS", runId: "old", progress: { phase: "decode", progress: 0.5, label: "old" } });
    expect(h.io.read).not.toHaveBeenCalled(); expect(h.progress).not.toHaveBeenCalled();
    expect(h.worker.terminate).not.toHaveBeenCalled();
    h.job.cancel(); h.worker.receive({ type: "CANCELLED", runId: h.job.runId });
    expect(await h.result).toMatchObject({ code: "ABORTED" });
  });

  it("waits for decoder cleanup on Stop and rejects a racing RESULT", async () => {
    const h = setup(); h.probe(); await tick(); h.job.cancel(); h.job.cancel();
    expect(h.worker.terminate).not.toHaveBeenCalled();
    expect(h.worker.postMessage.mock.calls.filter(([message]) => message.type === "CANCEL")).toHaveLength(1);
    h.worker.receive({ type: "RESULT", runId: h.job.runId, result: evidence });
    expect(await h.result).toMatchObject({ code: "ABORTED" });
    expect(h.worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("discards delayed reads after Stop without waking the cancelled decoder", async () => {
    const bytes = deferred<ArrayBuffer>(); const h = setup({ size: async () => 1000, read: () => bytes.promise });
    h.probe(); await tick(); h.worker.receive({ type: "READ_RANGE", runId: h.job.runId, requestId: 1, start: 0, end: 10 });
    h.job.cancel(); bytes.resolve(new ArrayBuffer(10)); await tick();
    expect(h.worker.postMessage.mock.calls.some(([m]) => m.type === "RANGE_RESULT")).toBe(false);
    h.worker.receive({ type: "CANCELLED", runId: h.job.runId }); expect(await h.result).toMatchObject({ code: "ABORTED" });
  });

  it("reports native failure, truncated reads and invalid bounds to the worker", async () => {
    for (const mode of ["failure", "short", "bounds"] as const) {
      const io = { size: async () => 1000, read: vi.fn(async () => { if (mode === "failure") throw new Error("Read denied"); return new ArrayBuffer(2); }) };
      const h = setup(io); h.probe(); await tick();
      h.worker.receive({ type: "READ_RANGE", runId: h.job.runId, requestId: 1, start: mode === "bounds" ? -1 : 0, end: 10 }); await tick();
      expect(h.worker.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({ type: "RANGE_ERROR", requestId: 1 });
      if (mode === "bounds") expect(io.read).not.toHaveBeenCalled();
      h.worker.receive({ type: "ERROR", runId: h.job.runId, error: { code: "PIPELINE_ERROR", message: "Read failed" } });
      expect(await h.result).toMatchObject({ code: "PIPELINE_ERROR" });
    }
  });

  it("preserves typed codec errors and releases the worker", async () => {
    const h = setup(); h.probe(); await tick();
    h.worker.receive({ type: "ERROR", runId: h.job.runId, error: { code: "UNSUPPORTED_CODEC", message: "Codec unavailable" } });
    expect(await h.result).toMatchObject({ code: "UNSUPPORTED_CODEC", message: "Codec unavailable" });
    expect(h.worker.onmessage).toBeNull(); expect(h.worker.terminate).toHaveBeenCalledTimes(1);
  });
});
