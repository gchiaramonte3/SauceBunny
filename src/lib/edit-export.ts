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
 * What to answer when Media Composer asks about a group clip on import,
 * said after every export that keeps groups. A kept group travels in the AAF
 * under its own MobID, as it does in Avid's own exports, and Media Composer
 * asks "Group clip conflict found ... replace the original?" for every
 * composition whose MobID is already loaded, without comparing the two
 * (libameLibrary OMFImportResolver::ResolveConflictLogical; only a batch
 * import skips it). So every import of a string out after the first asks.
 * No keeps the group already in the project, and the sequence links to it
 * by MobID, which is the point. It is not a crash guard: on 2026-10-08
 * Media Composer 24.12.6 crashed during such an import after No, in the
 * bin's selected-items label, which looked a selected clip up by MobID,
 * found nothing, and read through the null.
 */
export function groupConflictNote(approach: EditExportApproach): string {
  return approach === "B" ? "" : " If Media Composer reports a group clip conflict on import, choose No To All.";
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
