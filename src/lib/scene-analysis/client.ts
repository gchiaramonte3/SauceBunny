import { invoke } from "@tauri-apps/api/core";
import { formatError } from "../error-format";
import type { WorkerInboundMessage, WorkerOutboundMessage } from "./contracts";
import { DEFAULT_DETECTOR_CONFIG } from "./detector-core";
import type { SceneAnalysisResult, SceneAnalysisProgress } from "./mediabunny-scene-analysis";

type ErrorCode = Extract<WorkerOutboundMessage, { type: "ERROR" }>["error"]["code"];
export class SceneJobError extends Error {
  constructor(readonly code: ErrorCode, message: string) { super(message); this.name = "SceneJobError"; }
}
export type SceneJob = { runId: string; result: Promise<SceneAnalysisResult>; cancel(): void };
export type SceneWorker = {
  postMessage(message: WorkerInboundMessage, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerOutboundMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  terminate(): void;
};
export type SceneReader = { size(path: string): Promise<number>; read(path: string, start: number, end: number): Promise<ArrayBuffer> };
const nativeReader: SceneReader = {
  size: path => invoke<number>("get_file_size", { path }),
  read: (path, start, end) => invoke<ArrayBuffer>("read_file_range", { path, offset: start, length: end - start }),
};

/** Synchronous cancellation ownership, lazy native reads, and one worker per run. */
export function startSceneAnalysis(path: string, onProgress?: (progress: SceneAnalysisProgress) => void,
  createWorker: () => SceneWorker = () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
  reader: SceneReader = nativeReader): SceneJob {
  const runId = crypto.randomUUID();
  const worker = createWorker();
  let cancelled = false, settled = false, started = false, probing = false, size = 0;
  let resolve!: (result: SceneAnalysisResult) => void;
  let reject!: (error: SceneJobError) => void;
  const result = new Promise<SceneAnalysisResult>((yes, no) => { resolve = yes; reject = no; });
  const aborted = () => new SceneJobError("ABORTED", "Scene analysis was cancelled.");
  const finish = (error?: SceneJobError, value?: SceneAnalysisResult) => {
    if (settled) return;
    settled = true; worker.onmessage = null; worker.onerror = null; worker.terminate();
    if (error) reject(error); else resolve(value!);
  };
  const send = (message: WorkerInboundMessage, transfer?: Transferable[]) => {
    try { worker.postMessage(message, transfer); }
    catch (cause) { finish(new SceneJobError("PIPELINE_ERROR", formatError(cause))); }
  };
  const prepare = async () => {
    try {
      size = await reader.size(path);
      if (settled || cancelled) return;
      if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Choose a nonempty local video.");
      started = true;
      send({ type: "START", runId, file: { native: true, name: path.split("/").at(-1)!, size },
        config: { sensitivity: DEFAULT_DETECTOR_CONFIG.sensitivity } });
    } catch (cause) { if (!settled) finish(new SceneJobError("PIPELINE_ERROR", formatError(cause))); }
  };
  const read = async (message: Extract<WorkerOutboundMessage, { type: "READ_RANGE" }>) => {
    try {
      if (!started || !Number.isSafeInteger(message.start) || !Number.isSafeInteger(message.end)
          || message.start < 0 || message.end <= message.start || message.end > size) throw new Error("Invalid scene-analysis byte range.");
      const bytes = await reader.read(path, message.start, message.end);
      if (settled || cancelled) return;
      if (bytes.byteLength !== message.end - message.start) throw new Error("The video changed or returned an incomplete byte range.");
      send({ type: "RANGE_RESULT", runId, requestId: message.requestId, bytes }, [bytes]);
    } catch (cause) {
      if (!settled && !cancelled) send({ type: "RANGE_ERROR", runId, requestId: message.requestId, message: formatError(cause) });
    }
  };
  const job: SceneJob = { runId, result, cancel: () => {
    if (settled || cancelled) return;
    cancelled = true;
    if (!started) finish(aborted());
    else send({ type: "CANCEL", runId });
  } };
  worker.onmessage = ({ data }) => {
    if (settled || data.runId !== runId) return;
    if (cancelled) {
      if (data.type === "RESULT" || data.type === "ERROR" || data.type === "CANCELLED") finish(aborted());
      return;
    }
    switch (data.type) {
      case "CAPABILITIES":
        if (!data.capabilities.fullFrame) finish(new SceneJobError("UNSUPPORTED_API", "Full-frame analysis is unavailable in this browser."));
        else if (!probing) { probing = true; void prepare(); }
        break;
      case "READ_RANGE": void read(data); break;
      case "PROGRESS": onProgress?.(data.progress); break;
      case "RESULT": finish(undefined, data.result); break;
      case "ERROR": finish(new SceneJobError(data.error.code, data.error.message)); break;
      case "CANCELLED": finish(aborted()); break;
    }
  };
  worker.onerror = event => finish(new SceneJobError("PIPELINE_ERROR", event.message || "The scene worker failed."));
  send({ type: "PROBE", runId });
  return job;
}
