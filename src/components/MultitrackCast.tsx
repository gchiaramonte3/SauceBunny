import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useModalFocus } from "../hooks/use-modal-focus";
import type { AafDocument } from "../bindings/AafDocument";
import { autoMatch, castFromSpeakers, type Cast, type CastAssignment } from "../lib/cast";
import { castsAreReadOnly, flushCasts, getCastError, getCasts, hydrateCastStore, saveCast, subscribeCasts } from "../lib/cast-store";
import { SPEAKER_PALETTE } from "./transcript/helpers";
import { trackOwner } from "../lib/multitrack";
import { formatError } from "../lib/error-format";
import { CastMarkerFields, type RenameMic } from "./CastMarkerFields";

type Props = { document: AafDocument; active?: boolean; onRename: RenameMic; editTrack?: string | null; onCloseEdit?: () => void };

function CastAssignmentRows({ cast, document, onRename, onClose }: Pick<Props, "document" | "onRename"> & { cast: Cast; onClose: () => void }) {
  const [assignment, setAssignment] = useState<CastAssignment>(() => autoMatch(cast, document.manifest.tracks.map((track) => ({ tag: track.id, name: trackOwner(document, track.id), talkSeconds: 0 }))));
  return <div className="cp-multitrack-cast-assign"><p className="cp-multitrack-note">Review each match. Assigning a cast member labels the mic, not every voice it recorded.</p>
    {document.manifest.tracks.map((track) => <label key={track.id}><span><i className="cp-multitrack-cast-swatch" aria-hidden="true" style={{ backgroundColor: cast.members.find((member) => member.id === assignment[track.id])?.color ?? "var(--fg-4)" }} />{trackOwner(document, track.id)}</span><select className="cp-select" aria-label={`Cast member for ${track.name}`} value={assignment[track.id] ?? ""} onChange={(event) => setAssignment((prior) => ({ ...prior, [track.id]: event.target.value || null }))}><option value="">Leave unchanged</option>{cast.members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>)}
    <div className="cp-multitrack-cast-actions"><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-ghost" onClick={() => { for (const [trackId, memberId] of Object.entries(assignment)) { const member = cast.members.find((item) => item.id === memberId); if (member) onRename(trackId, member.name, member.id, member.color, { gender: member.gender ?? "unspecified", marker_color: member.markerColor }); } onClose(); }}>Apply mic labels</button></div>
  </div>;
}

export function MultitrackCast({ document, active = true, onRename, editTrack, onCloseEdit }: Props) {
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
  const close = () => { setOpen(false); onCloseEdit?.(); };
  useEffect(() => { if (editTrack && active) { setSelected(null); setOpen(true); } }, [editTrack, active]);
  useEffect(() => { if (open && editTrack) {
    const row = [...(dialog.current?.querySelectorAll<HTMLElement>("[data-mic-owner]") ?? [])].find((item) => item.dataset.micOwner === editTrack);
    row?.scrollIntoView?.({ block: "nearest" }); row?.querySelector<HTMLSelectElement>("select")?.focus();
  } }, [open, editTrack]);
  useEffect(() => { void hydrateCastStore().catch((cause) => setStatus(formatError(cause))); }, []);
  const save = async () => {
    if (!castName.trim() || saving || castsAreReadOnly()) return;
    setSaving(true);
    try {
      saveCast(castFromSpeakers(castName, document.manifest.tracks.map((track, index) => {
        const label = document.labels.find((item) => item.track_id === track.id);
        return { tag: track.id, name: trackOwner(document, track.id), color: label?.color ?? SPEAKER_PALETTE[index % SPEAKER_PALETTE.length], gender: label?.gender, markerColor: label?.marker_color };
      })));
      await flushCasts();
      setStatus(getCastError() ? "Cast could not be saved" : "Cast saved locally"); if (!getCastError()) setCastName("");
    } catch (cause) { setStatus(formatError(cause)); } finally { setSaving(false); }
  };
  return <div className="cp-multitrack-confirm">
    <button className="btn btn-ghost cp-multitrack-cast-trigger" aria-haspopup="dialog" onClick={() => setOpen(true)}>Save Mic Owners as Cast</button>
    {open && active && createPortal(<div className="cp-modal-scrim" onMouseDown={close}>
      <div ref={dialog} className="cp-multitrack-settings cp-multitrack-cast-dialog" role="dialog" aria-modal="true" aria-label="Mic owners and casts" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}>
      <header><h2>Mic owners and casts</h2><button className="btn btn-ghost" aria-label="Close cast dialog" onClick={close}>×</button></header>
      <p>Save these mic labels as a cast, or apply a saved cast to this sequence.</p>
      <div className="cp-multitrack-cast-actions"><input aria-label="New cast name" placeholder="Cast name…" value={castName} maxLength={120} onChange={(event) => setCastName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void save(); } }} /><button className="btn btn-ghost" disabled={!castName.trim() || saving || castsAreReadOnly()} onClick={() => void save()}>{saving ? "Saving…" : "Save cast"}</button></div>
      <div className="cp-multitrack-cast-actions"><select className="cp-select" aria-label="Apply a saved cast" value={selected?.id ?? ""} onChange={(event) => setSelected(casts.find((cast) => cast.id === event.target.value) ?? null)}><option value="">Choose saved cast…</option>{casts.map((cast) => <option key={cast.id} value={cast.id}>{cast.name}</option>)}</select></div>
      <p className="cp-multitrack-note">Gender is optional and assigned by you. Man defaults to Blue; Woman defaults to Pink. Marker color can be changed independently.</p>
      <div className="cp-multitrack-cast-preferences">
      {selected ? selected.members.map((member) => <div className="cp-multitrack-cast-preference" key={member.id}><span>{member.name}</span><CastMarkerFields name={member.name} value={{ gender: member.gender, marker_color: member.markerColor }} onChange={(value) => setSelected({ ...selected, members: selected.members.map((item) => item.id === member.id ? { ...item, gender: value.gender, markerColor: value.marker_color } : item) })} /></div>) : document.manifest.tracks.map((track) => {
        const label = document.labels.find((item) => item.track_id === track.id), owner = trackOwner(document, track.id);
        return <div className="cp-multitrack-cast-preference" data-mic-owner={track.id} key={track.id}><span>{owner}</span><CastMarkerFields name={owner} value={label ?? {}} onChange={(value) => onRename(track.id, owner, undefined, undefined, value)} /></div>;
      })}</div>
      {selected && <button className="btn btn-ghost" disabled={saving || castsAreReadOnly()} onClick={async () => { setSaving(true); try { saveCast(selected); await flushCasts(); setStatus(getCastError() ?? "Cast saved. Existing document labels are unchanged until you apply it."); } catch (cause) { setStatus(formatError(cause)); } finally { setSaving(false); } }}>Save cast changes</button>}
      {selected && <CastAssignmentRows key={selected.id} cast={selected} document={document} onRename={onRename} onClose={() => setSelected(null)} />}
      {(status || storeError) && <p className="cp-multitrack-note" role="status">{storeError || status}</p>}
      <footer><button className="btn btn-ghost" onClick={close}>Done</button></footer>
      </div></div>, window.document.body)}
  </div>;
}
