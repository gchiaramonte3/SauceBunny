import { pipelineInvoke } from "../lib/pipeline";
import { useEffect, useMemo, useState } from "react";
import type { AafDocument } from "../bindings/AafDocument";
import type { AafDocumentSummary } from "../bindings/AafDocumentSummary";
import type { EditDocument } from "../bindings/EditDocument";
import { EditAskStringout } from "./EditAskStringout";
import { EDIT_SCHEMA_VERSION } from "../lib/edit-document";
import { editFromSequence } from "../lib/edit-new";
import { stringoutsFor } from "../lib/edit-stringout";
import { editStore, newEditId } from "../lib/edit-store";
import { formatError } from "../lib/error-format";
import { sequenceLabels } from "../lib/multitrack";
import { plural } from "../lib/plural";
import { hiddenCount, loadHiddenSequences, sequenceShelf, showHiddenSequences } from "../lib/sequence-shelf";
const invoke = pipelineInvoke("String Outs");

/** The Start from entry that puts hidden sequences back; never a document id, which is 64 hex digits. */
const SHOW_HIDDEN = "show-hidden";

type Props = { onOpen: (id: string) => void; onCancel: (() => void) | null; appLocalModelId?: string | null };

/** A new string out with nothing in it, at 23.976 from 01:00:00:00, ready to cut into. */
const emptyEdit = (title: string): EditDocument => ({ schema_version: EDIT_SCHEMA_VERSION, title: title.trim() || "Untitled string out",
  edit_rate: { numerator: 24000, denominator: 1001 }, start_timecode_frames: 86400, sources: [], tracks: [], segments: [], mutes: [], markers: [] });

/**
 * Starting a string out: empty, from an AAF Audio sequence (whole, to cut
 * down, or as a source to build up from), one per person, or asked for in
 * words.
 */
export function EditNewPanel({ onOpen, onCancel, appLocalModelId }: Props) {
  const [saved, setSaved] = useState<AafDocumentSummary[]>([]);
  // The same list as Add sequence: what was cleared there is not offered here either, until it is saved again.
  const [hidden, setHidden] = useState(loadHiddenSequences);
  const labels = useMemo(() => sequenceLabels(saved), [saved]);
  const shelf = useMemo(() => sequenceShelf(saved, hidden), [saved, hidden]), hiddenNow = hiddenCount(saved, hidden);
  const [title, setTitle] = useState("");
  const [from, setFrom] = useState("");
  // Empty by default, as a new sequence is in Avid: the cut is built from chunks of the source.
  const [whole, setWhole] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    invoke<AafDocumentSummary[]>("aaf_list").then((items) => {
      if (!live) return;
      setSaved(items);
      const listed = sequenceShelf(items, loadHiddenSequences());
      if (listed.length === 1) setFrom(listed[0].id);
    }).catch(() => undefined);
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
  /** One string out per person with transcribed words, from the chosen sequence. */
  const perPerson = async () => {
    setBusy(true); setError(null);
    try {
      const made = stringoutsFor(await invoke<AafDocument>("aaf_open", { documentId: from }));
      if (!made.length) { setError("Nobody in this sequence has a transcript yet. Transcribe it in AAF Audio first."); return; }
      const ids: string[] = [];
      for (const document of made) { const id = newEditId(); await editStore.create(id, document); ids.push(id); }
      // Every one gets a tab, so Export all reaches them; the first stays chosen.
      for (const id of [...ids, ids[0]]) onOpen(id);
    } catch (cause) {
      setError(formatError(cause));
    } finally { setBusy(false); }
  };
  return <div className="cp-te-picker">
    <h2 className="cp-te-picker-head">New string out</h2>
    <form className="cp-te-picker-new" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <label className="cp-te-set-label">Title<input className="cp-input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Rosa, first pass" /></label>
      <label className="cp-te-set-label">Start from<select className="cp-select" value={from}
        onChange={(event) => { if (event.target.value === SHOW_HIDDEN) setHidden(showHiddenSequences()); else setFrom(event.target.value); }}>
        <option value="">An empty timeline</option>
        {shelf.map((item) => <option key={item.id} value={item.id}>{labels.get(item.id) ?? item.name}</option>)}
        {hiddenNow > 0 && <option value={SHOW_HIDDEN}>Show {plural(hiddenNow, "hidden sequence", "hidden sequences")}</option>}
      </select></label>
      {from && <label className="cp-te-picker-check"><input type="checkbox" checked={whole} onChange={(event) => setWhole(event.target.checked)} />Start with the whole sequence</label>}
      <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Creating…" : "Create"}</button>
      {from && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void perPerson()}
        title="One string out per person: their bites in scene order, with handles, filler between and a marker on each">One per person</button>}
      {onCancel && <button type="button" className="btn btn-ghost" disabled={busy} onClick={onCancel}>Cancel</button>}
    </form>
    {error && <p className="cp-te-errors" role="alert">{error}</p>}
    {from && <EditAskStringout documentId={from} onOpen={onOpen} appLocalModelId={appLocalModelId} />}
  </div>;
}
