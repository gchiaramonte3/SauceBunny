import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AnalysisEditDocument } from "../bindings/AnalysisEditDocument";
import type { AnalysisEditRow } from "../bindings/AnalysisEditRow";
import type { AnalysisRowCorrection } from "../bindings/AnalysisRowCorrection";
import { correctedRow, editedCorrection, FIELD_NAMES, timingField, type CorrectionField } from "../lib/scene-analysis/corrections";
import { framesToTc, secondsToFrames, secondsToTc } from "../lib/timecode";
import { formatError } from "../lib/error-format";
import { useModalFocus } from "../hooks/use-modal-focus";
import { useDismiss } from "../hooks/use-dismiss";

export function ShotCellEditor({ row, correction, field, snapshot, onSave, onClose }: {
  row: AnalysisEditRow; correction: AnalysisRowCorrection; field: CorrectionField; snapshot: AnalysisEditDocument;
  onSave: (edit: AnalysisRowCorrection) => Promise<void>; onClose: () => void;
}) {
  const resolved = correctedRow(row, correction), timing = timingField(field);
  const initial = field === "duration" ? framesToTc(secondsToFrames(resolved.end_us / 1e6, snapshot.fps) - secondsToFrames(resolved.start_us / 1e6, snapshot.fps), snapshot.fps)
    : field === "start_us" || field === "end_us" ? secondsToTc(resolved[field] / 1e6, snapshot.fps) : resolved[field];
  const [value, setValue] = useState(initial), [saving, setSaving] = useState(false), [error, setError] = useState("");
  const pending = useRef(false), dialog = useRef<HTMLDivElement>(null), title = useId(), hint = useId(), errorId = useId();
  const close = () => { if (!pending.current) onClose(); };
  useModalFocus(true, dialog);
  useDismiss(dialog, close);
  useEffect(() => { dialog.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea")?.focus(); }, []);
  async function save(reset = false) {
    if (pending.current) return;
    setError("");
    try {
      const edit = editedCorrection(row, correction, field, reset ? null : value, snapshot.fps, snapshot.source.duration_us);
      pending.current = true; setSaving(true);
      await onSave(edit);
      onClose();
    } catch (cause) { setError(formatError(cause)); }
    finally { pending.current = false; setSaving(false); }
  }
  const textArea = field === "picture" || field === "dialogue" || field === "summary";
  const changed = field === "duration" ? correction.start_us !== null || correction.end_us !== null : correction[field] !== null;
  const common = { className: `cp-input cp-shot-edit-input${timing ? " cp-shot-edit-time" : ""}`, value, disabled: saving,
    "aria-label": FIELD_NAMES[field], "aria-invalid": !!error, "aria-describedby": `${hint}${error ? ` ${errorId}` : ""}`,
    onFocus: (event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => { if (!textArea) event.currentTarget.select(); },
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const next = event.target.value;
      if (!timing || /^[\d:]{0,11}$/.test(next)) { setValue(next); setError(""); }
    } };
  return createPortal(<div className="cp-modal-scrim"><div ref={dialog} tabIndex={-1} className="cp-shot-cell-editor" role="dialog" aria-modal="true" aria-labelledby={title}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Escape") { event.preventDefault(); close(); }
      else if (event.key === "Enter" && ((!textArea && event.target instanceof HTMLInputElement) || (textArea && (event.metaKey || event.ctrlKey)))) {
        event.preventDefault(); void save();
      } else if (timing && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !/[\d:]/.test(event.key)) event.preventDefault();
    }}>
    <div className="cp-shot-edit-heading"><h3 id={title}>Shot {resolved.label} · {FIELD_NAMES[field]}</h3><button className="cp-icon-btn" type="button" aria-label="Close editor" disabled={saving} onClick={close}>×</button></div>
    {textArea ? <textarea {...common} rows={6} /> : <input {...common} inputMode={timing ? "numeric" : "text"} maxLength={timing ? 11 : 48} />}
    <p id={hint} className="cp-muted">{field === "duration" ? "Changes the end timecode. Other shots stay unchanged." : timing ? `${snapshot.fps.toFixed(3).replace(/\.?0+$/, "")} fps · HH:MM:SS:FF` : "Your correction is saved separately from the model output."}</p>
    {error && <p id={errorId} className="cp-shot-edit-error" role="alert">{error}</p>}
    <div className="cp-shot-edit-actions"><button className="btn btn-ghost" type="button" title={field === "duration" ? "Restore original start and end" : "Restore the original field"} disabled={!changed || saving} onClick={() => void save(true)}>{field === "duration" ? "Reset timing" : "Reset field"}</button>
      <span /><button className="btn btn-ghost" type="button" disabled={saving} onClick={close}>Cancel</button><button className="btn" type="button" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button></div>
  </div></div>, document.body);
}
