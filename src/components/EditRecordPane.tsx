import type { ReactNode } from "react";
import { useFrame } from "../hooks/use-frame";
import type { FrameStore } from "../lib/frame-store";
import { EditScrubber } from "./EditScrubber";
import { EditTextSettings, editTextVars, type EditTextStyle } from "./EditTextSettings";
import { IconPause, IconPlay, IconSkipBack } from "./Icons";

type Props = {
  /** The record playhead, in frames: this pane redraws as it moves, and the text inside it does not. */
  frames: FrameStore; fps: number; total: number; tc: (seconds: number) => string; totalTc: string; marks: number[];
  playing: boolean; busy: boolean; onToggle: () => void; onStart: () => void;
  onScrub: (program: number) => void; onScrubStart: () => void; onScrubEnd: () => void;
  /** The last thing the editor did ("Lifted 2.40 s."), announced politely. */
  status?: string;
  text: EditTextStyle; onText: (style: EditTextStyle) => void; children: ReactNode;
};

/**
 * The RECORD side: play, the edit's own scrub rail (edit points drawn as
 * ticks), its timecode and the text settings, above the edit's transcript,
 * with what the editor last did at its foot. The source pane is laid out the
 * same way. Play and the status used to lead and end the timeline's tool row,
 * which made the row about transport as much as tools and wrapped it below
 * about 1,260px.
 */
export function EditRecordPane(props: Props) {
  const playhead = useFrame(props.frames) / props.fps, tc = props.tc(playhead);
  return <section className="cp-te-record" aria-label="Record" style={editTextVars(props.text)}>
    <div className="cp-te-tools">
      <button type="button" className="cp-icon-btn" aria-label="Go to start" title="Go to start (Home)" onClick={props.onStart}><IconSkipBack size={14} /></button>
      <button type="button" className="cp-icon-btn cp-te-play" aria-label={props.playing ? "Pause" : "Play"} title={props.playing ? "Pause (Space)" : "Play (Space)"}
        aria-busy={props.busy || undefined} onClick={props.onToggle}>{props.playing ? <IconPause size={14} /> : <IconPlay size={14} />}</button>
      <EditScrubber label="Record position" value={playhead} max={props.total} text={tc} marks={props.marks}
        onScrub={props.onScrub} onScrubStart={props.onScrubStart} onScrubEnd={props.onScrubEnd} />
      <span className="cp-te-tools-tc">{tc}<span className="cp-te-tools-of"> / {props.totalTc}</span></span>
      <EditTextSettings pane="Edit" style={props.text} onChange={props.onText} />
    </div>
    {props.children}
    <footer className="cp-te-record-foot">
      <span className="cp-te-pane-note" role="status" aria-live="polite">{props.busy ? "Loading audio…" : props.status}</span>
    </footer>
  </section>;
}
