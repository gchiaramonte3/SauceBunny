import type { Ref } from "react";
import { editTc } from "../lib/edit-document";
import type { Seam } from "../lib/edit-model";

type Scrub = Pick<React.HTMLAttributes<HTMLElement>, "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel">;
type Props = {
  rulerRef: Ref<HTMLDivElement>; fps: number; recordStart: number; start: number; span: number; x: (t: number) => string; w: (d: number) => string;
  marked: number[] | null; markers: number[]; seams: Seam[]; seam: number | null; describe: (cut: Seam) => string; onSeam: (cut: Seam) => void; scrub: Scrub;
};

/** Record timecode, the In to Out span, markers and edit points you can click. */
export function EditTimelineRuler({ rulerRef, fps, recordStart, start, span, x, w, marked, markers, seams, seam, describe, onSeam, scrub }: Props) {
  // Ticks on whole timecode seconds, which at 23.976 are not whole seconds of media.
  const second = Math.round(fps) / fps;
  const step = ([1, 2, 5, 10, 15, 30, 60].find((s) => span / (s * second) <= 8) ?? 120) * second;
  const ticks = Array.from({ length: Math.floor(span / step) + 2 }, (_, i) => (Math.floor(start / step) + i) * step)
    .filter((t) => t >= start && t <= start + span * 0.94);
  return <div ref={rulerRef} className="cp-te-tl-ruler" {...scrub}>
    {ticks.map((t) => <span key={t} className="cp-te-tl-tick" style={{ left: x(t) }}>{editTc(t, fps, recordStart)}</span>)}
    {marked && <span className="cp-te-tl-marked" style={{ left: x(marked[0]), width: w(marked[1] - marked[0]) }} aria-hidden="true" />}
    {markers.filter((t) => t >= start && t <= start + span).map((t) => <span key={t} className="cp-te-tl-marker" style={{ left: x(t) }} title={`Marker at ${editTc(t, fps, recordStart)}`} />)}
    {seams.filter((cut) => cut.at >= start && cut.at <= start + span).map((cut) => <button key={cut.index} type="button"
      className={`cp-te-tl-seam-mark${seam === cut.index ? " is-selected" : ""}${cut.clipped.size ? " is-clipped" : ""}`} style={{ left: x(cut.at) }}
      aria-pressed={seam === cut.index} aria-label={describe(cut)} title={describe(cut)} onClick={() => onSeam(cut)} />)}
  </div>;
}
