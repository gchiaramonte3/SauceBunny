import { useState } from "react";
import { Companion } from "./companion";
import type { Placement } from "./premiere";
import type { MarkerNote } from "./protocol";

export function PendingNote({ note, companion, enabled, connected, bound }: { note: MarkerNote; companion: Companion; enabled: boolean; connected: boolean; bound: boolean }) {
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(work: () => Promise<void>) {
    setError(""); setBusy(true);
    try { await work(); } catch (reason) { setError(reason instanceof Error ? reason.message : "The note could not be placed."); }
    finally { setBusy(false); }
  }
  return <article className="cp-companion-note">
    <h3>{note.request.author}</h3>
    <p className="cp-companion-note-body">{note.request.body}</p>
    <p className="cp-companion-muted">{note.request.anchor.binding.sequenceName} · {note.status === "uncertain" || note.status === "dispatching" ? "Delivery needs checking" : "Needs timeline position"}</p>
    <p className="cp-companion-muted">Saved in Sauce Bunny</p>
    {!bound && <><p className="cp-companion-muted">This note belongs to another captured binding. Open its original project to restore it.</p>
      <button disabled={!connected || busy} onClick={() => { void run(async () => { await companion.restore(note); setPlacement(null); }); }}>Restore captured binding</button>
    </>}
    {!placement ? <>
      <p className="cp-companion-muted">Park the bound sequence on the intended frame first.</p>
      <button disabled={!enabled || !bound || busy || note.status === "dispatching"}
        onClick={() => { void run(async () => setPlacement(await companion.prepare(note))); }}>Capture parked position</button>
      {note.status !== "needs_confirmation" && <button disabled={!enabled || busy}
        onClick={() => { void run(async () => { await companion.reconcile(note); }); }}>Check existing marker</button>}
    </> : <div className="cp-companion-confirm">
      <p>Place on sequence frame <strong>{placement.frame}</strong> in {placement.binding.sequenceName}?</p>
      <p className="cp-companion-muted">This captured position will not move while you decide. It is editor-confirmed, not inferred from NDI.</p>
      <button className="cp-companion-primary" aria-busy={busy} disabled={!enabled || busy} onClick={() => { void run(async () => { await companion.confirm(note, placement); setPlacement(null); }); }}>
        {busy ? "Adding…" : "Add marker here"}
      </button>
      <button disabled={busy} onClick={() => setPlacement(null)}>Cancel</button>
    </div>}
    {(error || note.error) && <p role="alert" className="cp-companion-error">{error || note.error}</p>}
  </article>;
}
