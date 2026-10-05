import { pipelineInvoke } from "../lib/pipeline";
import { save } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { EditExportResult } from "../bindings/EditExportResult";
import { exportEdit, exportName, type EditExportApproach } from "../lib/edit-export";
import { formatError } from "../lib/error-format";
import { newJobId } from "../lib/job-id";
import { IconDownload } from "./Icons";
const invoke = pipelineInvoke("String Outs");

type Props = { editId: string; title: string; disabled: boolean; onDone: (message: string) => void };

/**
 * Export the edit as an AAF for Media Composer. The job id is minted and held
 * before the save dialog so Stop always has something to cancel, a stopped
 * export says so rather than reporting a failure, and switching to another
 * string out leaves it running (see `running`).
 *
 * "Keep picture groups" is the default: V1 stays a multigroup you can switch
 * in Media Composer, and each person's audio is their own mic (the clip that
 * plays), which is what a string out of people's lines needs. Every kind
 * references the original master clips and MXF media by MobID, which is how
 * Media Composer relinks. A camera angle that cannot be cut (HEAT 2 has a
 * slow-motion one) is left out of that bite's group with a note rather than
 * failing the export. "Keep all groups" writes the audio groups too, twenty
 * lavs deep; "Clip that plays" flattens everything to what plays.
 */
type Running = { jobId: string; stopped: boolean; result: string | null; hear: ((message: string) => void) | null };
/**
 * An export outlives the editor that started it. Switching tabs unmounts the
 * editor, and an AAF halfway written should still land, so each string out's
 * export waits here with its result until that string out is open to say it.
 */
const running = new Map<string, Running>();

function finish(editId: string, message: string) {
  const entry = running.get(editId);
  if (!entry) return;
  if (entry.hear) { running.delete(editId); entry.hear(message); } else entry.result = message;
}

/** This editor hears the export: it shows Stop until the result arrives. */
function attach(entry: Running, heard: MutableRefObject<Running | null>, job: MutableRefObject<string | null>, setBusy: (busy: boolean) => void, report: MutableRefObject<(message: string) => void>) {
  heard.current = entry;
  job.current = entry.jobId;
  setBusy(true);
  entry.hear = (message) => { heard.current = null; job.current = null; setBusy(false); report.current(message); };
}

export function EditExportButton({ editId, title, disabled, onDone }: Props) {
  const [busy, setBusy] = useState(false);
  const [approach, setApproach] = useState<EditExportApproach>("V");
  const job = useRef<string | null>(null);
  const heard = useRef<Running | null>(null);
  const report = useRef(onDone); report.current = onDone;
  // An export this string out started before a tab switch: show its Stop,
  // or the result it reached while another tab was open.
  useEffect(() => {
    const entry = running.get(editId);
    if (entry?.result != null) { running.delete(editId); report.current(entry.result); }
    else if (entry) attach(entry, heard, job, setBusy, report);
    return () => { if (heard.current) heard.current.hear = null; heard.current = null; };
  }, [editId]);
  const run = async () => {
    const jobId = newJobId();
    job.current = jobId;
    const path = await save({ defaultPath: exportName(title), filters: [{ name: "AAF", extensions: ["aaf"] }] });
    if (!path || job.current !== jobId) { if (job.current === jobId) job.current = null; return; }
    const entry: Running = { jobId, stopped: false, result: null, hear: null };
    running.set(editId, entry);
    attach(entry, heard, job, setBusy, report);
    let message: string;
    try {
      const result: EditExportResult = await exportEdit(editId, path, approach, jobId);
      const notes = result.warnings.length ? ` ${result.warnings.length} note${result.warnings.length === 1 ? "" : "s"}: ${result.warnings[0]}` : "";
      message = `Exported ${result.name}: ${result.segments} segments${result.markers_output ? ", markers beside it" : ""}.${notes}`;
    } catch (cause) {
      // Keep groups refuses what it cannot trim inside a group; the other kind can usually write it.
      const hint = approach !== "B" && /Render it in Avid|transition/i.test(formatError(cause)) ? " Clip that plays can write this bite: choose it and export again." : "";
      message = entry.stopped ? "Export stopped." : `Export failed: ${formatError(cause)}${hint}`;
    }
    finish(editId, message);
  };
  const stop = () => {
    const entry = running.get(editId);
    if (entry) entry.stopped = true;
    if (job.current) void invoke("cancel_job", { jobId: job.current }).catch(() => undefined);
  };
  return <div className="cp-te-export" role="group" aria-label="Export">
    <select className="cp-select cp-te-export-mode" aria-label="Group clips" title="How group clips are written" value={approach}
      disabled={busy} onChange={(event) => setApproach(event.target.value as EditExportApproach)}>
      <option value="V">Keep picture groups</option>
      <option value="C">Keep all groups</option>
      <option value="B">Clip that plays</option>
    </select>
    {busy
      ? <button type="button" className="btn btn-ghost cp-te-btn" onClick={stop} title="Stop the export">Stop</button>
      : <button type="button" className="btn btn-ghost cp-te-btn" disabled={disabled} onClick={() => void run()} title={disabled ? "Cut something in first" : "Export an AAF for Media Composer"}>
        <IconDownload size={13} />Export AAF</button>}
  </div>;
}
