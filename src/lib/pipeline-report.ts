import type { AafDiagnosticEvent } from "../bindings/AafDiagnosticEvent";
import type { AafDiagnostics } from "../bindings/AafDiagnostics";
import type { PipelineHealth } from "../bindings/PipelineHealth";
import { EXPECTED_BACKEND_BUILD_ID } from "./build-id";
import { mergeMultitrackLogs } from "./multitrack-diagnostics";
import { msText, type CallStat, type InFlight, type PipelineContext } from "./pipeline";

export type PipelineReportInput = {
  page: string;
  /** The backend's journal and context, one per AAF Audio document the page reads (or one with no document). */
  snapshots: AafDiagnostics[];
  /** Rows the panel holds, merged with the journal's so nothing is lost or doubled. */
  rows: AafDiagnosticEvent[];
  health: PipelineHealth | null;
  healthError?: string | null;
  context: PipelineContext | null;
  inflight: InFlight[];
  stats: CallStat[];
  userAgent: string;
  now?: Date;
};

const megabytes = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;

function healthLines(health: PipelineHealth | null, error: string | null | undefined): string[] {
  if (!health) return [`Unavailable${error ? `: ${error}` : "."}`];
  return [
    `Memory: ${health.resident_bytes === null ? "not reported" : `${megabytes(health.resident_bytes)} resident`}`,
    `Running for: ${msText(health.uptime_seconds * 1_000)}`,
    `Main thread: ${health.main_thread_wait_ms >= 2_000 ? `NOT ANSWERING for ${msText(health.main_thread_wait_ms)}` : "answering"}`,
    `Processes running: ${health.running_jobs.length ? health.running_jobs.join(", ") : "none"}`,
    "Volumes:", ...(health.volumes.length ? health.volumes.map((volume) => `  ${volume}`) : ["  none besides the startup disk"]),
    // Activity Monitor shows a session's UDP sockets and relay connection; this says whether one was open.
    `Co-review session: ${health.co_review === "off" ? "none open (no network listeners of ours)" : health.co_review === "hosting" ? "hosting (its UDP sockets and relay connection are open)" : health.co_review === "joined" ? "joined (its UDP sockets and relay connection are open)" : health.co_review}`,
  ];
}

function statLines(stats: CallStat[]): string[] {
  if (!stats.length) return ["None yet."];
  return ["command · calls · failed · average · longest · last error",
    ...stats.map((stat) => `${stat.command} · ${stat.calls} · ${stat.failed} · ${msText(stat.totalMs / stat.calls)} · ${msText(stat.maxMs)}${stat.lastError ? ` · ${stat.lastError}` : ""}`)];
}

/**
 * The text a person sends when something hangs: the app's health, what the
 * page was doing and waiting on, how every kind of call has performed since
 * launch, the newest hang sample, and the Pipeline's recent history. Built
 * the same way from AAF Audio and String Outs.
 */
export function pipelineReport(input: PipelineReportInput): string {
  const { page, snapshots, rows, health, context, inflight, stats, userAgent, now = new Date() } = input;
  const warnings = [...new Set(snapshots.map((snapshot) => snapshot.persistence_error).filter((error): error is string => !!error))];
  const active = new Set(snapshots.flatMap((snapshot) => snapshot.active_jobs));
  return [
    `Sauce Bunny · Pipeline diagnostics · ${page}`, `Generated: ${now.toISOString()}`,
    `Frontend build: ${EXPECTED_BACKEND_BUILD_ID}`, `WebView: ${userAgent}`,
    "Includes media paths, AAF source and track metadata, recent operations and their timings. No transcript text, prompts, names or media samples.",
    "This report is saved locally and is not uploaded automatically.",
    ...warnings.map((warning) => `Log persistence warning: ${warning}`),
    `Active jobs: ${active.size}`,
    "", "HEALTH", ...healthLines(health, input.healthError),
    "", `PAGE · ${page}`, context?.text ?? "Nothing open.",
    "", "IN FLIGHT NOW (calls the page is waiting on, oldest first)",
    ...(inflight.length ? inflight.map((call) => `${msText(call.ms)} · ${call.stage} · ${call.label}${call.warned ? " · waiting" : ""}`) : ["Nothing."]),
    "", "CALLS SINCE LAUNCH (the page's own calls into the app)", ...statLines(stats),
    ...(health?.latest_hang ? ["", "LATEST HANG SAMPLE (the main thread's stack while it was not answering)", health.latest_hang] : []),
    ...snapshots.flatMap((snapshot, index) => ["", snapshots.length > 1 ? `CONTEXT ${index + 1} of ${snapshots.length}` : "CONTEXT", snapshot.context]),
    "", "PIPELINE (bounded recent history; timestamps include date and timezone)",
    ...mergeMultitrackLogs(...snapshots.map((snapshot) => snapshot.events), rows)
      .map((row) => `${new Date(row.timestamp_ms).toISOString()} [${row.level}] ${row.stage} [${row.job_id || "UI"}] ${row.message}`),
    "",
  ].join("\n");
}
