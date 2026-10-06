import { useFrame } from "../hooks/use-frame";
import { editTc } from "../lib/edit-document";
import type { FrameStore } from "../lib/frame-store";
import { EditScrubber } from "./EditScrubber";
import type { EditSourceInfo } from "./EditSourcePane";
import { EditTextSettings, type EditTextStyle } from "./EditTextSettings";
import { IconPause, IconPlay } from "./Icons";

/** The source pane's head: play, its scrub rail and timecode. The one part of the pane that follows each frame. */
export function EditSourceTools({ source, fps, frames, marks, playing, onPlay, onScrub, onScrubStart, onScrubEnd, text, onText }: {
  source: EditSourceInfo; fps: number; frames: FrameStore; marks: { in: number | null; out: number | null };
  playing: boolean; onPlay: () => void; onScrub: (seconds: number) => void; onScrubStart: () => void; onScrubEnd: () => void;
  text: EditTextStyle; onText: (style: EditTextStyle) => void;
}) {
  const playhead = useFrame(frames) / fps, tc = editTc(playhead, fps, source.startFrames);
  return <div className="cp-te-tools">
    <button type="button" className="cp-icon-btn cp-te-play" aria-label={playing ? `Pause ${source.short}` : `Play ${source.short}`}
      title={playing ? "Pause the source (Space)" : "Play the source (Space)"} onClick={onPlay}>{playing ? <IconPause size={14} /> : <IconPlay size={14} />}</button>
    <EditScrubber label={`${source.short} position`} value={playhead} max={source.duration} text={tc} range={marks}
      onScrub={onScrub} onScrubStart={onScrubStart} onScrubEnd={onScrubEnd} />
    <span className="cp-te-tools-tc">{tc}</span>
    <EditTextSettings pane="Source" style={text} onChange={onText} />
  </div>;
}
