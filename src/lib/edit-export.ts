import { pipelineInvoke } from "./pipeline";
import type { EditExportOutcome } from "../bindings/EditExportOutcome";
import type { EditExportResult } from "../bindings/EditExportResult";
const invoke = pipelineInvoke("String Outs");

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

/**
 * Write several edits' saved heads, one AAF each, into `outputDir` from one
 * run of the sidecar, which opens each source AAF and builds its group pack
 * once. Files are named by `exportName` from each title, with " 2", " 3" and
 * on rather than replacing a file. The outcomes come back in `editIds` order,
 * each holding a result or the reason that edit was not written; one failure
 * does not stop the others. Rejects only for the batch as a whole (Stop, or a
 * folder that does not exist). The caller mints and keeps the job id.
 */
export function exportEdits(editIds: string[], outputDir: string, approach: EditExportApproach, jobId: string): Promise<EditExportOutcome[]> {
  return invoke<EditExportOutcome[]>("aaf_export_edits", { editIds, outputDir, approach, jobId });
}

/**
 * A file name Media Composer and Finder both accept, from the edit's title.
 * `export_stem` in src-tauri/src/edit_export.rs names batch exports the same
 * way; a change here belongs there too.
 */
export function exportName(title: string): string {
  const safe = title.normalize("NFC").replace(/[/:\\]+/g, "-").replace(/\s+/g, " ").trim();
  return `${safe || "Edit"}.aaf`;
}
