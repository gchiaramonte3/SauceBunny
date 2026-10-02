import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AafDocument } from "../bindings/AafDocument";
import { recordingDates, shootDate } from "../lib/multitrack-metadata";
import { formatError } from "../lib/error-format";

export function MultitrackShootDate({ document }: { document: AafDocument }) {
  const dates = recordingDates(document);
  const initial = document.shoot_date_override ?? (dates.length === 1 ? dates[0] : "");
  const [draft, setDraft] = useState(initial), [busy, setBusy] = useState(false), [status, setStatus] = useState("");
  useEffect(() => { setDraft(initial); }, [initial, document.id]);
  async function save(value: string | null) {
    if (busy) return;
    setBusy(true); setStatus("");
    try { await invoke<AafDocument>("aaf_save_shoot_date", { documentId: document.id, shootDate: value }); setStatus("Shoot date saved"); }
    catch (cause) { setStatus(formatError(cause)); } finally { setBusy(false); }
  }
  return <details className="cp-multitrack-date"><summary>Shoot date: {shootDate(document)}</summary>
    <p className="cp-multitrack-note">{dates.length ? `Source recording metadata: ${dates.join(", ")}.` : "No recording date found in the source metadata."} Download and file-modified dates are not used.</p>
    <div className="cp-multitrack-date-controls"><label>Shoot date<input type="date" aria-label="Shoot date override" value={draft} disabled={busy} onChange={event => setDraft(event.target.value)} /></label>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void save(draft)}>Save date</button>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void save(null)}>Use source metadata</button></div>
    {status && <p className="cp-multitrack-note" role="status">{status}</p>}
  </details>;
}
