import { analyzeSceneBoundaries, SceneAnalysisError } from "./mediabunny-scene-analysis";
import type { WorkerCapabilities, WorkerInboundMessage, WorkerOutboundMessage } from "./contracts";
import { sceneRangeSource } from "./range-source";

type WorkerScope = { postMessage(message: WorkerOutboundMessage): void; onmessage: ((event: MessageEvent<WorkerInboundMessage>) => void) | null };
const scope = self as unknown as WorkerScope;
type Run = { id: string; controller: AbortController; range?: ReturnType<typeof sceneRangeSource> };
let active: Run | null = null;

function capabilities(): WorkerCapabilities {
  const videoDecoder = typeof VideoDecoder !== "undefined";
  const offscreenCanvas = typeof OffscreenCanvas !== "undefined";
  return { worker: true, mediaBunny: true, mediaBunnyVersion: "1.52.3", videoDecoder, offscreenCanvas, fullFrame: videoDecoder && offscreenCanvas };
}

async function analyze(message: Extract<WorkerInboundMessage, { type: "START" }>, run: Run) {
  let terminal: WorkerOutboundMessage;
  try {
    const file = message.file;
    if (!(file instanceof Blob) && (!file || file.native !== true || typeof file.name !== "string"
        || !Number.isSafeInteger(file.size) || file.size <= 0)) {
      throw new SceneAnalysisError("PIPELINE_ERROR", "Choose a nonempty local analysis video.");
    }
    if (!(file instanceof Blob)) run.range = sceneRangeSource(file.size, run.id, run.controller.signal, message => scope.postMessage(message));
    const result = await analyzeSceneBoundaries({
      file: file instanceof Blob ? file : { name: file.name, source: run.range!.source },
      config: message.config,
      signal: run.controller.signal,
      onProgress: progress => scope.postMessage({ type: "PROGRESS", runId: run.id, progress }),
    });
    terminal = run.controller.signal.aborted ? { type: "CANCELLED", runId: run.id } : { type: "RESULT", runId: run.id, result };
  } catch (cause) {
    terminal = run.controller.signal.aborted || (cause instanceof SceneAnalysisError && cause.code === "ABORTED")
      ? { type: "CANCELLED", runId: run.id }
      : { type: "ERROR", runId: run.id, error: { code: cause instanceof SceneAnalysisError ? cause.code : "UNKNOWN_ERROR",
        message: cause instanceof Error ? cause.message : String(cause) } };
  } finally {
    run.range?.dispose();
    if (active === run) active = null;
  }
  // Terminal acknowledgement means the decoder and outstanding range reads are disposed.
  scope.postMessage(terminal);
}

scope.onmessage = ({ data: message }) => {
  if (!message || typeof message.type !== "string" || typeof message.runId !== "string") {
    scope.postMessage({ type: "ERROR", runId: "unknown", error: { code: "INVALID_MESSAGE", message: "Worker message is missing type or runId." } });
    return;
  }
  const runId = message.runId;
  if (message.type === "PROBE") {
    scope.postMessage({ type: "CAPABILITIES", runId: message.runId, capabilities: capabilities() });
  } else if (message.type === "CANCEL") {
    if (active?.id === message.runId) active.controller.abort();
  } else if (message.type === "RANGE_RESULT" || message.type === "RANGE_ERROR") {
    active?.range?.receive(message);
  } else if (message.type === "START") {
    if (active) {
      scope.postMessage({ type: "ERROR", runId: message.runId, error: { code: "BUSY", message: "The scene-analysis worker is already running." } });
      return;
    }
    active = { id: message.runId, controller: new AbortController() };
    void analyze(message, active);
  } else {
    scope.postMessage({ type: "ERROR", runId, error: { code: "INVALID_MESSAGE", message: "Unknown scene-analysis message." } });
  }
};
