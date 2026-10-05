import { pipelineInvoke } from "../lib/pipeline";
import { open } from "@tauri-apps/plugin-dialog";
import { useRef, useState } from "react";
import { exportEdits } from "../lib/edit-export";
import { formatError } from "../lib/error-format";
import { newJobId } from "../lib/job-id";
import { IconDownload } from "./Icons";
const invoke = pipelineInvoke("String Outs");

type Props = { editIds: string[]; titleOf: (id: string) => string };

/**
 * Export every open string out into one folder, one AAF each, from a single
 * run of the writer: it opens each sequence and builds its group pack once,
 * which is what makes "One per person" quick to send to Avid. Picture groups
 * are kept, the export default; a string out that needs another choice is
 * exported from its own tab.
 */
export function EditExportAll({ editIds, titleOf }: Props) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const job = useRef<string | null>(null), stopped = useRef(false);
  const run = async () => {
    const jobId = newJobId();
    job.current = jobId; stopped.current = false;
    const folder = await open({ directory: true, title: "Choose a folder for the AAFs" });
    if (typeof folder !== "string" || job.current !== jobId) { if (job.current === jobId) job.current = null; return; }
    setBusy(true); setMessage(`Exporting ${editIds.length} string outs…`);
    try {
      const outcomes = await exportEdits(editIds, folder, "V", jobId);
      const failed = outcomes.filter((outcome) => outcome.error);
      setMessage(`Exported ${outcomes.length - failed.length} of ${outcomes.length} string outs.${failed.length ? ` ${titleOf(failed[0].edit_id)}: ${failed[0].error}` : ""}`);
    } catch (cause) {
      setMessage(stopped.current ? "Export stopped." : `Export failed: ${formatError(cause)}`);
    } finally { setBusy(false); job.current = null; }
  };
  const stop = () => { stopped.current = true; if (job.current) void invoke("cancel_job", { jobId: job.current }).catch(() => undefined); };
  return <>
    {message && <span className="cp-te-pane-note" role="status">{message}</span>}
    {busy ? <button type="button" className="btn btn-ghost" onClick={stop} title="Stop the export">Stop</button>
      : <button type="button" className="btn btn-ghost" onClick={() => void run()} title="Export every open string out as an AAF, keeping picture groups, into one folder">
        <IconDownload size={14} />Export all ({editIds.length})…</button>}
  </>;
}
