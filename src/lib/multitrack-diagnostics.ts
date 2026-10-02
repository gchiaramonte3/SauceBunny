import type { AafDiagnosticEvent } from "../bindings/AafDiagnosticEvent";
import type { AafDiagnostics } from "../bindings/AafDiagnostics";
import { EXPECTED_BACKEND_BUILD_ID } from "./build-id";

export function mergeMultitrackLogs(...batches: AafDiagnosticEvent[][]): AafDiagnosticEvent[] {
  const rows = new Map<string, AafDiagnosticEvent>();
  for (const batch of batches) for (const row of batch) rows.set(row.id, row);
  return [...rows.values()].sort((a, b) => a.timestamp_ms - b.timestamp_ms).slice(-1500);
}

export function multitrackDiagnosticsText(snapshot: AafDiagnostics, rows: AafDiagnosticEvent[], userAgent: string, now = new Date()): string {
  return [
    "Sauce Bunny · AAF Audio diagnostics", `Generated: ${now.toISOString()}`,
    `Frontend build: ${EXPECTED_BACKEND_BUILD_ID}`, `WebView: ${userAgent}`,
    "Includes media paths, AAF source/track metadata and recent operations. No transcript text or media samples.",
    "This report is saved locally and is not uploaded automatically.",
    ...(snapshot.persistence_error ? [`Log persistence warning: ${snapshot.persistence_error}`] : []),
    `Active jobs: ${snapshot.active_jobs.length}`, "", "CONTEXT", snapshot.context,
    "", "PIPELINE (bounded recent history; timestamps include date and timezone)",
    ...mergeMultitrackLogs(snapshot.events, rows).map(row => `${new Date(row.timestamp_ms).toISOString()} [${row.level}] ${row.stage} [${row.job_id || "UI"}] ${row.message}`), "",
  ].join("\n");
}
