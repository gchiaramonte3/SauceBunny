import { useEffect, useMemo, useRef, useState } from "react";
import { editTc } from "../lib/edit-document";
import type { Timeline, PlacedWord, Seam, TimelineLane } from "../lib/edit-model";
import { isGap, phraseLabels, placementKey, programDuration, segmentLength, segmentStarts } from "../lib/edit-model";
import { EditDeadLayer } from "./EditDeadLayer";
import { EditDeadSpaceBar, type EditDeadPreset, type EditDeadReview } from "./EditDeadSpaceBar";
import { EditTimelineTools, type EditTimelineAudio, type EditTimelineView } from "./EditTimelineTools";
import { EditPatchRow } from "./EditPatchRow";
import { EditPictureRow } from "./EditPictureRow";
import type { EditRowsView } from "./EditSourceTimeline";
import { EditTimelineEmpty } from "./EditTimelineEmpty";
import { EditTimelineRow } from "./EditTimelineRow";
import { EditTimelineRuler, type EditRulerMarkers } from "./EditTimelineRuler";

type ToolProps = Omit<React.ComponentProps<typeof EditTimelineTools>, "allText" | "onAllText" | "view" | "onView" | "measuring" | "audio" | "onAudio" | "zoom" | "onZoom">;

type Props = {
  speakers: TimelineLane[]; edit: Timeline; seams: Seam[]; placed: PlacedWord[]; selection: Set<string>;
  playhead: number; fps: number; recordStart: number; colors: Record<string, string>; solo: Set<string>; mute: Set<string>;
  onSeek: (program: number) => void; onSolo: (speaker: string) => void; onMute: (speaker: string) => void; onUntrack?: (speaker: string) => void;
  seam: number | null; onSeam: (segment: number) => void;
  /** Which speakers each source has a mic for: a lane with no mic in a source shows filler there. */
  sourceSpeakers: Record<string, string[]>; sourceName: (id: string) => string;
  /** A source track's overview peaks and the source's length in seconds, for the clip waveforms. */
  peaksOf: (source: string, speaker: string) => [number, number][] | undefined; durationOf: (source: string) => number;
  pictureOf?: React.ComponentProps<typeof EditPictureRow>["pictureOf"];
  onScrubStart: () => void; onScrubEnd: () => void;
  zoom: number; onZoom: (zoom: number) => void; markers: EditRulerMarkers; tools: ToolProps; audio: EditTimelineAudio; onAudio: (audio: EditTimelineAudio) => void;
  /** Avid's track selectors: on tracks take Lift and show the marked region. */
  tracks: Set<string>; onTrack: (speaker: string, only: boolean) => void;
  dead: EditDeadReview | null; onDeadSkip: (index: number) => void; onDeadPreset: (preset: EditDeadPreset) => void; onDeadApply: () => void; onDeadCancel: () => void;
  /** View ▸ Waveforms lives above: turning it on is what builds them. */
  waveforms: boolean; onWaveforms: (on: boolean) => void; measuring: boolean;
  /** Cut a whole source in as the first clip of an empty string out. */
  onAddWhole?: (source: string) => void;
  /** Over the track headers: the Source/Record switch. */ corner?: React.ReactNode;
  /** The Source view's own rows (the sequence's mics), drawn in place of one row per speaker; `speakers` then names them for T. */ rows?: (view: EditRowsView) => React.ReactNode;
  /** Record view: the patch panel, everyone who can be put on a track and doing it. */ patch?: React.ComponentProps<typeof EditTimelineRow>["patch"];
};

const describe = (seam: Seam, fps: number, recordStart: number) => `${seam.kind === "cut" ? "Cut" : seam.kind === "through" ? "Through edit" : seam.kind === "gap" ? "Gap" : "Jump"} at ${editTc(seam.at, fps, recordStart)}`
  + (seam.kind === "cut" ? `, ${seam.gap.toFixed(2)} s removed` : seam.kind === "jump" ? (Number.isNaN(seam.gap) ? ", to another source" : `, ${seam.gap < 0 ? "back" : "ahead"} ${Math.abs(seam.gap).toFixed(1)} s in the scene`) : "")
  + (seam.clipped.size ? ", cuts into a word" : "");

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
  const { speakers, edit, placed, selection, playhead, fps, colors, solo, mute, seams, zoom } = props;
  const { marks, snap, follow } = props.tools;
  const [pan, setPan] = useState(0);
  const [look, setLook] = useState<Omit<EditTimelineView, "waveforms">>({ speakerColours: true, height: "medium" });
  const view: EditTimelineView = { ...look, waveforms: props.waveforms };
  const setView = ({ waveforms, ...next }: EditTimelineView) => { setLook(next); if (waveforms !== props.waveforms) props.onWaveforms(waveforms); };
  const [text, setText] = useState<Set<string>>(new Set());
  const [width, setWidth] = useState(800);
  const ruler = useRef<HTMLDivElement>(null);
  const total = Math.max(0.001, programDuration(edit));
  const span = total / zoom;
  const start = Math.min(pan, Math.max(0, total - span));
  const x = (t: number) => `${((t - start) / span) * 100}%`;
  const w = (d: number) => `${(d / span) * 100}%`;
  const starts = segmentStarts(edit);
  useEffect(() => {
    const element = ruler.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => { if (entry.contentRect.width > 0) setWidth(Math.round(entry.contentRect.width)); });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Zooming centres on the playhead; following turns the page when it runs off.
  const latest = useRef({ playhead, total });
  latest.current = { playhead, total };
  useEffect(() => { setPan(Math.max(0, latest.current.playhead - latest.current.total / zoom / 2)); }, [zoom]);
  useEffect(() => { if (follow && zoom > 1 && (playhead < start || playhead > start + span)) setPan(playhead); }, [follow, zoom, playhead, start, span]);
  const mutes = useMemo(() => Object.fromEntries(speakers.flatMap((s) => Object.keys(props.sourceSpeakers).map((source) => [`${source}:${s.id}`,
    edit.mutes.filter((m) => m.track === s.id && m.source === source).map((m): [number, number] => [m.srcIn, m.srcOut])]))), [edit.mutes, speakers, props.sourceSpeakers]);
  const words = useMemo(() => Object.fromEntries(speakers.filter((s) => text.has(s.id)).map((s) => [s.id, phraseLabels(placed, s.id, start, span, width)])),
    [speakers, text, placed, start, span, width]);
  const held = useRef(false);
  const chosen = placed.filter((item) => selection.has(placementKey(item)));
  const band = chosen.length ? [Math.min(...chosen.map((i) => i.programStart)), Math.max(...chosen.map((i) => i.programEnd))] : null;
  const marked = marks.in != null && marks.out != null && marks.out > marks.in ? [marks.in, marks.out] : null;
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
  const audio = props.audio, fade = audio.crossfade / fps;
  return <section className={`cp-te-timeline is-${view.height}${view.speakerColours ? " is-speaker" : ""}`} aria-label="Edit timeline">
    <EditTimelineTools {...props.tools} zoom={zoom} onZoom={(direction) => props.onZoom(direction === 0 ? 1 : Math.max(1, Math.min(32, direction > 0 ? zoom * 2 : zoom / 2)))}
      view={view} onView={setView} measuring={props.measuring} audio={audio} onAudio={props.onAudio}
      allText={speakers.every((s) => text.has(s.id))} onAllText={() => setText(speakers.every((s) => text.has(s.id)) ? new Set() : new Set(speakers.map((s) => s.id)))} />
    {props.dead && <EditDeadSpaceBar review={props.dead} onPreset={props.onDeadPreset} onApply={props.onDeadApply} onCancel={props.onDeadCancel} />}
    <div className="cp-te-tl-grid" style={{ "--te-rows": speakers.length + (props.patch ? 2 : 1) + (props.pictureOf && edit.segments.some((segment) => !isGap(segment) && props.pictureOf?.(segment.source).length) ? 1 : 0) } as React.CSSProperties}>
      <div className="cp-te-tl-corner">{props.corner}</div>
      <EditTimelineRuler rulerRef={ruler} fps={fps} recordStart={props.recordStart} start={start} span={span} x={x} w={w} width={width} marks={marks} onClearMarks={props.tools.onClearMarks} markers={props.markers}
        seams={seams} seam={props.seam} describe={(cut) => describe(cut, fps, props.recordStart)} onSeam={(cut) => { props.onSeek(cut.at); props.onSeam(cut.index); }} scrub={scrub} />
      {props.pictureOf && <EditPictureRow edit={edit} starts={starts} start={start} span={span} x={x} w={w} pictureOf={props.pictureOf} />}
      {props.rows ? props.rows({ start, span, width, x, w, scrub, waveforms: view.waveforms, text, onText: toggleText }) : speakers.map((speaker) => <EditTimelineRow key={speaker.id} speaker={speaker} color={colors[speaker.id]} soloed={solo.has(speaker.id)} quiet={solo.size > 0 && !solo.has(speaker.id)}
        muted={mute.has(speaker.id)} shown={text.has(speaker.id)} cues={words[speaker.id] ?? []} selected={props.tracks.has(speaker.id)}
        onTrack={props.onTrack} onSolo={props.onSolo} onMute={props.onMute} onText={toggleText} onUntrack={props.onUntrack}
        edit={edit} starts={starts} start={start} span={span} x={x} w={w} sourceSpeakers={props.sourceSpeakers} sourceName={props.sourceName}
        waveforms={view.waveforms} peaksOf={props.peaksOf} durationOf={props.durationOf} mutes={mutes} marked={marked} seams={seams} scrub={scrub} patch={props.patch} />)}
      {!props.rows && props.patch && <EditPatchRow people={props.patch.people} next={speakers.length} onPatch={props.patch.onPatch} />}
      {edit.segments.length === 0 && <EditTimelineEmpty sources={Object.keys(props.sourceSpeakers)} sourceName={props.sourceName} durationOf={props.durationOf} onAddWhole={props.onAddWhole} />}
      <div className="cp-te-tl-overlay" aria-hidden="true">
        {edit.segments.map((segment, index) => isGap(segment) && <span key={segment.id} className="cp-te-tl-gap" style={{ left: x(starts[index]), width: w(segmentLength(segment)) }} />)}
        {band && <span className="cp-te-tl-band" style={{ left: x(band[0]), width: w(band[1] - band[0]) }} />}
        {seams.map((cut) => <span key={cut.index} className={`cp-te-tl-seam${cut.kind === "through" ? " is-through" : ""}${props.seam === cut.index ? " is-selected" : ""}`} style={{ left: x(cut.at) }} />)}
        {fade > 0 && seams.filter((cut) => cut.kind !== "through").map((cut) => <span key={`f${cut.index}`} className="cp-te-tl-fade" style={{ left: x(cut.at - fade / 2), width: w(fade) }} />)}
        <span className="cp-te-tl-playhead" style={{ left: x(playhead) }} />
      </div>
      {props.dead && <EditDeadLayer review={props.dead} x={x} w={w} at={(seconds) => editTc(seconds, fps, props.recordStart)} onSkip={props.onDeadSkip} />}
    </div>
    {zoom > 1 && <input className="cp-te-tl-pan" type="range" aria-label="Scroll timeline" min={0} max={Math.max(0, total - span)} step={0.01} value={start} onChange={(event) => setPan(Number(event.target.value))} />}
  </section>;
}
