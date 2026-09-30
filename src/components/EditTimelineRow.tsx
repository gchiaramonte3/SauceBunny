import type { Seam, Timeline, TimelineLane } from "../lib/edit-model";
import { clipPieces, playsOn, segmentLength } from "../lib/edit-model";
import type { multitrackTextLayout } from "../lib/multitrack-text-layout";
import { EditWave } from "./EditWave";

type Cue = ReturnType<typeof multitrackTextLayout>[number];
type Scrub = Pick<React.HTMLAttributes<HTMLElement>, "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel">;
type Props = {
  speaker: TimelineLane; color: string; soloed: boolean; quiet: boolean; muted: boolean; shown: boolean; cues: Cue[]; selected: boolean;
  onTrack: (speaker: string, only: boolean) => void; onSolo: (speaker: string) => void; onMute: (speaker: string) => void; onText: (speaker: string) => void;
  onUntrack?: (speaker: string) => void;
  edit: Timeline; starts: number[]; start: number; span: number; x: (t: number) => string; w: (d: number) => string;
  sourceSpeakers: Record<string, string[]>; sourceName: (id: string) => string; waveforms: boolean;
  peaksOf: (source: string, speaker: string) => [number, number][] | undefined; durationOf: (source: string) => number;
  mutes: Record<string, [number, number][]>; marked: number[] | null; seams: Seam[]; scrub: Scrub;
  /** The patch panel: everyone who can be put on this track, and doing it. */
  patch?: { people: TimelineLane[]; onPatch: (lane: string, position: number) => void };
};

/**
 * One record track: the Avid track selector (A1…), who is patched to it
 * (the patch panel: choose someone else and they take this track, the rest
 * moving down), S/M/T, × to take them off, and the track's clips. A clip is
 * a segment of the edit that plays this person, where they have a mic in its
 * source; elsewhere the track is filler.
 */
export function EditTimelineRow(props: Props) {
  const { speaker, edit, starts, start, span, x, w, marked } = props;
  return <div className={`cp-te-tl-row${props.soloed ? " is-solo" : ""}${props.quiet ? " is-unsoloed" : ""}${props.muted ? " is-muted" : ""}${props.shown ? " has-text" : ""}`}
    style={{ "--te-speaker": props.color } as React.CSSProperties}>
    <div className="cp-te-tl-head">
      <button type="button" className="cp-te-tl-track" aria-pressed={props.selected} aria-label={`Track A${speaker.track}`}
        title={`Track A${speaker.track} (⌥-click: only this)`} onClick={(event) => props.onTrack(speaker.id, event.altKey)}>A{speaker.track}</button><span className="cp-te-swatch" aria-hidden="true" />
      {props.patch ? <select className="cp-select xs cp-te-tl-patch" aria-label={`Who plays on A${speaker.track}`} title={`Who plays on A${speaker.track}`} value={speaker.id}
        onChange={(event) => props.patch?.onPatch(event.target.value, speaker.track - 1)}>
        {props.patch.people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select>
        : <span className="cp-te-tl-name" title={speaker.name}>{speaker.name}</span>}
      <span className="cp-te-tl-switches">
        <button type="button" className="cp-te-tl-toggle" aria-pressed={props.soloed} aria-label={`Solo ${speaker.name}`} title={`Solo ${speaker.name}`} onClick={() => props.onSolo(speaker.id)}>S</button>
        <button type="button" className="cp-te-tl-toggle" aria-pressed={props.muted} aria-label={`Mute ${speaker.name}`} title={`Mute ${speaker.name}`} onClick={() => props.onMute(speaker.id)}>M</button>
        <button type="button" className="cp-te-tl-toggle" aria-pressed={props.shown} aria-label={`Text on ${speaker.name}`} title={`Text on ${speaker.name}`} onClick={() => props.onText(speaker.id)}>T</button>
        {/* Patched when their words were cut in; this takes them off again, and the tracks below move up. */}
        {props.onUntrack && <button type="button" className="cp-te-tl-toggle" aria-label={`Take ${speaker.name} off a track`}
          title={`Take ${speaker.name} off a track`} onClick={() => props.onUntrack?.(speaker.id)}>×</button>}
      </span>
    </div>
    <div className="cp-te-tl-lane" {...props.scrub}>
      {edit.segments.map((segment, index) => starts[index] + segmentLength(segment) < start || starts[index] > start + span
        || !props.sourceSpeakers[segment.source]?.includes(speaker.id) || !playsOn(segment, speaker.id) ? null
        // A range silenced on this track is not drawn at all: the clip is cut
        // there, as the AAF writes it, rather than shown with a quiet waveform.
        : clipPieces(segment, props.mutes[`${segment.source}:${speaker.id}`] ?? []).map((piece) => {
          const at = starts[index] + piece.srcIn - segment.srcIn;
          return <div key={`${segment.id}:${piece.srcIn}`} className="cp-te-tl-clip" style={{ left: x(at), width: w(piece.srcOut - piece.srcIn) }}
            title={`${speaker.name} · ${props.sourceName(segment.source)}`}>
            {props.waveforms && <EditWave peaks={props.peaksOf(segment.source, speaker.id)} duration={props.durationOf(segment.source)} srcIn={piece.srcIn} srcOut={piece.srcOut} />}
          </div>;
        }))}
      {marked && props.selected && <span className="cp-te-tl-marked-lane" style={{ left: x(marked[0]), width: w(marked[1] - marked[0]) }} />}
      {props.shown && <div className="cp-te-tl-words">{props.cues.map((cue) => <span key={cue.id} className={cue.summary ? "is-summary" : undefined} title={cue.title} style={cue.style}>{cue.text}</span>)}</div>}
      {props.seams.filter((cut) => cut.clipped.has(speaker.id)).map((cut) => <span key={cut.index} className="cp-te-tl-clipped" style={{ left: x(cut.at) }} title={`Cuts into a word of ${speaker.name}'s`} />)}
    </div>
  </div>;
}
