import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AafDocument } from "../bindings/AafDocument";
import { useDismiss } from "../hooks/use-dismiss";
import { useMenuKeys } from "../hooks/use-menu-keys";
import { useMultitrackExport } from "../hooks/use-multitrack-export";
import { hasTranscriptContent, trackOwner } from "../lib/multitrack";
import { alternativeLane, laneReady } from "../lib/multitrack-graph";

export type MultitrackMenuTarget = { id: string; x: number; y: number };
export function MultitrackTrackActions({ document: doc, target, disabled, onClose, onRegenerate }: {
  document: AafDocument; target: MultitrackMenuTarget | null; disabled: boolean; onClose: () => void; onRegenerate: (id: string) => void;
}) {
  const menu = useRef<HTMLDivElement>(null), [position, setPosition] = useState({ left: 8, top: 8 }), output = useMultitrackExport(doc);
  useDismiss(menu, onClose, !!target); useMenuKeys(menu, !!target, onClose);
  useLayoutEffect(() => {
    if (!target) return;
    const place = () => { const bounds = menu.current?.getBoundingClientRect(); setPosition({ left: Math.max(8, Math.min(target.x, window.innerWidth - (bounds?.width ?? 260) - 8)), top: Math.max(8, Math.min(target.y, window.innerHeight - (bounds?.height ?? 240) - 8)) }); };
    place(); window.addEventListener("resize", place); return () => window.removeEventListener("resize", place);
  }, [target, output.phase, output.status, output.error]);
  if (!target) return null;
  const owner = trackOwner(doc, target.id), transcript = doc.transcripts.find((item) => item.track_id === target.id), busy = output.phase === "loading";
  const timed = transcript?.cues.some((cue) => hasTranscriptContent(cue.text)), untimed = transcript?.timing_issues?.some((cue) => hasTranscriptContent(cue.text));
  return createPortal(<div ref={menu} className="cp-multitrack-track-menu" role="menu" aria-label={`Actions for ${owner}`} style={position}>
    <div className="cp-multitrack-track-menu-title">{owner}</div>
    <button role="menuitem" disabled={disabled || busy || !laneReady(doc, target.id)} onClick={() => { onClose(); onRegenerate(target.id); }}>{transcript ? "Regenerate…" : "Generate…"}</button>
    <button role="menuitem" disabled={busy || !(timed || untimed)} onClick={() => void output.download("txt", [target.id], owner)}>Download text file…</button>
    <button role="menuitem" disabled={busy || !timed} title={alternativeLane(doc, target.id) ? "Export this microphone to its parent sequence track, not inside the source group" : undefined} onClick={() => void output.download("avid", [target.id], owner)}>Export Avid markers…</button>
    {busy && <p role="status">Exporting…</p>}{output.status && <p role="status">{output.status}</p>}{output.error && <p role="alert">{output.error}</p>}
  </div>, document.body);
}
