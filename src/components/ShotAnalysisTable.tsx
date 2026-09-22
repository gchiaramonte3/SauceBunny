import { useState } from "react";
import type { ReactNode } from "react";
import type { AnalysisEditDocument } from "../bindings/AnalysisEditDocument";
import type { AnalysisEditRow } from "../bindings/AnalysisEditRow";
import type { AnalysisRowCorrection } from "../bindings/AnalysisRowCorrection";
import { correctedRow, emptyCorrection, FIELD_NAMES, rowAnchor, type CorrectionField } from "../lib/scene-analysis/corrections";
import { framesToTc, secondsToFrames, secondsToTc } from "../lib/timecode";
import { ShotCellEditor } from "./ShotCellEditor";

export function ShotAnalysisTable({ rows, snapshot, corrections, tab, editing, fps, busy, dialogueEmpty, onSeek, onSave }: {
  rows: AnalysisEditRow[]; snapshot: AnalysisEditDocument | null; corrections: AnalysisEditDocument["corrections"];
  tab: "All" | "Picture" | "Transcript"; editing: boolean; fps: number; busy: boolean; dialogueEmpty: string;
  onSeek?: (seconds: number) => void;
  onSave: (snapshot: AnalysisEditDocument, key: string, correction: AnalysisRowCorrection) => Promise<void>;
}) {
  // Capture the original row/revision at the first keystroke. Streaming model
  // responses and another window's saves cannot rewrite a draft underneath it.
  const [draft, setDraft] = useState<{ row: AnalysisEditRow; correction: AnalysisRowCorrection; field: CorrectionField; snapshot: AnalysisEditDocument } | null>(null);
  return <>
    <div className="cp-shot-table-scroll"><table className={`cp-shot-table${tab === "All" ? " cp-shot-table--combined" : ""}${editing ? " cp-shot-table--editing" : ""}`}>
      <colgroup><col className="cp-shot-col-number" /><col className="cp-shot-col-time" /><col className="cp-shot-col-duration" />{tab !== "Transcript" && <col />}{tab !== "Picture" && <col />}</colgroup>
      <thead><tr><th>Shot</th><th>Start / end</th><th>Duration</th>{tab !== "Transcript" && <th>Picture</th>}{tab !== "Picture" && <th>Dialogue</th>}</tr></thead><tbody>
        {rows.map(row => {
          const correction = corrections[rowAnchor(row)] ?? emptyCorrection(), resolved = correctedRow(row, correction);
          const start = secondsToTc(resolved.start_us / 1e6, fps), end = secondsToTc(resolved.end_us / 1e6, fps);
          const frames = secondsToFrames(resolved.end_us / 1e6, fps) - secondsToFrames(resolved.start_us / 1e6, fps);
          const edit = (field: CorrectionField) => { if (snapshot) setDraft({ row, correction: { ...correction }, field, snapshot }); };
          const cell = (field: CorrectionField, contents: ReactNode) => editing ? <button type="button" className="cp-shot-edit-cell" title={`Edit ${FIELD_NAMES[field].toLowerCase()}`} aria-label={`Edit shot ${resolved.label} ${FIELD_NAMES[field].toLowerCase()}`} onClick={() => edit(field)}>{contents}</button> : contents;
          return <tr key={rowAnchor(row)}><th scope="row">{cell("label", resolved.label)}</th><td><div className="cp-shot-times">
            {(["start_us", "end_us"] as const).map((field, index) => <button key={field} type="button" className="cp-tc cp-shot-time"
              aria-label={editing ? `Edit shot ${resolved.label} ${index ? "end" : "start"}` : `Shot ${resolved.label} ${index ? "end" : "start"} at ${index ? end : start}`}
              title={editing ? `Edit ${index ? "end" : "start"}` : `Go to ${index ? end : start}`} disabled={!editing && !onSeek}
              onClick={() => editing ? edit(field) : onSeek?.(resolved[field] / 1e6)}>{index ? end : start}</button>)}
          </div></td><td className="cp-shot-duration" title={`${frames} frames`}>{cell("duration", framesToTc(frames, fps))}</td>
            {tab !== "Transcript" && <td className="cp-shot-transcript">{cell("picture", resolved.picture || <span className="cp-muted">{correction.picture !== null ? "Empty" : busy ? "Pending" : "Not generated"}</span>)}</td>}
            {tab !== "Picture" && <td className="cp-shot-transcript">{cell("dialogue", resolved.dialogue || <span className="cp-muted">{correction.dialogue !== null ? "Empty" : dialogueEmpty}</span>)}
              {(resolved.summary || editing) && <details><summary>Transcript summary</summary>{cell("summary", resolved.summary || <span className="cp-muted">Empty</span>)}</details>}</td>}
          </tr>;
        })}
      </tbody></table></div>
    {draft && <ShotCellEditor {...draft} onClose={() => setDraft(null)} onSave={edit => onSave(draft.snapshot, rowAnchor(draft.row), edit)} />}
  </>;
}
