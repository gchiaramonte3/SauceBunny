import { IconPause, IconPlay, IconSkipBack } from "./Icons";

type Props = {
  playing: boolean; busy: boolean; onToggle: () => void; onStart: () => void;
  record: string; total: string; source: string | null; sourceName: string;
};

/**
 * Transport and program readout: where am I, in record time and source time.
 * It leads the timeline's tool row rather than taking a line of its own.
 * No names here: a row of whoever is talking crowded the controls, and the
 * people belong with the tracks and the source, not in the tool bar.
 */
export function EditTransport(props: Props) {
  return <div className="cp-te-transport" role="group" aria-label="Transport">
    <button type="button" className="cp-icon-btn" aria-label="Go to start" title="Go to start (Home)" onClick={props.onStart}><IconSkipBack size={14} /></button>
    <button type="button" className="cp-icon-btn cp-te-play" aria-label={props.playing ? "Pause" : "Play"} title={props.playing ? "Pause (Space)" : "Play (Space)"} onClick={props.onToggle}>
      {props.playing ? <IconPause size={15} /> : <IconPlay size={15} />}</button>
    <div className="cp-te-readout">
      <span className="cp-te-readout-label">Record</span>
      <span className="cp-te-readout-tc">{props.record}</span>
      <span className="cp-te-readout-of">of {props.total}</span>
    </div>
    <div className="cp-te-readout">
      <span className="cp-te-readout-label">Source</span>
      {props.sourceName && <span className="cp-te-readout-of">{props.sourceName}</span>}
      <span className="cp-te-readout-tc is-quiet">{props.source ?? "--:--:--:--"}</span>
    </div>
    {props.busy && <span className="cp-te-transport-busy" role="status">Loading audio</span>}
  </div>;
}
