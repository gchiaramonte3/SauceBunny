import { useEffect, useMemo, useRef, useState } from "react";
import type { FrameStore } from "../lib/frame-store";
import { EditTimelinePlayhead } from "./EditTimelinePlayhead";
import { editTc } from "../lib/edit-document";
import { fitScale, TIMELINE_RUNWAY_SECONDS } from "../lib/edit-timeline-scale";
import type { Timeline, PlacedWord, Seam } from "../lib/edit-model";
import { placementKey, programDuration } from "../lib/edit-model";
import { EditDeadLayer } from "./EditDeadLayer";
import { EditDeadSpaceBar, type EditDeadPreset, type EditDeadReview } from "./EditDeadSpaceBar";
import { EditTimelineTools, type EditTimelineAudio, type EditTimelineView } from "./EditTimelineTools";
import type { EditRowsView } from "./EditSourceTimeline";
import { EditTimelineEmpty } from "./EditTimelineEmpty";
import { EditTimelineRuler, type EditRulerMarkers } from "./EditTimelineRuler";

type ToolProps = Omit<React.ComponentProps<typeof EditTimelineTools>, "allText" | "onAllText" | "view" | "onView" | "measuring" | "audio" | "onAudio" | "zoom" | "onZoom">;

type Props = {
  edit: Timeline; seams: Seam[]; placed: PlacedWord[]; selection: Set<string>;
  /** The playhead, in frames: only the line drawing it follows each frame (EditTimelinePlayhead). */
  frames: FrameStore; fps: number; recordStart: number;
  onSeek: (program: number) => void;
  /** Where the source has nothing to say yet: sources with mics in the string out. */
  sources: string[];
  onScrubStart: () => void; onScrubEnd: () => void;
  /** Pixels per frame, as Avid and Neo scale a timeline (0 fits what is shown), the zoom, and Fit's measure. */
  zoom: number; onZoom: (direction: -1 | 0 | 1) => void; fit?: React.MutableRefObject<() => number>;
  /** Where the view starts, in seconds, and scrolling it. */
  pan: number; onPan: (seconds: number) => void;
  markers: EditRulerMarkers; tools: ToolProps; audio: EditTimelineAudio; onAudio: (audio: EditTimelineAudio) => void;
  dead: EditDeadReview | null; onDeadSkip: (index: number) => void; onDeadPreset: (preset: EditDeadPreset) => void; onDeadApply: () => void; onDeadCancel: () => void;
  /** View ▸ Waveforms lives above: turning it on is what builds them. */
  waveforms: boolean; onWaveforms: (on: boolean) => void; measuring: boolean;
  /** Over the track headers: the Source/Record switch. */ corner?: React.ReactNode;
  /** The tracks: the record's (A1…) or the source sequence's mics, each with the id T toggles it by. */
  rowIds: string[]; rows: (view: EditRowsView) => React.ReactNode;
};

/**
 * The magnetic timeline: one track per speaker, and every clip is a segment
 * of the edit playing on all of them at once, so a cut in the text closes up
 * here by construction. A gap is a segment too (Lift leaves one), drawn as
 * empty time across every lane.
 * Each lane wears its speaker's colour, so who is talking reads across the
 * whole scene at a glance; View ▸ Speaker colours off draws them the way
 * AAF Audio does (one violet). Either way a soloed track lifts and the rest
 * go grey. T puts a track's words over its waveform where they are said,
 * with the same layout AAF Audio uses.
 * It never scrolls sideways on its own: zoom, then pan with the slider, so a
 * Mac that always shows scrollbars does not grow one across the tracks.
 */
export function EditTimeline(props: Props) {
  const { rowIds, edit, placed, selection, fps, seams, zoom } = props;
  const { marks, snap, follow } = props.tools;
  const [look, setLook] = useState<Omit<EditTimelineView, "waveforms">>({ speakerColours: true, height: "medium" });
  const view: EditTimelineView = { ...look, waveforms: props.waveforms };
  const setView = ({ waveforms, ...next }: EditTimelineView) => { setLook(next); if (waveforms !== props.waveforms) props.onWaveforms(waveforms); };
  const [text, setText] = useState<Set<string>>(new Set());
  const [width, setWidth] = useState(800);
  const ruler = useRef<HTMLDivElement>(null);
  const total = programDuration(edit);
  const pxPerFrame = zoom > 0 ? zoom : fitScale(width, total, fps);
  const span = width / (pxPerFrame * fps);
  // How far the view can scroll: the edit and its runway, or, fitted, just what fits.
  const extent = zoom > 0 ? Math.max(total + TIMELINE_RUNWAY_SECONDS, span) : span;
  const start = Math.max(0, Math.min(props.pan, extent - span));
  const setPan = props.onPan;
  const x = (t: number) => `${((t - start) / span) * 100}%`;
  const w = (d: number) => `${(d / span) * 100}%`;
  useEffect(() => {
    const element = ruler.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => { if (entry.contentRect.width > 0) setWidth(Math.round(entry.contentRect.width)); });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Zooming centres on the playhead; following turns the page when it runs off (EditTimelinePlayhead).
  const latest = useRef({ frames: props.frames, span, onPan: props.onPan }); latest.current = { frames: props.frames, span, onPan: props.onPan };
  useEffect(() => { latest.current.onPan(Math.max(0, latest.current.frames.get() / fps - latest.current.span / 2)); }, [zoom, fps]);
  // Fit (⇧Z, or the button) measures this view, which only it can.
  useEffect(() => { if (props.fit) props.fit.current = () => fitScale(width, total, fps); }, [props.fit, width, total, fps]);
  const held = useRef(false);
  const chosen = placed.filter((item) => selection.has(placementKey(item)));
  const band = chosen.length ? [Math.min(...chosen.map((i) => i.programStart)), Math.max(...chosen.map((i) => i.programEnd))] : null;
  // Snap pulls a scrub onto an edit point, a marker, a mark or a word edge within 8 px.
  const targets = useMemo(() => [0, total, ...seams.map((s) => s.at), ...props.markers.list.map((m) => m.at), ...(marks.in != null ? [marks.in] : []), ...(marks.out != null ? [marks.out] : []),
    ...placed.flatMap((item) => [item.programStart, item.programEnd])], [total, seams, props.markers, marks.in, marks.out, placed]);
  // Scrub: press anywhere on the ruler or a lane and drag. The playhead
  // follows every pointer move, and playback waits until you let go.
  const position = (event: React.PointerEvent<HTMLElement>) => {
    const box = (event.currentTarget.closest(".cp-te-tl-grid") as HTMLElement).querySelector(".cp-te-tl-ruler")!.getBoundingClientRect();
    const at = Math.max(0, Math.min(total, start + ((event.clientX - box.left) / box.width) * span));
    if (!snap) return at;
    const reach = (8 / box.width) * span;
    const near = targets.reduce((best, t) => Math.abs(t - at) < Math.abs(best - at) ? t : best, Infinity);
    return Math.abs(near - at) <= reach ? near : at;
  };
  const scrub = {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      held.current = true;
      props.onScrubStart();
      props.onSeek(position(event));
    },
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => { if (held.current) props.onSeek(position(event)); },
    onPointerUp: () => { if (held.current) { held.current = false; props.onScrubEnd(); } },
    onPointerCancel: () => { if (held.current) { held.current = false; props.onScrubEnd(); } },
  };
  const toggleText = (id: string) => setText((current) => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; });
  const audio = props.audio;
  return <section className={`cp-te-timeline is-${view.height}${view.speakerColours ? " is-speaker" : ""}`} aria-label="Edit timeline">
    <EditTimelineTools {...props.tools} zoom={pxPerFrame} onZoom={props.onZoom}
      view={view} onView={setView} measuring={props.measuring} audio={audio} onAudio={props.onAudio}
      allText={rowIds.length > 0 && rowIds.every((id) => text.has(id))} onAllText={() => setText(rowIds.every((id) => text.has(id)) ? new Set() : new Set(rowIds))} />
    {props.dead && <EditDeadSpaceBar review={props.dead} onPreset={props.onDeadPreset} onApply={props.onDeadApply} onCancel={props.onDeadCancel} />}
    <div className="cp-te-tl-grid" style={{ "--te-rows": rowIds.length + 1 } as React.CSSProperties}>
      <div className="cp-te-tl-corner">{props.corner}</div>
      <EditTimelineRuler rulerRef={ruler} fps={fps} recordStart={props.recordStart} start={start} span={span} x={x} w={w} width={width} marks={marks} onClearMarks={props.tools.onClearMarks} markers={props.markers}
        scrub={scrub} />
      {props.rows({ start, span, width, x, w, scrub, waveforms: view.waveforms, text, onText: toggleText, pan: (to) => setPan(Math.max(0, Math.min(to, extent - span))) })}
      {edit.segments.length === 0 && <EditTimelineEmpty sources={props.sources} />}
      <div className="cp-te-tl-overlay" aria-hidden="true">
        {band && <span className="cp-te-tl-band" style={{ left: x(band[0]), width: w(band[1] - band[0]) }} />}
        <EditTimelinePlayhead frames={props.frames} fps={fps} start={start} span={span} follow={follow && extent > span} onRunOff={setPan} />
      </div>
      {props.dead && <EditDeadLayer review={props.dead} x={x} w={w} at={(seconds) => editTc(seconds, fps, props.recordStart)} onSkip={props.onDeadSkip} />}
    </div>
    {extent > span && <input className="cp-te-tl-pan" type="range" aria-label="Scroll timeline" min={0} max={extent - span} step={0.01} value={start} onChange={(event) => setPan(Number(event.target.value))} />}
  </section>;
}
