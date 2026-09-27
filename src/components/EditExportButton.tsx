import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import type { EditExportResult } from "../bindings/EditExportResult";
import { exportEdit, exportName, type EditExportApproach } from "../lib/edit-export";
import { formatError } from "../lib/error-format";
import { newJobId } from "../lib/job-id";
import { IconDownload } from "./Icons";

type Props = { editId: string; title: string; disabled: boolean; onDone: (message: string) => void };

/**
 * Export the edit as an AAF for Media Composer. The job id is minted and held
 * before the save dialog so Stop always has something to cancel, and a
 * stopped export says so rather than reporting a failure.
 */
export function EditExportButton({ editId, title, disabled, onDone }: Props) {
  const [busy, setBusy] = useState(false);
  const [approach, setApproach] = useState<EditExportApproach>("C");
  const job = useRef<string | null>(null);
  // Opening another string out unmounts this one; its export stops with it
  // rather than finishing behind a screen that can no longer report it.
  useEffect(() => () => {
    const jobId = job.current;
    job.current = null;
    if (jobId) void invoke("cancel_job", { jobId }).catch(() => undefined);
  }, []);
  const run = async () => {
    const jobId = newJobId();
    job.current = jobId;
    const path = await save({ defaultPath: exportName(title), filters: [{ name: "AAF", extensions: ["aaf"] }] });
    if (!path || job.current !== jobId) return;
    setBusy(true);
    try {
      const result: EditExportResult = await exportEdit(editId, path, approach, jobId);
      const notes = result.warnings.length ? ` ${result.warnings.length} note${result.warnings.length === 1 ? "" : "s"}: ${result.warnings[0]}` : "";
      onDone(`Exported ${result.name}: ${result.segments} segments${result.markers_output ? ", markers beside it" : ""}.${notes}`);
    } catch (cause) {
      onDone(job.current === jobId ? `Export failed: ${formatError(cause)}` : "Export stopped.");
    } finally {
      if (job.current === jobId) job.current = null;
      setBusy(false);
    }
  };
  const stop = () => {
    const jobId = job.current;
    job.current = null;
    if (jobId) void invoke("cancel_job", { jobId }).catch(() => undefined);
  };
  return <div className="cp-te-export" role="group" aria-label="Export">
    <select className="cp-select cp-te-export-mode" aria-label="Group clips" title="How group clips are written" value={approach}
      disabled={busy} onChange={(event) => setApproach(event.target.value as EditExportApproach)}>
      <option value="C">Keep groups</option>
      <option value="B">Clip that plays</option>
    </select>
    {busy
      ? <button type="button" className="btn btn-ghost cp-te-btn" onClick={stop} title="Stop the export">Stop</button>
      : <button type="button" className="btn btn-ghost cp-te-btn" disabled={disabled} onClick={() => void run()} title="Export an AAF for Media Composer">
        <IconDownload size={13} />Export AAF</button>}
  </div>;
}
