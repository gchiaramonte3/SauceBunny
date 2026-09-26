import { CustomSource } from "mediabunny";
import type { WorkerInboundMessage, WorkerOutboundMessage } from "./contracts";
import { DEFAULT_SCENE_ANALYSIS_CONFIG, SceneAnalysisError } from "./mediabunny-scene-analysis";

type Pending = { resolve(bytes: Uint8Array): void; reject(error: Error): void; length: number };

/** Only compressed bytes cross this bridge. Input, decoding and pixels stay in the worker. */
export function sceneRangeSource(size: number, runId: string, signal: AbortSignal,
  send: (message: WorkerOutboundMessage) => void) {
  const pending = new Map<number, Pending>();
  let nextId = 0;
  const abort = () => {
    for (const request of pending.values()) request.reject(new SceneAnalysisError("ABORTED", "Scene analysis was cancelled."));
    pending.clear();
  };
  signal.addEventListener("abort", abort, { once: true });
  const source = new CustomSource({
    getSize: () => size,
    read: (start, end) => new Promise<Uint8Array>((resolve, reject) => {
      if (signal.aborted) { reject(new SceneAnalysisError("ABORTED", "Scene analysis was cancelled.")); return; }
      const requestId = ++nextId;
      pending.set(requestId, { resolve, reject, length: end - start });
      try { send({ type: "READ_RANGE", runId, requestId, start, end }); }
      catch (cause) { pending.delete(requestId); reject(cause); }
    }),
    prefetchProfile: "fileSystem",
    maxCacheSize: DEFAULT_SCENE_ANALYSIS_CONFIG.blobCacheBytes,
  });
  return {
    source,
    receive(message: WorkerInboundMessage) {
      if (message.runId !== runId || (message.type !== "RANGE_RESULT" && message.type !== "RANGE_ERROR")) return;
      const request = pending.get(message.requestId);
      if (!request) return;
      pending.delete(message.requestId);
      if (message.type === "RANGE_ERROR") request.reject(new SceneAnalysisError("PIPELINE_ERROR", message.message));
      else if (!(message.bytes instanceof ArrayBuffer) || message.bytes.byteLength !== request.length) {
        request.reject(new SceneAnalysisError("PIPELINE_ERROR", "The video changed or returned an incomplete byte range."));
      } else request.resolve(new Uint8Array(message.bytes));
    },
    dispose() { signal.removeEventListener("abort", abort); abort(); },
  };
}
