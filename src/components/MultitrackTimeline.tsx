import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AafDocument } from "../bindings/AafDocument";
import { audioTrackLabel, clampFrame, sequenceTimecode, trackOwner, transcriptRows } from "../lib/multitrack";
import { MultitrackWaveform } from "./MultitrackWaveform";
import { MultitrackLevel } from "./MultitrackLevel";
import { multitrackTextLayout } from "../lib/multitrack-text-layout";
import { alternativeLane, laneMetadata, laneReady, laneStatus, visibleLanes } from "../lib/multitrack-graph";
import { IconChevronRight, IconChevronDown } from "./Icons";

type Props = {
  document: AafDocument; waveforms: Record<string, number[][]>; waveformErrors: Record<string, string>;
  detail?: { start: number; span: number; peaks: Record<string, number[][]> }; onView?: (start: number, span: number, enabled: boolean) => void;
  selected: Set<string>; onSelect: (trackId: string) => void; onRename: (trackId: string, owner: string) => void;
  solo: Set<string>; muted?: Set<string>; onSolo?: (id: string) => void; onMute?: (id: string) => void;
  levels?: Record<string, number>; onLevel?: (id: string, value: number) => void;
  onTrackMenu?: (id: string, x: number, y: number) => void;
  onOwnerMenu?: (id: string) => void;
  expanded?: Set<string>; onExpand?: (id: string) => void;
  frame: number; onSeek: (frame: number, trackId?: string) => void; onScrub?: (frame: number) => void;
  onScrubEnd?: (frame: number, resume: boolean) => void; playing?: boolean; showWaveforms?: boolean; transport?: ReactNode;
};
function TrackLabel({ document, trackId, onRename, onOwnerMenu }: Pick<Props, "document" | "onRename" | "onOwnerMenu"> & { trackId: string }) {
  const owner = trackOwner(document, trackId), [draft, setDraft] = useState(owner);
  const cancelled = useRef(false);
  return <input className="cp-multitrack-owner" aria-label={`Mic owner for ${trackId}`} value={draft} title={owner}
    onContextMenu={onOwnerMenu ? (event) => { event.preventDefault(); event.stopPropagation(); event.currentTarget.blur(); onOwnerMenu(trackId); } : undefined}
    onChange={(event) => setDraft(event.target.value)} maxLength={120}
    onBlur={() => { if (!cancelled.current && draft.trim() !== owner) onRename(trackId, draft); cancelled.current = false; }}
    onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { cancelled.current = true; setDraft(owner); event.currentTarget.blur(); } }} />;
}
export function MultitrackTimeline({ document, waveforms, waveformErrors, selected, onSelect, onRename, solo, muted = new Set(), onSolo, onMute, levels = {}, onLevel, onTrackMenu, onOwnerMenu, frame, onSeek, onScrub, onScrubEnd, playing = false, showWaveforms = true, transport, detail, onView, expanded = new Set(), onExpand }: Props) {
  const [zoom, setZoom] = useState(1), [start, setStart] = useState(0), [density, setDensity] = useState("small");
  const [textTracks, setTextTracks] = useState(new Set<string>()), [dragging, setDragging] = useState(false), [hover, setHover] = useState<number | null>(null);
  const gesture = useRef<{ pointer: number; resume: boolean; frame: number } | null>(null);
  const rulerRef = useRef<HTMLDivElement>(null), [laneWidth, setLaneWidth] = useState(800);
  useEffect(() => {
    if (!rulerRef.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => { if (entry.contentRect.width > 0) setLaneWidth(Math.round(entry.contentRect.width)); });
    observer.observe(rulerRef.current); return () => observer.disconnect();
  }, []);
  const duration = document.manifest.duration_frames, span = Math.max(1, Math.ceil(duration / zoom));
  const viewStart = Math.max(0, Math.min(start, duration - span)), viewEnd = Math.min(duration, viewStart + span);
  useEffect(() => { onView?.(viewStart, span, showWaveforms && !dragging && zoom > 1); }, [onView, viewStart, span, showWaveforms, dragging, zoom]);
  const rows = useMemo(() => transcriptRows(document), [document]);
  // View geometry changes on zoom/pan or new data, not on playback/hover ticks.
  const clipsByTrack = useMemo(() => new Map(document.manifest.tracks.map((track) => [track.id,
    track.clips.filter((clip) => clip.kind !== "gap" && clip.start_frame < viewEnd && clip.start_frame + clip.duration_frames > viewStart).map((clip) => ({
      left: `${Math.max(0, (clip.start_frame - viewStart) / span * 100)}%`,
      width: `${(Math.min(viewEnd, clip.start_frame + clip.duration_frames) - Math.max(viewStart, clip.start_frame)) / span * 100}%`,
    })),
  ])), [document.manifest.tracks, viewStart, viewEnd, span]);
  const cuesByTrack = useMemo(() => {
    const grouped = new Map<string, typeof rows>();
    for (const cue of rows) {
      if (!textTracks.has(cue.trackId)) continue;
      const track = grouped.get(cue.trackId);
      if (track) track.push(cue); else grouped.set(cue.trackId, [cue]);
    }
    return new Map([...grouped].map(([id, cues]) => [id, multitrackTextLayout(cues, viewStart, span, laneWidth)]));
  }, [rows, textTracks, viewStart, span, laneWidth]);
  const ruler = useMemo(() => Array.from({ length: 5 }, (_, index) => sequenceTimecode(document.manifest, viewStart + Math.floor(span * index / 4))), [document.manifest, viewStart, span]);
  const playheadTimecode = sequenceTimecode(document.manifest, frame);
  const moveZoom = (next: number) => { setZoom(next); setStart(Math.max(0, Math.min(duration - duration / next, Math.floor(frame - duration / next / 2)))); };
  const pickFrame = (clientX: number, element: HTMLElement) => { const bounds = element.getBoundingClientRect(); return clampFrame(viewStart + (clientX - bounds.left) / Math.max(1, bounds.width) * span, duration); };
  const endGesture = (pointer: number, cancelled = false) => {
    const current = gesture.current; if (!current || current.pointer !== pointer) return;
    gesture.current = null; setDragging(false);
    if (onScrubEnd) onScrubEnd(current.frame, !cancelled && current.resume); else onSeek(current.frame);
  };
  const densityClass = density === "small" ? "cp-multitrack-density-small" : density === "medium" ? "cp-multitrack-density-medium" : "cp-multitrack-density-large";
  return <section className={`cp-multitrack-timeline ${densityClass}`} aria-label="Audio tracks">
    {transport}
    <div className="cp-multitrack-timeline-tools"><span>{document.manifest.tracks.length} tracks · {selected.size} checked</span>
      <label className="cp-multitrack-density"><span>Track size</span><select className="cp-select" value={density} onChange={(event) => setDensity(event.target.value)}><option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option></select></label>
      <div className="cp-multitrack-zoom"><button className="btn btn-ghost" aria-label="Zoom out" disabled={zoom <= 1} onClick={() => moveZoom(Math.max(1, zoom / 2))}>−</button>
        <span>{zoom}×</span><button className="btn btn-ghost" aria-label="Zoom in" disabled={zoom >= 1024} onClick={() => moveZoom(Math.min(1024, zoom * 2))}>+</button><button className="btn btn-ghost" onClick={() => moveZoom(1)}>Fit</button></div>
    </div>
    <div className="cp-multitrack-lanes">
      <div className="cp-multitrack-ruler-row"><div className="cp-multitrack-lane-heading">Track / mic owner</div><div ref={rulerRef} className="cp-multitrack-ruler" aria-hidden="true">{ruler.map((timecode, index) => <span key={index}>{timecode}</span>)}</div></div>
      {visibleLanes(document, expanded).map((track) => {
        const child = alternativeLane(document, track.id), ready = laneReady(document, track.id);
        const children = document.manifest.graph?.lanes.filter(lane => lane.parent_track_id === track.id).length ?? 0;
        const detailPeaks = detail?.start === viewStart && detail.span === span ? detail.peaks[track.id] : undefined;
        const peaks = detailPeaks ?? waveforms[track.id], detailed = !!detailPeaks;
        const cues = cuesByTrack.get(track.id) ?? [];
        return <div className={`cp-multitrack-lane${child ? " is-alternative" : ""}${!ready ? " is-unavailable" : ""}${solo.has(track.id) ? " is-solo" : solo.size ? " is-unsoloed" : ""}${muted.has(track.id) ? " is-muted" : ""}${textTracks.has(track.id) ? " has-text" : ""}`} key={track.id}
          onContextMenu={onTrackMenu ? (event) => { event.preventDefault(); const trigger = event.currentTarget.querySelector<HTMLButtonElement>(".cp-multitrack-track-menu-trigger"); trigger?.focus(); onTrackMenu(track.id, event.clientX, event.clientY); } : undefined}>
          <div className="cp-multitrack-lane-label">
            {children > 0 && <button className="cp-icon-btn cp-multitrack-disclosure" aria-label={`Alternative microphones for ${audioTrackLabel(document, track.id)}`} aria-expanded={expanded.has(track.id)} title={`${children} alternative microphones`} onClick={() => onExpand?.(track.id)}>{expanded.has(track.id) ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}</button>}
            {child && <span className="cp-multitrack-branch" title={laneMetadata(document, track.id)?.group_name ?? "Group alternative"}>↳</span>}
            <label className="cp-multitrack-check" title="Include in transcription"><input type="checkbox" disabled={!ready} checked={selected.has(track.id) && ready} onChange={() => onSelect(track.id)} aria-label={`Transcribe ${track.name}`} /><span>{audioTrackLabel(document, track.id)}</span></label>
            <TrackLabel key={trackOwner(document, track.id)} document={document} trackId={track.id} onRename={onRename} onOwnerMenu={onOwnerMenu} />
            <div className="cp-multitrack-track-switches"><button className="btn btn-ghost cp-multitrack-solo" disabled={!ready} aria-pressed={solo.has(track.id)} aria-label={`Solo ${track.name}`} title={`Solo ${trackOwner(document, track.id)}`} onClick={() => onSolo?.(track.id)}>S</button>
              <button className="btn btn-ghost cp-multitrack-solo" aria-pressed={muted.has(track.id)} aria-label={`Mute ${track.name}`} title={`Mute ${trackOwner(document, track.id)}`} onClick={() => onMute?.(track.id)}>M</button>
              <button className="btn btn-ghost cp-multitrack-text-toggle" aria-pressed={textTracks.has(track.id)} aria-label={`Text overlay ${track.name}`} title="Show transcript segments above the waveform" onClick={() => setTextTracks((prior) => { const next = new Set(prior); if (next.has(track.id)) next.delete(track.id); else next.add(track.id); return next; })}>Text</button>
              {onLevel && <MultitrackLevel owner={trackOwner(document, track.id)} value={levels[track.id] ?? 1} onChange={(value) => onLevel(track.id, value)} />}
              {onTrackMenu && <button className="btn btn-ghost cp-multitrack-track-menu-trigger" aria-label={`Track actions for ${trackOwner(document, track.id)}`} aria-haspopup="menu" onClick={(event) => { event.currentTarget.focus(); const bounds = event.currentTarget.getBoundingClientRect(); onTrackMenu(track.id, bounds.left, bounds.bottom); }}>⋯</button>}</div>
          </div>
          <div className="cp-multitrack-lane-audio" role="slider" tabIndex={0} aria-label={`Seek ${track.name}`} aria-valuemin={0} aria-valuemax={duration - 1} aria-valuenow={frame} aria-valuetext={playheadTimecode}
            onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); const target = pickFrame(event.clientX, event.currentTarget); gesture.current = { pointer: event.pointerId, resume: playing, frame: target }; setDragging(true); onScrub?.(target); }}
            onPointerMove={(event) => { const target = pickFrame(event.clientX, event.currentTarget); setHover(target); if (gesture.current?.pointer === event.pointerId) { gesture.current.frame = target; onScrub?.(target); } }}
            onPointerUp={(event) => { if (gesture.current) gesture.current.frame = pickFrame(event.clientX, event.currentTarget); endGesture(event.pointerId); }}
            onPointerCancel={(event) => endGesture(event.pointerId, true)} onLostPointerCapture={(event) => endGesture(event.pointerId, true)} onPointerLeave={() => setHover(null)}
            onKeyDown={(event) => { const targets: Record<string, number> = { ArrowLeft: frame - (event.shiftKey ? 10 : 1), ArrowRight: frame + (event.shiftKey ? 10 : 1), Home: 0, End: duration - 1 }; if (event.key in targets) { event.preventDefault(); event.stopPropagation(); onSeek(clampFrame(targets[event.key], duration)); } }}>
            {clipsByTrack.get(track.id)?.map((style, clipIndex) => <span className="cp-multitrack-clip" key={clipIndex} style={style} />)}
            {!ready ? <span className="cp-multitrack-waveform-note">{laneStatus(document, track.id)}</span> : showWaveforms && (peaks ? <MultitrackWaveform peaks={peaks} from={detailed ? 0 : viewStart / duration} to={detailed ? 1 : viewEnd / duration} gain={levels[track.id] ?? 1} /> : <span className="cp-multitrack-waveform-note">{waveformErrors[track.id] ? "Waveform unavailable" : "Preparing waveform…"}</span>)}
            {textTracks.has(track.id) && <div className="cp-multitrack-text-overlay">{cues.length ? cues.map((cue) => <span className={cue.summary ? "cp-multitrack-text-summary" : undefined} key={cue.id} title={cue.title} style={cue.style}>{cue.text}</span>) : <span className="cp-multitrack-no-text">No transcript in this view</span>}</div>}
            {hover !== null && <span className="cp-multitrack-cursor" style={{ left: `${(hover - viewStart) / span * 100}%` }} />}
            {frame >= viewStart && frame < viewEnd && <span className="cp-multitrack-playhead" style={{ left: `${(frame - viewStart) / span * 100}%` }} />}
          </div>
        </div>;
      })}
    </div>
    {zoom > 1 && <div className="cp-multitrack-pan"><button className="btn btn-ghost" aria-label="Pan timeline left" onClick={() => setStart(Math.max(0, Math.floor(viewStart - span / 2)))}>‹</button><input aria-label="Timeline position" type="range" min={0} max={Math.max(0, duration - span)} value={viewStart} onChange={(event) => setStart(Number(event.target.value))} /><button className="btn btn-ghost" aria-label="Pan timeline right" onClick={() => setStart(Math.min(duration - span, Math.floor(viewStart + span / 2)))}>›</button><button className="btn btn-ghost" onClick={() => moveZoom(zoom)}>Playhead</button></div>}
  </section>;
}
