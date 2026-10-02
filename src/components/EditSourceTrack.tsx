import type { AafClip } from "../bindings/AafClip";
import type { multitrackTextLayout } from "../lib/multitrack-text-layout";
import { EditWave } from "./EditWave";
import { IconChevronDown, IconChevronRight } from "./Icons";

type Cue = ReturnType<typeof multitrackTextLayout>[number];
type Scrub = Pick<React.HTMLAttributes<HTMLElement>, "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel">;
type Props = {
  /** The AAF track: its id, its label (A3) and whose mic it is. */
  id: string; label: string; owner: string; color: string | undefined;
  /** The alternates under this track (a group), and whether they are showing. */
  alternates: number; open: boolean; onOpen: (all: boolean) => void;
  /** This track is itself a group alternate: the group it belongs to. */
  group: string | null;
  /** Why the mic cannot play (offline, needs relink), or "". */
  status: string;
  /** The string out has no lane for this mic, so its words were never read. */
  unread: boolean;
  selected: boolean; onSelect: (only: boolean) => void; soloed: boolean; quiet: boolean; onSolo: () => void; shown: boolean; onText: () => void;
  clips: AafClip[]; seconds: (frames: number) => number; start: number; span: number; x: (t: number) => string; w: (d: number) => string;
  waveforms: boolean; peaks: [number, number][] | undefined; duration: number; cues: Cue[]; scrub: Scrub;
};

/**
 * One track of the SOURCE sequence as AAF Audio lists it: the mic's track
 * selector, the group disclosure and ↳ for an alternate, whose mic it is, S
 * and T, and the sequence's own clips, gaps and all. It wears String Outs'
 * lane look so switching Source and Record reads as one timeline.
 */
export function EditSourceTrack(props: Props) {
  const { start, span, x, w } = props;
  const visible = props.clips.filter((clip) => clip.kind !== "gap" && props.seconds(clip.start_frame + clip.duration_frames) > start && props.seconds(clip.start_frame) < start + span);
  return <div className={`cp-te-tl-row${props.group ? " is-alternative" : ""}${props.soloed ? " is-solo" : ""}${props.quiet ? " is-unsoloed" : ""}${props.shown ? " has-text" : ""}`}
    style={{ "--te-speaker": props.color } as React.CSSProperties} data-source-track={props.id}>
    <div className="cp-te-tl-head">
      {props.alternates > 0 && <button type="button" className="cp-icon-btn cp-te-tl-disclosure" aria-expanded={props.open} aria-label={`Alternative microphones for ${props.label}`}
        title={`${props.alternates} alternative microphones. Option-click to open or close every group.`} onClick={(event) => props.onOpen(event.altKey)}>
        {props.open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}</button>}
      {props.group != null && <span className="cp-te-tl-branch" title={props.group}>↳</span>}
      <button type="button" className="cp-te-tl-track" aria-pressed={props.selected} aria-label={`Source track ${props.label}`}
        title={`Source track ${props.label} (⌥-click: only this). On tracks are what Insert brings.`} onClick={(event) => props.onSelect(event.altKey)}>{props.label}</button>
      <span className="cp-te-swatch" aria-hidden="true" /><span className="cp-te-tl-name" title={props.unread ? `${props.owner}. Not read into this string out` : props.owner}>{props.owner}</span>
      <span className="cp-te-tl-switches">
        <button type="button" className="cp-te-tl-toggle" aria-pressed={props.soloed} aria-label={`Solo ${props.owner}`} title={`Solo ${props.owner}`} disabled={props.unread} onClick={props.onSolo}>S</button>
        <button type="button" className="cp-te-tl-toggle" aria-pressed={props.shown} aria-label={`Text on ${props.owner}`} title={`Text on ${props.owner}`} disabled={props.unread} onClick={props.onText}>T</button>
      </span>
    </div>
    <div className="cp-te-tl-lane" {...props.scrub}>
      {visible.map((clip) => {
        const from = props.seconds(clip.start_frame), to = props.seconds(clip.start_frame + clip.duration_frames);
        return <div key={clip.start_frame} className="cp-te-tl-clip" style={{ left: x(from), width: w(to - from) }} title={`${props.owner} · ${props.label}`}>
          {props.waveforms && <EditWave peaks={props.peaks} duration={props.duration} srcIn={from} srcOut={to} />}
        </div>;
      })}
      {props.status && <span className="cp-te-tl-note">{props.status}</span>}
      {props.shown && <div className="cp-te-tl-words">{props.cues.map((cue) => <span key={cue.id} className={cue.summary ? "is-summary" : undefined} title={cue.title} style={cue.style}>{cue.text}</span>)}</div>}
    </div>
  </div>;
}
