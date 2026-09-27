import { useEffect, useMemo, useRef, useState } from "react";
import { multitrackTextLayout } from "../src/lib/multitrack-text-layout";
import { teTc } from "./transcript-editor-fixture";
import type { TeEdit, TePlacedWord, TeSeam, TeSpeaker } from "./transcript-editor-model";
import { placementKey, programDuration, segmentLength, segmentStarts } from "./transcript-editor-model";
import { TeTimelineTools, type TeTimelineAudio, type TeTimelineView } from "./TeTimelineTools";
import { TeWave } from "./TeWave";

type ToolProps = Omit<React.ComponentProps<typeof TeTimelineTools>, "allText" | "onAllText" | "view" | "onView" | "audio" | "onAudio" | "zoom" | "onZoom">;

type Props = {
  speakers: TeSpeaker[]; edit: TeEdit; seams: TeSeam[]; placed: TePlacedWord[]; selection: Set<string>;
  playhead: number; fps: number; colors: Record<string, string>; solo: Set<string>; mute: Set<string>;
  onSeek: (program: number) => void; onSolo: (speaker: string) => void; onMute: (speaker: string) => void;
  seam: number | null; onSeam: (segment: number) => void;
  /** Which speakers each source has a mic for: a lane with no mic in a source shows filler there. */
  sourceSpeakers: Record<string, string[]>; sourceName: (id: string) => string;
  onScrubStart: () => void; onScrubEnd: () => void;
  zoom: number; onZoom: (zoom: number) => void; markers: number[]; tools: ToolProps;
};

const describe = (seam: TeSeam, fps: number) => `${seam.kind === "cut" ? "Cut" : seam.kind === "through" ? "Through edit" : "Jump"} at ${teTc(seam.at, fps)}`
  + (seam.kind === "cut" ? `, ${seam.gap.toFixed(2)} s removed` : seam.kind === "jump" ? (Number.isNaN(seam.gap) ? ", to another source" : `, ${seam.gap < 0 ? "back" : "ahead"} ${Math.abs(seam.gap).toFixed(1)} s in the scene`) : "")
  + (seam.clipped.size ? ", cuts into a word" : "");

/** A speaker's words as lines: a new line at a pause over 1.2 s or an edit point. */
function phrases(placed: TePlacedWord[], speaker: string) {
  const out: { id: string; text: string; startFrame: number; endFrame: number; segment: number }[] = [];
  for (const item of placed) {
    if (item.word.speaker !== speaker || item.muted) continue;
    const last = out[out.length - 1];
    if (last && last.segment === item.segment && item.programStart - last.endFrame < 1.2) { last.text += ` ${item.word.text}`; last.endFrame = item.programEnd; }
    else out.push({ id: placementKey(item), text: item.word.text, startFrame: item.programStart, endFrame: item.programEnd, segment: item.segment });
  }
  return out;
}

/**
 * The magnetic timeline: one track per speaker, and every clip is a segment
 * of the edit playing on all of them at once. There is no gap to leave, so
 * there is no gap tool; a cut in the text closes up here by construction.
 * Lanes are drawn the way AAF Audio draws them (one violet, grey when
 * another track is soloed), and T puts a track's words over its waveform
 * where they are said, with the same layout AAF Audio uses.
 * It never scrolls sideways on its own: zoom, then pan with the slider, so a
 * Mac that always shows scrollbars does not grow one across the tracks.
 */
export function TeTimeline(props: Props) {
  const { speakers, edit, placed, selection, playhead, fps, colors, solo, mute, seams, zoom } = props;
  const { marks, snap, follow } = props.tools;
  const [pan, setPan] = useState(0);
  const [view, setView] = useState<TeTimelineView>({ waveforms: true, height: "medium" });
  const [audio, setAudio] = useState<TeTimelineAudio>({ crossfade: 2, roomTone: false });
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
    edit.mutes.filter((m) => m.speaker === s.id && m.source === source).map((m): [number, number] => [m.srcIn, m.srcOut])]))), [edit.mutes, speakers, props.sourceSpeakers]);
  // AAF Audio's layout, except that a column holding a single phrase shows the
  // phrase itself rather than "1 passage": the words are the point of T.
  const words = useMemo(() => Object.fromEntries(speakers.filter((s) => text.has(s.id)).map((s) => {
    const lines = phrases(placed, s.id);
    return [s.id, multitrackTextLayout(lines, start, span, width).map((cue) => {
      const line = cue.summary && cue.text === "1 passage" ? lines.find((item) => item.text === cue.title.split("\n")[1]) : undefined;
      if (!line) return cue;
      const from = Math.max(start, line.startFrame), to = Math.min(start + span, line.endFrame);
      return { ...cue, summary: false, text: line.text, style: { left: `${((from - start) / span) * 100}%`, width: `${((to - from) / span) * 100}%` } };
    })];
  })),
    [speakers, text, placed, start, span, width]);
  const held = useRef(false);
  const chosen = placed.filter((item) => selection.has(placementKey(item)));
  const band = chosen.length ? [Math.min(...chosen.map((i) => i.programStart)), Math.max(...chosen.map((i) => i.programEnd))] : null;
  const marked = marks.in != null && marks.out != null && marks.out > marks.in ? [marks.in, marks.out] : null;
  // Ticks on whole timecode seconds, which at 23.976 are not whole seconds of media.
  const second = Math.round(fps) / fps;
  const step = ([1, 2, 5, 10, 15, 30, 60].find((s) => span / (s * second) <= 8) ?? 120) * second;
  const ticks = Array.from({ length: Math.floor(span / step) + 2 }, (_, i) => (Math.floor(start / step) + i) * step)
    .filter((t) => t >= start && t <= start + span * 0.94);
  // Snap pulls a scrub onto an edit point, a marker, a mark or a word edge within 8 px.
  const targets = useMemo(() => [0, total, ...seams.map((s) => s.at), ...props.markers, ...(marks.in != null ? [marks.in] : []), ...(marks.out != null ? [marks.out] : []),
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
  const fade = audio.crossfade / fps;
  return <section className={`cp-te-timeline is-${view.height}`} aria-label="Edit timeline">
    <TeTimelineTools {...props.tools} zoom={zoom} onZoom={(direction) => props.onZoom(direction === 0 ? 1 : Math.max(1, Math.min(32, direction > 0 ? zoom * 2 : zoom / 2)))}
      view={view} onView={setView} audio={audio} onAudio={setAudio}
      allText={speakers.every((s) => text.has(s.id))} onAllText={() => setText(speakers.every((s) => text.has(s.id)) ? new Set() : new Set(speakers.map((s) => s.id)))} />
    <div className="cp-te-tl-grid">
      <div className="cp-te-tl-corner" aria-hidden="true" />
      <div ref={ruler} className="cp-te-tl-ruler" {...scrub}>
        {ticks.map((t) => <span key={t} className="cp-te-tl-tick" style={{ left: x(t) }}>{teTc(t, fps)}</span>)}
        {marked && <span className="cp-te-tl-marked" style={{ left: x(marked[0]), width: w(marked[1] - marked[0]) }} aria-hidden="true" />}
        {props.markers.filter((t) => t >= start && t <= start + span).map((t) => <span key={t} className="cp-te-tl-marker" style={{ left: x(t) }} title={`Marker at ${teTc(t, fps)}`} />)}
        {seams.filter((cut) => cut.at >= start && cut.at <= start + span).map((cut) => <button key={cut.index} type="button"
          className={`cp-te-tl-seam-mark${props.seam === cut.index ? " is-selected" : ""}${cut.clipped.size ? " is-clipped" : ""}`} style={{ left: x(cut.at) }}
          aria-pressed={props.seam === cut.index} aria-label={describe(cut, fps)} title={describe(cut, fps)}
          onClick={() => { props.onSeek(cut.at); props.onSeam(cut.index); }} />)}
      </div>
      {speakers.map((speaker) => {
        const soloed = solo.has(speaker.id), quiet = solo.size > 0 && !soloed, shown = text.has(speaker.id), lane = words[speaker.id] ?? [];
        return <div key={speaker.id} className={`cp-te-tl-row${soloed ? " is-solo" : ""}${quiet ? " is-unsoloed" : ""}${mute.has(speaker.id) ? " is-muted" : ""}${shown ? " has-text" : ""}`}
          style={{ "--te-speaker": colors[speaker.id] } as React.CSSProperties}>
          <div className="cp-te-tl-head">
            <span className="cp-te-tl-track">A{speaker.track}</span><span className="cp-te-swatch" aria-hidden="true" /><span className="cp-te-tl-name" title={speaker.name}>{speaker.name}</span>
            <span className="cp-te-tl-switches">
              <button type="button" className="cp-te-tl-toggle" aria-pressed={soloed} aria-label={`Solo ${speaker.name}`} title={`Solo ${speaker.name}`} onClick={() => props.onSolo(speaker.id)}>S</button>
              <button type="button" className="cp-te-tl-toggle" aria-pressed={mute.has(speaker.id)} aria-label={`Mute ${speaker.name}`} title={`Mute ${speaker.name}`} onClick={() => props.onMute(speaker.id)}>M</button>
              <button type="button" className="cp-te-tl-toggle" aria-pressed={shown} aria-label={`Text on ${speaker.name}`} title={`Text on ${speaker.name}`} onClick={() => toggleText(speaker.id)}>T</button>
            </span>
          </div>
          <div className="cp-te-tl-lane" {...scrub}>
            {edit.segments.map((segment, index) => starts[index] + segmentLength(segment) < start || starts[index] > start + span
              || !props.sourceSpeakers[segment.source]?.includes(speaker.id) ? null
              : <div key={segment.id} className="cp-te-tl-clip" style={{ left: x(starts[index]), width: w(segmentLength(segment)) }}
                title={`${speaker.name} · ${props.sourceName(segment.source)}`}>
                {view.waveforms && <TeWave source={segment.source} speaker={speaker.id} srcIn={segment.srcIn} srcOut={segment.srcOut} muted={mutes[`${segment.source}:${speaker.id}`]} roomTone={audio.roomTone} />}
              </div>)}
            {shown && <div className="cp-te-tl-words">{lane.map((cue) => <span key={cue.id} className={cue.summary ? "is-summary" : undefined} title={cue.title} style={cue.style}>{cue.text}</span>)}</div>}
            {seams.filter((cut) => cut.clipped.has(speaker.id)).map((cut) => <span key={cut.index} className="cp-te-tl-clipped" style={{ left: x(cut.at) }} title={`Cuts into a word of ${speaker.name}'s`} />)}
          </div>
        </div>;
      })}
      <div className="cp-te-tl-overlay" aria-hidden="true">
        {marked && <span className="cp-te-tl-marked-band" style={{ left: x(marked[0]), width: w(marked[1] - marked[0]) }} />}
        {band && <span className="cp-te-tl-band" style={{ left: x(band[0]), width: w(band[1] - band[0]) }} />}
        {seams.map((cut) => <span key={cut.index} className={`cp-te-tl-seam${cut.kind === "through" ? " is-through" : ""}${props.seam === cut.index ? " is-selected" : ""}`} style={{ left: x(cut.at) }} />)}
        {fade > 0 && seams.filter((cut) => cut.kind !== "through").map((cut) => <span key={`f${cut.index}`} className="cp-te-tl-fade" style={{ left: x(cut.at - fade / 2), width: w(fade) }} />)}
        <span className="cp-te-tl-playhead" style={{ left: x(playhead) }} />
      </div>
    </div>
    {zoom > 1 && <input className="cp-te-tl-pan" type="range" aria-label="Scroll timeline" min={0} max={Math.max(0, total - span)} step={0.01} value={start} onChange={(event) => setPan(Number(event.target.value))} />}
  </section>;
}
