import type { Ref } from "react";
import { editTc } from "../lib/edit-document";
import type { Seam } from "../lib/edit-model";
import { RulerMarks } from "./RulerMarks";

/** Markers on the ruler: each can be clicked to select it (the Inspector edits it) and removed with Delete. */
export type EditRulerMarkers = { list: { id: string; at: number; name: string }[]; selected?: string | null; onSelect?: (id: string) => void; onRemove?: (id: string) => void };
type Scrub = Pick<React.HTMLAttributes<HTMLElement>, "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel">;
type Props = {
  rulerRef: Ref<HTMLDivElement>; fps: number; recordStart: number; start: number; span: number; x: (t: number) => string; w: (d: number) => string;
  /** The ruler's width in pixels, which decides how many timecodes fit. */
  width: number;
  marks: { in: number | null; out: number | null }; markers: EditRulerMarkers; seams: Seam[]; seam: number | null; describe: (cut: Seam) => string; onSeam: (cut: Seam) => void; scrub: Scrub;
  onClearMarks?: () => void;
};

/** Room for one timecode label ("01:00:00:00") and a gap before the next. */
const TICK_PX = 104;
/** Tick steps in timecode seconds, one second up to two hours. */
const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

/** Record timecode, the In to Out span, markers and edit points you can click. */
export function EditTimelineRuler({ rulerRef, fps, recordStart, start, span, x, w, width, marks, markers, seams, seam, describe, onSeam, scrub, onClearMarks }: Props) {
  // Ticks on whole timecode seconds (at 23.976 not whole seconds of media), as
  // many as fit a timecode apiece: zoomed out on a two-hour cut the steps grow
  // to minutes and hours instead of stacking 68 timecodes on top of each other.
  const second = Math.round(fps) / fps;
  const fit = Math.max(2, Math.floor(width / TICK_PX));
  const step = (STEPS.find((s) => span / (s * second) <= fit) ?? STEPS[STEPS.length - 1]) * second;
  const ticks = Array.from({ length: Math.floor(span / step) + 2 }, (_, i) => (Math.floor(start / step) + i) * step)
    .filter((t) => t >= start && t <= start + span * 0.94);
  return <div ref={rulerRef} className="cp-te-tl-ruler" {...scrub}>
    {ticks.map((t) => <span key={t} className="cp-te-tl-tick" style={{ left: x(t) }}>{editTc(t, fps, recordStart)}</span>)}
    <RulerMarks from={marks.in} to={marks.out} x={x} w={w} rangeClass="cp-te-tl-marked" onClear={onClearMarks} />
    {markers.list.filter((m) => m.at >= start && m.at <= start + span).map((m) => {
      const label = `Marker ${m.name} at ${editTc(m.at, fps, recordStart)}`;
      return markers.onSelect ? <button key={m.id} type="button" className={`cp-te-tl-marker${markers.selected === m.id ? " is-selected" : ""}`} style={{ left: x(m.at) }}
        aria-label={label} aria-pressed={markers.selected === m.id} title={`${label} · Delete removes it`} onPointerDown={(event) => event.stopPropagation()}
        onClick={() => markers.onSelect?.(m.id)} onKeyDown={(event) => { if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); event.stopPropagation(); markers.onRemove?.(m.id); } }} />
        : <span key={m.id} className="cp-te-tl-marker" style={{ left: x(m.at) }} title={label} />;
    })}
    {seams.filter((cut) => cut.at >= start && cut.at <= start + span).map((cut) => <button key={cut.index} type="button"
      className={`cp-te-tl-seam-mark${seam === cut.index ? " is-selected" : ""}${cut.clipped.size ? " is-clipped" : ""}`} style={{ left: x(cut.at) }}
      aria-pressed={seam === cut.index} aria-label={describe(cut)} title={describe(cut)} onClick={() => onSeam(cut)} />)}
  </div>;
}
