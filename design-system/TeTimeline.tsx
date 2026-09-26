import { useMemo, useState } from "react";
import { teTc } from "./transcript-editor-fixture";
import type { TeEdit, TePlacedWord, TeSeam, TeSpeaker } from "./transcript-editor-model";
import { placementKey, programDuration, segmentLength, segmentStarts } from "./transcript-editor-model";
import { TeWave } from "./TeWave";

type Props = {
  speakers: TeSpeaker[]; edit: TeEdit; seams: TeSeam[]; placed: TePlacedWord[]; selection: Set<string>;
  playhead: number; fps: number; colors: Record<string, string>; solo: Set<string>; mute: Set<string>;
  onSeek: (program: number) => void; onSolo: (speaker: string) => void; onMute: (speaker: string) => void;
  seam: number | null; onSeam: (segment: number) => void;
};

const describe = (seam: TeSeam, fps: number) => `${seam.kind === "cut" ? "Cut" : seam.kind === "through" ? "Through edit" : "Jump"} at ${teTc(seam.at, fps)}`
  + (seam.kind === "cut" ? `, ${seam.gap.toFixed(2)} s removed` : seam.kind === "jump" ? `, ${seam.gap < 0 ? "back" : "ahead"} ${Math.abs(seam.gap).toFixed(1)} s in the scene` : "")
  + (seam.clipped.size ? ", cuts into a word" : "");

/**
 * The magnetic timeline: one track per speaker, and every clip is a segment
 * of the edit playing on all of them at once. There is no gap to leave, so
 * there is no gap tool; a cut in the text closes up here by construction.
 * It never scrolls sideways on its own: zoom, then pan with the slider, so a
 * Mac that always shows scrollbars does not grow one across the tracks.
 */
export function TeTimeline(props: Props) {
  const { speakers, edit, placed, selection, playhead, fps, colors, solo, mute, seams } = props;
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState(0);
  const total = Math.max(0.001, programDuration(edit));
  const span = total / zoom;
  const start = Math.min(pan, Math.max(0, total - span));
  const x = (t: number) => `${((t - start) / span) * 100}%`;
  const w = (d: number) => `${(d / span) * 100}%`;
  const starts = segmentStarts(edit);
  const mutes = useMemo(() => Object.fromEntries(speakers.map((s) => [s.id,
    edit.mutes.filter((m) => m.speaker === s.id).map((m): [number, number] => [m.srcIn, m.srcOut])])), [edit.mutes, speakers]);
  const chosen = placed.filter((item) => selection.has(placementKey(item)));
  const band = chosen.length ? [Math.min(...chosen.map((i) => i.programStart)), Math.max(...chosen.map((i) => i.programEnd))] : null;
  // Ticks on whole timecode seconds, which at 23.976 are not whole seconds of media.
  const second = Math.round(fps) / fps;
  const step = ([1, 2, 5, 10, 15, 30, 60].find((s) => span / (s * second) <= 8) ?? 120) * second;
  const ticks = Array.from({ length: Math.floor(span / step) + 2 }, (_, i) => (Math.floor(start / step) + i) * step)
    .filter((t) => t >= start && t <= start + span * 0.94);
  const seek = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    const box = event.currentTarget.getBoundingClientRect();
    props.onSeek(Math.max(0, Math.min(total, start + ((event.clientX - box.left) / box.width) * span)));
  };
  return <section className="cp-te-timeline" aria-label="Edit timeline">
    <div className="cp-te-tl-bar">
      <h2 className="cp-te-tl-title">Timeline</h2>
      <span className="cp-te-tl-note">{seams.length === 0 ? "No edits yet. Delete words in the transcript and every track closes up."
        : `${edit.segments.length} clips per track · ${seams.length} edit ${seams.length === 1 ? "point" : "points"} · magnetic`}</span>
      <div className="cp-te-tl-zoom" role="group" aria-label="Timeline zoom">
        <button type="button" className="cp-icon-btn" aria-label="Zoom out" title="Zoom out" disabled={zoom <= 1} onClick={() => setZoom((z) => Math.max(1, z / 2))}>−</button>
        <button type="button" className="btn btn-ghost cp-te-btn cp-te-tl-fit" disabled={zoom === 1} onClick={() => { setZoom(1); setPan(0); }}>Fit</button>
        <button type="button" className="cp-icon-btn" aria-label="Zoom in" title="Zoom in" disabled={zoom >= 32} onClick={() => { setZoom((z) => Math.min(32, z * 2)); setPan(Math.max(0, playhead - total / zoom / 4)); }}>+</button>
      </div>
    </div>
    <div className="cp-te-tl-grid" style={{ "--te-lanes": speakers.length } as React.CSSProperties}>
      <div className="cp-te-tl-corner" aria-hidden="true" />
      <div className="cp-te-tl-ruler" onPointerDown={seek}>
        {ticks.map((t) => <span key={t} className="cp-te-tl-tick" style={{ left: x(t) }}>{teTc(t, fps)}</span>)}
        {seams.filter((cut) => cut.at >= start && cut.at <= start + span).map((cut) => <button key={cut.index} type="button"
          className={`cp-te-tl-seam-mark${props.seam === cut.index ? " is-selected" : ""}${cut.clipped.size ? " is-clipped" : ""}`} style={{ left: x(cut.at) }}
          aria-pressed={props.seam === cut.index} aria-label={describe(cut, fps)} title={describe(cut, fps)}
          onClick={() => { props.onSeek(cut.at); props.onSeam(cut.index); }} />)}
      </div>
      {speakers.map((speaker) => <div key={speaker.id} className="cp-te-tl-row" style={{ "--te-speaker": colors[speaker.id] } as React.CSSProperties}>
        <div className="cp-te-tl-head">
          <span className="cp-te-tl-track">A{speaker.track}</span><span className="cp-te-tl-name">{speaker.name}</span>
          <button type="button" className={`cp-te-tl-toggle${solo.has(speaker.id) ? " on" : ""}`} aria-pressed={solo.has(speaker.id)} aria-label={`Solo ${speaker.name}`} title={`Solo ${speaker.name}`} onClick={() => props.onSolo(speaker.id)}>S</button>
          <button type="button" className={`cp-te-tl-toggle${mute.has(speaker.id) ? " on" : ""}`} aria-pressed={mute.has(speaker.id)} aria-label={`Mute ${speaker.name}`} title={`Mute ${speaker.name}`} onClick={() => props.onMute(speaker.id)}>M</button>
        </div>
        <div className={`cp-te-tl-lane${mute.has(speaker.id) || (solo.size > 0 && !solo.has(speaker.id)) ? " is-quiet" : ""}`} onPointerDown={seek}>
          {edit.segments.map((segment, index) => starts[index] + segmentLength(segment) < start || starts[index] > start + span ? null
            : <div key={segment.id} className="cp-te-tl-clip" style={{ left: x(starts[index]), width: w(segmentLength(segment)) }}>
              <TeWave speaker={speaker.id} srcIn={segment.srcIn} srcOut={segment.srcOut} muted={mutes[speaker.id]} />
            </div>)}
          {seams.filter((cut) => cut.clipped.has(speaker.id)).map((cut) => <span key={cut.index} className="cp-te-tl-clipped" style={{ left: x(cut.at) }} title={`A word of ${speaker.name}'s is cut at this edit`} />)}
        </div>
      </div>)}
      <div className="cp-te-tl-overlay" aria-hidden="true">
        {band && <span className="cp-te-tl-band" style={{ left: x(band[0]), width: w(band[1] - band[0]) }} />}
        {seams.map((cut) => <span key={cut.index} className={`cp-te-tl-seam${cut.kind === "through" ? " is-through" : ""}${props.seam === cut.index ? " is-selected" : ""}`} style={{ left: x(cut.at) }} />)}
        <span className="cp-te-tl-playhead" style={{ left: x(playhead) }} />
      </div>
    </div>
    {zoom > 1 && <input className="cp-te-tl-pan" type="range" aria-label="Scroll timeline" min={0} max={Math.max(0, total - span)} step={0.01} value={start} onChange={(event) => setPan(Number(event.target.value))} />}
  </section>;
}
