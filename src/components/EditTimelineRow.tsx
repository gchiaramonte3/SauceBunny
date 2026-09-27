import type { Seam, Timeline, TimelineLane } from "../lib/edit-model";
import { segmentLength } from "../lib/edit-model";
import type { multitrackTextLayout } from "../lib/multitrack-text-layout";
import { EditWave } from "./EditWave";

type Cue = ReturnType<typeof multitrackTextLayout>[number];
type Scrub = Pick<React.HTMLAttributes<HTMLElement>, "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel">;
type Props = {
  speaker: TimelineLane; color: string; soloed: boolean; quiet: boolean; muted: boolean; shown: boolean; cues: Cue[]; selected: boolean;
  onTrack: (speaker: string, only: boolean) => void; onSolo: (speaker: string) => void; onMute: (speaker: string) => void; onText: (speaker: string) => void;
  edit: Timeline; starts: number[]; start: number; span: number; x: (t: number) => string; w: (d: number) => string;
  sourceSpeakers: Record<string, string[]>; sourceName: (id: string) => string; waveforms: boolean;
  peaksOf: (source: string, speaker: string) => [number, number][] | undefined; durationOf: (source: string) => number;
  mutes: Record<string, [number, number][]>; marked: number[] | null; seams: Seam[]; scrub: Scrub;
};

/**
 * One person's track: the Avid track selector, S/M/T, and their clips. A
 * clip is a segment of the edit where this person has a mic in its source;
 * elsewhere the lane is empty time.
 */
export function EditTimelineRow(props: Props) {
  const { speaker, edit, starts, start, span, x, w, marked } = props;
  return <div className={`cp-te-tl-row${props.soloed ? " is-solo" : ""}${props.quiet ? " is-unsoloed" : ""}${props.muted ? " is-muted" : ""}${props.shown ? " has-text" : ""}`}
    style={{ "--te-speaker": props.color } as React.CSSProperties}>
    <div className="cp-te-tl-head">
      <button type="button" className="cp-te-tl-track" aria-pressed={props.selected} aria-label={`Track A${speaker.track}`}
        title={`Track A${speaker.track} (⌥-click: only this)`} onClick={(event) => props.onTrack(speaker.id, event.altKey)}>A{speaker.track}</button><span className="cp-te-swatch" aria-hidden="true" /><span className="cp-te-tl-name" title={speaker.name}>{speaker.name}</span>
      <span className="cp-te-tl-switches">
        <button type="button" className="cp-te-tl-toggle" aria-pressed={props.soloed} aria-label={`Solo ${speaker.name}`} title={`Solo ${speaker.name}`} onClick={() => props.onSolo(speaker.id)}>S</button>
        <button type="button" className="cp-te-tl-toggle" aria-pressed={props.muted} aria-label={`Mute ${speaker.name}`} title={`Mute ${speaker.name}`} onClick={() => props.onMute(speaker.id)}>M</button>
        <button type="button" className="cp-te-tl-toggle" aria-pressed={props.shown} aria-label={`Text on ${speaker.name}`} title={`Text on ${speaker.name}`} onClick={() => props.onText(speaker.id)}>T</button>
      </span>
    </div>
    <div className="cp-te-tl-lane" {...props.scrub}>
      {edit.segments.map((segment, index) => starts[index] + segmentLength(segment) < start || starts[index] > start + span
        || !props.sourceSpeakers[segment.source]?.includes(speaker.id) ? null
        : <div key={segment.id} className="cp-te-tl-clip" style={{ left: x(starts[index]), width: w(segmentLength(segment)) }}
          title={`${speaker.name} · ${props.sourceName(segment.source)}`}>
          {props.waveforms && <EditWave peaks={props.peaksOf(segment.source, speaker.id)} duration={props.durationOf(segment.source)} srcIn={segment.srcIn} srcOut={segment.srcOut} muted={props.mutes[`${segment.source}:${speaker.id}`]} />}
        </div>)}
      {marked && props.selected && <span className="cp-te-tl-marked-lane" style={{ left: x(marked[0]), width: w(marked[1] - marked[0]) }} />}
      {props.shown && <div className="cp-te-tl-words">{props.cues.map((cue) => <span key={cue.id} className={cue.summary ? "is-summary" : undefined} title={cue.title} style={cue.style}>{cue.text}</span>)}</div>}
      {props.seams.filter((cut) => cut.clipped.has(speaker.id)).map((cut) => <span key={cut.index} className="cp-te-tl-clipped" style={{ left: x(cut.at) }} title={`Cuts into a word of ${speaker.name}'s`} />)}
    </div>
  </div>;
}
