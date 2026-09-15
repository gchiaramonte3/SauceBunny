import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useModalFocus } from "../hooks/use-modal-focus";
import type { AafDocument } from "../bindings/AafDocument";
import { autoMatch, castFromSpeakers, type Cast, type CastAssignment } from "../lib/cast";
import { castsAreReadOnly, flushCasts, getCastError, getCasts, hydrateCastStore, saveCast, subscribeCasts } from "../lib/cast-store";
import { SPEAKER_PALETTE } from "./transcript/helpers";
import { trackOwner } from "../lib/multitrack";
import { formatError } from "../lib/error-format";

type Props = { document: AafDocument; active?: boolean; onRename: (id: string, name: string, memberId?: string | null, color?: string | null) => void };

function CastAssignmentRows({ cast, document, onRename, onClose }: Pick<Props, "document" | "onRename"> & { cast: Cast; onClose: () => void }) {
  const [assignment, setAssignment] = useState<CastAssignment>(() => autoMatch(cast, document.manifest.tracks.map((track) => ({ tag: track.id, name: trackOwner(document, track.id), talkSeconds: 0 }))));
  return <div className="cp-multitrack-cast-assign"><p className="cp-multitrack-note">Review each match. Assigning a cast member labels the mic, not every voice it recorded.</p>
    {document.manifest.tracks.map((track) => <label key={track.id}><span><i className="cp-multitrack-cast-swatch" aria-hidden="true" style={{ backgroundColor: cast.members.find((member) => member.id === assignment[track.id])?.color ?? "var(--fg-4)" }} />{trackOwner(document, track.id)}</span><select className="cp-select" aria-label={`Cast member for ${track.name}`} value={assignment[track.id] ?? ""} onChange={(event) => setAssignment((prior) => ({ ...prior, [track.id]: event.target.value || null }))}><option value="">Leave unchanged</option>{cast.members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>)}
    <div className="cp-multitrack-cast-actions"><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-ghost" onClick={() => { for (const [trackId, memberId] of Object.entries(assignment)) { const member = cast.members.find((item) => item.id === memberId); if (member) onRename(trackId, member.name, member.id, member.color); } onClose(); }}>Apply mic labels</button></div>
  </div>;
}

export function MultitrackCast({ document, active = true, onRename }: Props) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  useModalFocus(open && active, dialog);
  useEffect(() => { if (!active) setOpen(false); }, [active]);
  const casts = useSyncExternalStore(subscribeCasts, getCasts);
  const storeError = useSyncExternalStore(subscribeCasts, getCastError);
  const [selected, setSelected] = useState<Cast | null>(null);
  const [castName, setCastName] = useState("");
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { void hydrateCastStore().catch((cause) => setStatus(formatError(cause))); }, []);
  const save = async () => {
    if (!castName.trim() || saving || castsAreReadOnly()) return;
    setSaving(true);
    try {
      saveCast(castFromSpeakers(castName, document.manifest.tracks.map((track, index) => ({ tag: track.id, name: trackOwner(document, track.id), color: document.labels.find((label) => label.track_id === track.id)?.color ?? SPEAKER_PALETTE[index % SPEAKER_PALETTE.length] }))));
      await flushCasts();
      setStatus(getCastError() ? "Cast could not be saved" : "Cast saved locally"); if (!getCastError()) setCastName("");
    } catch (cause) { setStatus(formatError(cause)); } finally { setSaving(false); }
  };
  return <div className="cp-multitrack-confirm">
    <button className="btn btn-ghost cp-multitrack-cast-trigger" aria-haspopup="dialog" onClick={() => setOpen(true)}>Save Mic Owners as Cast</button>
    {open && active && createPortal(<div className="cp-modal-scrim" onMouseDown={() => setOpen(false)}>
      <div ref={dialog} className="cp-multitrack-settings cp-multitrack-cast-dialog" role="dialog" aria-modal="true" aria-label="Mic owners and casts" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } }}>
      <header><h2>Mic owners and casts</h2><button className="btn btn-ghost" aria-label="Close cast dialog" onClick={() => setOpen(false)}>×</button></header>
      <p>Save these mic labels as a cast, or apply a saved cast to this sequence.</p>
      <div className="cp-multitrack-cast-actions"><input aria-label="New cast name" placeholder="Cast name…" value={castName} maxLength={120} onChange={(event) => setCastName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void save(); } }} /><button className="btn btn-ghost" disabled={!castName.trim() || saving || castsAreReadOnly()} onClick={() => void save()}>{saving ? "Saving…" : "Save cast"}</button></div>
      <div className="cp-multitrack-cast-actions"><select className="cp-select" aria-label="Apply a saved cast" value={selected?.id ?? ""} onChange={(event) => setSelected(casts.find((cast) => cast.id === event.target.value) ?? null)}><option value="">Choose saved cast…</option>{casts.map((cast) => <option key={cast.id} value={cast.id}>{cast.name}</option>)}</select></div>
      {selected && <CastAssignmentRows key={selected.id} cast={selected} document={document} onRename={onRename} onClose={() => setSelected(null)} />}
      {(status || storeError) && <p className="cp-multitrack-note" role="status">{storeError || status}</p>}
      <footer><button className="btn btn-ghost" onClick={() => setOpen(false)}>Done</button></footer>
      </div></div>, window.document.body)}
  </div>;
}
