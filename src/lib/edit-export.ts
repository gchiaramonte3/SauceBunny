import { invoke } from "@tauri-apps/api/core";
import type { EditExportResult } from "../bindings/EditExportResult";

/**
 * How a group clip is written. "V" (the default) keeps picture groups whole,
 * so camera angles still switch in Media Composer, while each person's audio
 * is their own mic, the clip that plays. "C" keeps every group, audio too;
 * "B" writes only the clip that plays everywhere.
 */
export type EditExportApproach = "V" | "C" | "B";

/**
 * Write the edit's saved head as a new AAF (aaf-sidecar/writer.py). The
 * sidecar re-reads its output and compares every frame before it publishes,
 * and refuses to replace a file that exists. The caller mints and keeps the
 * job id so Stop can reach the subprocess.
 */
export function exportEdit(editId: string, outputPath: string, approach: EditExportApproach, jobId: string): Promise<EditExportResult> {
  return invoke<EditExportResult>("aaf_export_edit", { editId, outputPath, approach, jobId });
}

/** A file name Media Composer and Finder both accept, from the edit's title. */
export function exportName(title: string): string {
  const safe = title.normalize("NFC").replace(/[/:\\]+/g, "-").replace(/\s+/g, " ").trim();
  return `${safe || "Edit"}.aaf`;
}
