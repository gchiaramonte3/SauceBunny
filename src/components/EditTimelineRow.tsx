import type { LayerClip } from "../lib/edit-model";
import { clipPieces } from "../lib/edit-model";
import type { Roller } from "../lib/edit-trim";
import type { multitrackTextLayout } from "../lib/multitrack-text-layout";
import { EditWave } from "./EditWave";

type Cue = ReturnType<typeof multitrackTextLayout>[number];
type Pointer = Pick<React.HTMLAttributes<HTMLElement>, "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel" | "onPointerLeave">;
type Props = {
  /** The record track: 1 for A1. */
  layer: number; clips: LayerClip[];
  soloed: boolean; quiet: boolean; muted: boolean; shown: boolean; cues: Cue[]; selected: boolean;
  onTrack: (layer: number, only: boolean) => void; onSolo: (layer: number) => void; onMute: (layer: number) => void; onText: (layer: number) => void;
  start: number; span: number; x: (t: number) => string; w: (d: number) => string;
  nameOf: (lane: string) => string; colorOf: (lane: string) => string; sourceName: (id: string) => string; waveforms: boolean;
  /** This track's waveform switch; ⌥-click turns every track's on or off, as in Avid. */
  onWave?: (layer: number, all: boolean) => void;
  peaksOf: (source: string, lane: string) => [number, number][] | undefined; durationOf: (source: string) => number;
  detail?: (pair: string, from: number, to: number) => Promise<[number, number][] | null>;
  mutes: Record<string, [number, number][]>; marked: number[] | null;
  /** The selected clips on this track, by where they start, and its trim rollers. */
  picked?: number[]; rollers?: Roller[];
  /** One-sided rollers ripple (yellow in Avid) or overwrite (red); drawn by shape, as Neo does. */
  ripple?: boolean;
  /** What the pointer does on the track (use-record-gestures). */
  pointer: Pointer;
};

/**
 * One record track, as Avid draws one: a layer (A1…) and not a person. Its
 * header is the track selector and S, M, T and W; its lane holds whatever was
 * cut onto it, each clip in the colour and with the name of the person it
 * plays, and filler everywhere else. A clip runs for as long as one person
 * plays on continuously from one source range, so an edit on other tracks
 * alone is no cut here. A range silenced on the track is not drawn, as the
 * AAF writes it: the clip is cut there.
 */
export function EditTimelineRow(props: Props) {
  const { layer, start, span, x, w, marked } = props;
  const label = `A${layer}`;
  const shown = props.clips.filter((clip) => clip.to >= start && clip.from <= start + span);
  return <div className={`cp-te-tl-row${props.soloed ? " is-solo" : ""}${props.quiet ? " is-unsoloed" : ""}${props.muted ? " is-muted" : ""}${props.shown ? " has-text" : ""}`}>
    <div className="cp-te-tl-head">
      <button type="button" className="cp-te-tl-track" aria-pressed={props.selected} aria-label={`Track ${label}`}
        title={`Track ${label} (⌥-click: only this)`} onClick={(event) => props.onTrack(layer, event.altKey)}>{label}</button>
      <span className="cp-te-tl-switches">
        <button type="button" className="cp-te-tl-toggle" aria-pressed={props.soloed} aria-label={`Solo ${label}`} title={`Solo ${label}`} onClick={() => props.onSolo(layer)}>S</button>
        <button type="button" className="cp-te-tl-toggle" aria-pressed={props.muted} aria-label={`Mute ${label}`} title={`Mute ${label}`} onClick={() => props.onMute(layer)}>M</button>
        <button type="button" className="cp-te-tl-toggle" aria-pressed={props.shown} aria-label={`Text on ${label}`} title={`Text on ${label}`} onClick={() => props.onText(layer)}>T</button>
        {props.onWave && <button type="button" className="cp-te-tl-toggle" aria-pressed={props.waveforms} aria-label={`Waveform on ${label}`}
          title={`Waveform on ${label} (⌥-click: every track)`} onClick={(event) => props.onWave?.(layer, event.altKey)}>W</button>}
      </span>
    </div>
    <div className="cp-te-tl-lane" data-record-layer={layer} {...props.pointer}>
      {shown.map((clip) => clipPieces(clip, props.mutes[`${clip.source}:${clip.lane}`] ?? []).map((piece) => {
        const at = clip.from + piece.srcIn - clip.srcIn, length = piece.srcOut - piece.srcIn;
        // The part of the clip on screen, in source seconds: only that is drawn.
        const from = piece.srcIn + Math.max(0, start - at), to = piece.srcIn + Math.min(length, start + span - at);
        const who = props.nameOf(clip.lane), picked = props.picked?.some((from) => Math.abs(from - clip.from) < 1e-6);
        return <div key={`${clip.first}:${piece.srcIn}`} className={`cp-te-tl-clip${picked ? " is-picked" : ""}`} style={{ left: x(at), width: w(length), "--te-speaker": props.colorOf(clip.lane) } as React.CSSProperties}
          title={`${who} · ${props.sourceName(clip.source)}`}>
          <span className="cp-te-tl-clip-name">{who}</span>
          {props.waveforms && <EditWave peaks={props.peaksOf(clip.source, clip.lane)} duration={props.durationOf(clip.source)} srcIn={piece.srcIn} srcOut={piece.srcOut}
            from={from} to={to} detail={props.detail} detailKey={`${clip.source}:${clip.lane}`} />}
        </div>;
      }))}
      {marked && props.selected && <span className="cp-te-tl-marked-lane" style={{ left: x(marked[0]), width: w(marked[1] - marked[0]) }} />}
      {/* Trim rollers, as Neo draws them: bars either side of the cut for a roll, one inside the clip for one side; a square for an overwrite. */}
      {props.rollers?.map((roller) => <span key={roller.at} className={`cp-te-tl-roller is-${roller.side}${roller.side !== "both" && !props.ripple ? " is-overwrite" : ""}`}
        style={{ left: x(roller.at) }} aria-hidden="true" />)}
      {props.shown && <div className="cp-te-tl-words">{props.cues.map((cue) => <span key={cue.id} className={cue.summary ? "is-summary" : undefined} title={cue.title} style={cue.style}>{cue.text}</span>)}</div>}
    </div>
  </div>;
}
