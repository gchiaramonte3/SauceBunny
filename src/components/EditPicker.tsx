import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { AafDocument } from "../bindings/AafDocument";
import type { AafDocumentSummary } from "../bindings/AafDocumentSummary";
import type { EditDocument } from "../bindings/EditDocument";
import type { EditSummary } from "../bindings/EditSummary";
import { EditAskStringout } from "./EditAskStringout";
import { EDIT_SCHEMA_VERSION } from "../lib/edit-document";
import { editFromSequence } from "../lib/edit-new";
import { stringoutsFor } from "../lib/edit-stringout";
import { editStore, newEditId } from "../lib/edit-store";
import { formatError } from "../lib/error-format";

type Props = { onOpen: (id: string) => void };

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** A new edit with nothing in it, at 23.976 from 01:00:00:00, ready to cut into. */
const emptyEdit = (title: string): EditDocument => ({ schema_version: EDIT_SCHEMA_VERSION, title: title.trim() || "Untitled edit",
  edit_rate: { numerator: 24000, denominator: 1001 }, start_timecode_frames: 86314, sources: [], tracks: [], segments: [], mutes: [], markers: [] });

/**
 * Every edit, newest first, and the way to start one: empty, or from an AAF
 * Audio sequence (whole, to cut down, or as a source to build up from).
 */
export function EditPicker({ onOpen }: Props) {
  const [edits, setEdits] = useState<EditSummary[] | null>(null);
  const [saved, setSaved] = useState<AafDocumentSummary[]>([]);
  const [title, setTitle] = useState("");
  const [from, setFrom] = useState("");
  const [whole, setWhole] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    editStore.list().then((items) => { if (live) setEdits(items); }).catch((cause) => { if (live) { setEdits([]); setError(formatError(cause)); } });
    invoke<AafDocumentSummary[]>("aaf_list").then((items) => { if (live) setSaved(items); }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  const create = async () => {
    setBusy(true); setError(null);
    try {
      const document = from ? editFromSequence(await invoke<AafDocument>("aaf_open", { documentId: from }), title, whole) : emptyEdit(title);
      const id = newEditId();
      await editStore.create(id, document);
      onOpen(id);
    } catch (cause) {
      setError(formatError(cause));
    } finally { setBusy(false); }
  };
  /** One string-out per person with transcribed words, from the chosen sequence. */
  const stringouts = async () => {
    setBusy(true); setError(null);
    try {
      const made = stringoutsFor(await invoke<AafDocument>("aaf_open", { documentId: from }));
      if (!made.length) { setError("Nobody in this sequence has a transcript yet. Transcribe it in AAF Audio first."); return; }
      const ids: string[] = [];
      for (const document of made) { const id = newEditId(); await editStore.create(id, document); ids.push(id); }
      setEdits(await editStore.list());
      onOpen(ids[0]);
    } catch (cause) {
      setError(formatError(cause));
    } finally { setBusy(false); }
  };
  return <div className="cp-te-picker">
    <h1 className="cp-te-picker-title">Transcript Editor</h1>
    <p className="cp-te-picker-lede">Cut AAF Audio sequences by their words, then send the cut back to Media Composer as an AAF.</p>
    <form className="cp-te-picker-new" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <label className="cp-te-set-label">Title<input className="cp-input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Kitchen Challenge, first pass" /></label>
      <label className="cp-te-set-label">Start from<select className="cp-select" value={from} onChange={(event) => setFrom(event.target.value)}>
        <option value="">An empty timeline</option>
        {saved.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      {from && <label className="cp-te-picker-check"><input type="checkbox" checked={whole} onChange={(event) => setWhole(event.target.checked)} />Put the whole sequence in the edit</label>}
      <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Creating…" : "New edit"}</button>
      {from && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void stringouts()}
        title="One edit per person: their bites in scene order, with handles, filler between and a marker on each">String-out per person</button>}
    </form>
    {error && <p className="cp-te-errors" role="alert">{error}</p>}
    {from && <EditAskStringout documentId={from} onOpen={onOpen} />}
    <h2 className="cp-te-picker-head">Edits</h2>
    {edits === null ? <p className="cp-te-pane-note" role="status">Loading…</p>
      : !edits.length ? <p className="cp-te-pane-note">No edits yet.</p>
      : <ul className="cp-te-picker-list">{edits.map((item) => <li key={item.id}>
        <button type="button" className="cp-te-picker-item" onClick={() => onOpen(item.id)}>
          <span className="cp-te-picker-name">{item.title}</span>
          <span className="cp-te-pane-note">{item.states - 1} change{item.states === 2 ? "" : "s"} · {when(item.updated_at)}</span>
        </button></li>)}</ul>}
  </div>;
}
