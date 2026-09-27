import { IconPause, IconPlay, IconSkipBack } from "./Icons";

type Props = {
  playing: boolean; busy: boolean; onToggle: () => void; onStart: () => void;
  record: string; total: string; source: string | null; sourceName: string;
  speaking: { id: string; name: string; color: string }[]; message: string;
};

/**
 * Transport and program readout. Audio first: there is no picture, and the
 * question it answers is "where am I and who is talking", in record time,
 * source time and names.
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
    <div className="cp-te-speaking" aria-label="Speaking now">
      {props.speaking.length === 0 ? <span className="cp-te-speaking-none">{props.busy ? "Loading audio" : "Room tone"}</span>
        : props.speaking.map((speaker) => <span key={speaker.id} className="cp-te-speaking-name" style={{ "--te-speaker": speaker.color } as React.CSSProperties}>
          <span className="cp-te-swatch" aria-hidden="true" />{speaker.name}</span>)}
    </div>
    <p className="cp-te-status" role="status" aria-live="polite">{props.message}</p>
  </div>;
}
