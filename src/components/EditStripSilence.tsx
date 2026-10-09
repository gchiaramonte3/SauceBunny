import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useModalFocus } from "../hooks/use-modal-focus";
import { useEditStripSilence, type StripRequest } from "../hooks/use-edit-strip-silence";
import { stripSilenceDefaults, type StripSilenceOptions } from "../lib/edit-strip-silence";
import { loadJson, saveJson } from "../lib/storage";

type Props = Parameters<typeof useEditStripSilence>[0] & {
  request: StripRequest;
  /** Where it applies, in words: "A1 Rosa and A2 Dev, 01:00:10:00 to 01:00:40:00". */
  scope: string;
  /** Why it cannot run yet (the mics are not measured), or undefined. */
  hint?: string;
  onDone: (message: string) => void; onClose: () => void;
};

const SETTINGS = "saucebunny.stringOuts.stripSilence";
type Field = { key: "thresholdDb" | "minimum" | "padStart" | "padEnd"; label: string; unit: "dB" | "ms" };
const FIELDS: Field[] = [
  { key: "thresholdDb", label: "Threshold", unit: "dB" }, { key: "minimum", label: "Minimum duration", unit: "ms" },
  { key: "padStart", label: "Pad start", unit: "ms" }, { key: "padEnd", label: "Pad end", unit: "ms" },
];

/**
 * Media Composer's Strip Silence dialog, for the record side: Threshold, Pad
 * Start, Pad End and Minimum duration, on the selected tracks between In and
 * Out. The settings are remembered. Strip waits for every read, then changes
 * the cut in one undo step; Stop leaves it as it was.
 */
export function EditStripSilence({ request, scope, hint, onDone, onClose, ...hook }: Props) {
  const strip = useEditStripSilence(hook);
  const [options, setOptions] = useState<StripSilenceOptions>(() => ({ ...stripSilenceDefaults, ...loadJson<Partial<StripSilenceOptions>>(SETTINGS, {}) }));
  const dialog = useRef<HTMLDivElement>(null), title = useId();
  useModalFocus(true, dialog);
  const shown = (field: Field) => field.unit === "ms" ? Math.round(options[field.key] * 1000) : options[field.key];
  const set = (field: Field, value: number) => Number.isFinite(value) && setOptions((current) => ({ ...current, [field.key]: field.unit === "ms" ? Math.max(0, value) / 1000 : Math.min(0, value) }));
  const run = async () => { saveJson(SETTINGS, options); const message = await strip.run(request, options); onDone(message); onClose(); };
  const cancel = () => { if (strip.busy) strip.stop(); else onClose(); };
  return createPortal(<div className="cp-modal-scrim" onClick={(event) => { if (event.target === event.currentTarget && !strip.busy) onClose(); }}>
    <div ref={dialog} className="cp-te-strip" role="dialog" aria-modal="true" aria-labelledby={title} tabIndex={-1}
      onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") { event.preventDefault(); cancel(); } }}>
      <h2 id={title} className="cp-te-strip-title">Strip Silence</h2>
      <p className="cp-te-strip-scope">{scope}</p>
      <div className="cp-te-strip-fields">
        {FIELDS.map((field) => <label key={field.key} className="cp-te-set-label">{field.label} ({field.unit})
          <input className="cp-input" type="number" step={field.unit === "dB" ? 1 : 10} max={field.unit === "dB" ? 0 : undefined} min={field.unit === "ms" ? 0 : -96}
            value={shown(field)} disabled={strip.busy} onChange={(event) => set(field, Number(event.target.value))} />
        </label>)}
      </div>
      <label className="cp-te-picker-check"><input type="checkbox" checked={options.keepWords} disabled={strip.busy}
        onChange={(event) => setOptions((current) => ({ ...current, keepWords: event.target.checked }))} />Keep transcribed words</label>
      {hint && <p className="cp-te-strip-hint" role="note">{hint}</p>}
      <div className="cp-te-strip-actions">
        {strip.busy && <span className="cp-te-pane-note" role="status">Measuring…</span>}
        <button type="button" className="btn btn-ghost cp-te-btn" onClick={cancel}>{strip.busy ? "Stop" : "Cancel"}</button>
        <button type="button" className="btn cp-te-btn" disabled={strip.busy || !!hint || !request.layers.length} onClick={() => void run()}
          title={hint ?? (request.layers.length ? "Silence the quiet stretches on these tracks; nothing moves" : "Select a track first")}>Strip</button>
      </div>
    </div>
  </div>, document.body);
}
