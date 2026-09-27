import { invoke } from "@tauri-apps/api/core";
import type { EditExportResult } from "../bindings/EditExportResult";

/**
 * How a group clip is written. "C" keeps the whole group with the chosen angle,
 * so the editor can still switch angles in Media Composer; "B" writes only the
 * clip that plays. The plan's Phase 0 Mac test decides the default.
 */
export type EditExportApproach = "B" | "C";

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
