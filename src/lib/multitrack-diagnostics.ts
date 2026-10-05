import type { AafDiagnosticEvent } from "../bindings/AafDiagnosticEvent";

export function mergeMultitrackLogs(...batches: AafDiagnosticEvent[][]): AafDiagnosticEvent[] {
  const rows = new Map<string, AafDiagnosticEvent>();
  for (const batch of batches) for (const row of batch) rows.set(row.id, row);
  return [...rows.values()].sort((a, b) => a.timestamp_ms - b.timestamp_ms).slice(-1500);
}
