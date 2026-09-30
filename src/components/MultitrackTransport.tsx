import type { AafDocument } from "../bindings/AafDocument";
import type { useMultitrackAudition } from "../hooks/use-multitrack-audition";
import { sequenceDurationTimecode, sequenceRate, sequenceTimecode } from "../lib/multitrack";
import { IconFastForward, IconPause, IconPlay, IconRewind, IconSkipBack } from "./Icons";
import { VolumeControl } from "./VolumeControl";

type Props = {
  document: AafDocument; audio: ReturnType<typeof useMultitrackAudition>;
  /** In to Out in sequence frames, out exclusive; null when nothing is marked. */
  markRange: { start: number; end: number } | null;
  waveforms: boolean; onWaveforms: (on: boolean) => void;
  onSeek: (frame: number) => void; onTimecode: () => void;
};

/** AAF Audio's transport, above the tracks: options, timecode with TRT and I/O, the buttons, and what you hear. */
export function MultitrackTransport({ document, audio, markRange, waveforms, onWaveforms, onSeek, onTimecode }: Props) {
  return <div className="cp-multitrack-transport" aria-label="AAF Audio playback controls">
    <div className="cp-multitrack-toolbar-options">
      <button className="btn btn-ghost" aria-pressed={audio.scrubbing} title="Hear short audio excerpts while scrubbing" onClick={() => audio.setScrubbing(!audio.scrubbing)}>Audio scrub</button>
      <button className="btn btn-ghost" aria-pressed={waveforms} title="Draw each mic's waveform. A mic without one is read in full first, which can take minutes on a network volume." onClick={() => onWaveforms(!waveforms)}>Waveforms</button>
    </div>
    <div className="cp-multitrack-transport-center">
      {/* Timecode stays centred over Play; TRT sits right beside it in the same
          box, and In to Out takes the other side once anything is marked. */}
      <div className="cp-multitrack-tc-row">
        {markRange && markRange.end > markRange.start
          ? <div className="cp-tc cp-multitrack-readout is-marked" role="group" aria-label="Marked range duration" title="Marked range duration, from In to Out"><span>I/O</span>{sequenceDurationTimecode(document.manifest, markRange.end - markRange.start)}</div>
          : <span aria-hidden="true" />}
        <button className="cp-tc cp-multitrack-tc" aria-label="Current timecode" aria-haspopup="dialog" title="Current timecode · Type 0-9, Enter to seek" disabled={!sequenceRate(document.manifest)} onClick={(event) => { event.currentTarget.focus(); onTimecode(); }}>{sequenceTimecode(document.manifest, audio.frame)}</button>
        <div className="cp-tc cp-multitrack-readout" role="group" aria-label="Total runtime" title="Total runtime of the loaded sequence"><span>TRT</span>{sequenceDurationTimecode(document.manifest)}</div>
      </div>
      <div className="cp-multitrack-transport-buttons">
      <button className="cp-transport-btn" aria-label="Go to sequence start" onClick={() => onSeek(0)}><IconSkipBack /></button>
      <button className="cp-transport-btn" aria-label="Rewind tracks" title="Rewind (J)" onClick={() => audio.shuttle(-1)}><IconRewind /></button>
      <button className="cp-transport-btn play" aria-label={audio.playing || audio.busy ? "Pause audition" : "Play tracks"} onClick={audio.toggle}>{audio.playing || audio.busy ? <IconPause /> : <IconPlay />}</button>
      <button className="cp-transport-btn" aria-label="Fast-forward tracks" title="Fast-forward (L)" onClick={() => audio.shuttle(1)}><IconFastForward /></button>
      </div>
    </div>
    <div className="cp-multitrack-toolbar-end">
      {/* Only what changes what you hear: preparing, or a shuttle rate. Which
          mics are soloed is already on every lane's S button. */}
      <div className="cp-multitrack-audition-status"><span className="cp-multitrack-note" role="status">{audio.busy ? "Preparing audio…" : audio.rate && audio.rate !== 1 ? `${audio.rate}×` : ""}</span>
      <VolumeControl volume={audio.volume} muted={audio.muted} onVolumeChange={audio.setVolume} onMutedChange={audio.setMuted} /></div></div>
  </div>;
}
