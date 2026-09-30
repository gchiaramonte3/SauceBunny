import { secondsToTc } from "../src/lib/timecode";
import { teTc } from "./transcript-editor-fixture";
import { IconPause, IconPlay, IconSkipBack } from "../src/components/Icons";

type Props = {
  playing: boolean; onToggle: () => void; onStart: () => void;
  playhead: number; total: number; fps: number;
  /** Source time under the playhead, in seconds from the scene's start timecode. */
  source: number | null; sourceBase: string; sourceName: string; message: string;
};

/**
 * Transport and program readout: where am I, in record time and source time.
 * No names in this bar; the people belong with the tracks and the source.
 */
export function TeTransport(props: Props) {
  const { fps } = props;
  return <div className="cp-te-transport" role="group" aria-label="Transport">
    <button type="button" className="cp-icon-btn" aria-label="Go to start" title="Go to start (Home)" onClick={props.onStart}><IconSkipBack size={14} /></button>
    <button type="button" className="cp-icon-btn cp-te-play" aria-label={props.playing ? "Pause" : "Play"} title={props.playing ? "Pause (Space)" : "Play (Space)"} onClick={props.onToggle}>
      {props.playing ? <IconPause size={15} /> : <IconPlay size={15} />}</button>
    <div className="cp-te-readout">
      <span className="cp-te-readout-label">Record</span>
      <span className="cp-te-readout-tc">{teTc(props.playhead, fps)}</span>
      <span className="cp-te-readout-of">of {secondsToTc(props.total, fps)}</span>
    </div>
    <div className="cp-te-readout">
      <span className="cp-te-readout-label">Source</span>
      {props.sourceName && <span className="cp-te-readout-of">{props.sourceName}</span>}
      <span className="cp-te-readout-tc is-quiet">{props.source == null ? "--:--:--:--" : teTc(props.source, fps, props.sourceBase)}</span>
    </div>
    <p className="cp-te-status" role="status" aria-live="polite">{props.message}</p>
  </div>;
}
