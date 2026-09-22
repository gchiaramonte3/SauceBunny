import { useState } from "react";
import type { ShotAudioState } from "../hooks/use-shot-intelligence";
import { framesToTc, frameRate } from "../lib/timecode";
import { AUDIO_CONTENT_NAMES, summarizeAudio } from "../lib/scene-analysis/audio-summary";
import { IconMic, IconMusic, IconVolumeMuted } from "./Icons";

/** An editor-facing view of completed evidence. Scores and limits live in Info. */
export function ShotAudioEvidence({ audio, busy, fps = 30, compact = false, onSeek }: {
  audio: ShotAudioState; busy: boolean; onSeek?: (seconds: number) => void; fps?: number; compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  if (audio.status !== "ready") return <p className="cp-muted" role="status">{audio.status === "analyzing" ? "Analyzing audio…"
    : audio.status === "stopped" ? "Stopped" : audio.status === "unavailable" ? "Unavailable" : busy ? "Audio pending" : "Not analyzed"}</p>;
  const evidence = audio.evidence;
  if (evidence.status === "no-audio") return <p className="cp-muted">No audio track</p>;
  if (!evidence.windows.length) return <p className="cp-muted">No audio in this range</p>;
  if (!Number.isFinite(fps) || fps <= 0) return <p className="cp-muted">Frame rate unavailable</p>;
  const { ranges } = summarizeAudio(evidence, fps);
  if (!ranges.length) return <p className="cp-muted">Less than one frame of audio</p>;
  const table = <ol className="cp-shot-audio-ranges" aria-label="Audio content">
    {ranges.map((range, index) => {
      const start = framesToTc(range.startFrame, fps), end = framesToTc(range.endFrame, fps);
      const speech = range.kind === "speech" || range.kind === "mixed", music = range.kind === "music" || range.kind === "mixed";
      return <li key={`${range.startFrame}:${range.endFrame}:${index}`}>
        <div className="cp-shot-audio-times">
          <button type="button" className="cp-tc cp-shot-time" aria-label={`Audio range ${index + 1} start at ${start}`} title={`Go to ${start}`}
            disabled={!onSeek} onClick={() => onSeek?.(range.startFrame / frameRate(fps))}>{start}</button>
          <span className="cp-shot-audio-to" aria-hidden="true">to</span>
          <button type="button" className="cp-tc cp-shot-time" aria-label={`Audio range ${index + 1} end at ${end}`} title={`Go to ${end}`}
            disabled={!onSeek} onClick={() => onSeek?.(range.endFrame / frameRate(fps))}>{end}</button>
        </div>
        <div className="cp-shot-audio-content">
          <span className="cp-shot-audio-kind" data-kind={range.kind} title={speech || music || range.kind === "sfx" ? "Suggested audio content" : undefined}>
            {speech && <IconMic size={15} />}{music && <IconMusic size={15} />}{range.kind === "silence" && <IconVolumeMuted size={15} />}
            <span>{AUDIO_CONTENT_NAMES[range.kind]}</span>
          </span>
          {!!range.sounds.length && <span className="cp-shot-audio-sounds">{range.kind !== "sfx" && <span className="cp-shot-audio-sfx">SFX</span>}{range.sounds.join(" · ")}</span>}
        </div>
      </li>;
    })}
  </ol>;
  return <div className="cp-shot-audio">{compact ? <details onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>Audio · {ranges.length} {ranges.length === 1 ? "range" : "ranges"}</summary>{expanded && table}
  </details> : table}</div>;
}
