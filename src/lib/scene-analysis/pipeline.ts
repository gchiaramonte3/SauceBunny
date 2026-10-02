import { emitTo } from "@tauri-apps/api/event";
import { PICTURE_MODELS, type PictureModelId } from "../picture-model";
import type { VideoProgress } from "../../bindings/VideoProgress";

export const ANALYSIS_PIPELINE_EVENT = "video-analysis-pipeline";
export type AnalysisPipelineEvent = {
  runId: string; sequence: number; status: "active" | "stopping" | "finished";
  tag: "info" | "ok" | "warn" | "err"; message: string;
};
export function isAnalysisPipelineEvent(value: unknown): value is AnalysisPipelineEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<AnalysisPipelineEvent>;
  return typeof event.runId === "string" && event.runId.length > 0 && event.runId.length <= 128
    && Number.isSafeInteger(event.sequence) && event.sequence! > 0
    && ["active", "stopping", "finished"].includes(event.status ?? "")
    && ["info", "ok", "warn", "err"].includes(event.tag ?? "")
    && typeof event.message === "string" && event.message.length > 0 && event.message.length <= 2048;
}

/** One trace per user run, including when the analysis lives in the detached panel.
 * Messages describe observable work, never model reasoning or inferred dialogue. */
export function createAnalysisPipeline(path: string, modelId: PictureModelId) {
  // Trace identity is not a native cancellable job ID.
  const runId = crypto.randomUUID(), started = performance.now();
  const source = (path.split("/").at(-1) || "Video").slice(0, 180);
  const model = PICTURE_MODELS.find(item => item.id === modelId)!.name;
  let sequence = 0, closed = false, stopping = false;
  let delivery = Promise.resolve();
  const progressSeen = new Map<string, number>();
  const send = (tag: AnalysisPipelineEvent["tag"], message: string, status: AnalysisPipelineEvent["status"]) => {
    const event: AnalysisPipelineEvent = { runId, sequence: ++sequence, status, tag,
      message: `${source} · ${message}`.slice(0, 2048) };
    // Preserve ordering across native IPC. Diagnostics must not fail the media
    // job if the main window is closing; no media or prompts cross this event.
    delivery = delivery.then(() => emitTo("main", ANALYSIS_PIPELINE_EVENT, event)).catch(() => {});
  };
  const note = (message: string, tag: AnalysisPipelineEvent["tag"] = "info") => {
    if (!closed && !stopping) send(tag, message, "active");
  };
  const percent = (key: string, label: string, completed: number, total: number) => {
    if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0 || completed < 0 || completed > total) return;
    const value = Math.floor(completed / total * 100);
    const previous = progressSeen.get(key) ?? -1;
    if (value <= previous || (previous >= 0 && value < 100 && value - previous < 5)) return;
    progressSeen.set(key, value);
    note(`${label} · ${value}%`);
  };
  note(`Starting analysis on this Mac · ${model}.`);
  return {
    note,
    detector: (fraction: number) => percent("detector", "Detecting shots", fraction, 1),
    native(progress: VideoProgress, batchStart = 0, shotTotal = 0, audio = false) {
      if (closed || stopping) return;
      const { phase, completed, total } = progress;
      if (phase === "shot-complete") {
        if (!Number.isSafeInteger(completed) || !Number.isSafeInteger(total) || completed < 1 || completed > total
          || batchStart + completed > shotTotal) return;
        const count = batchStart + completed;
        if (count <= (progressSeen.get("shots") ?? 0)) return;
        progressSeen.set("shots", count);
        note(`Shot ${count} of ${shotTotal} ready.`, "ok");
      } else if (phase === "loading-model") {
        const key = `loading:${audio}:${batchStart}`;
        if (!progressSeen.has(key)) { progressSeen.set(key, 1); note(`Loading ${audio ? "AST sound classifier" : model} into memory…`); }
      } else {
        const labels: Record<string, string> = { "preparing-shot-proxy": "Preparing H.264 analysis copy",
          "verifying-shot-proxy": "Verifying analysis-copy frame timing", "analyzing-audio": "Analyzing source audio" };
        if (labels[phase]) percent(phase, labels[phase], completed, total);
      }
    },
    stopping(reason: string) {
      if (closed || stopping) return;
      stopping = true;
      send("warn", `Stopping analysis: ${reason}`, "stopping");
    },
    finish(message: string, tag: AnalysisPipelineEvent["tag"]) {
      if (closed) return;
      closed = true;
      send(tag, `${message} · ${((performance.now() - started) / 1000).toFixed(1)}s elapsed.`, "finished");
    },
  };
}
