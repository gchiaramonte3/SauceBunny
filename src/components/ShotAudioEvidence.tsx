import { useState } from "react";
import type { ShotAudioState } from "../hooks/use-shot-intelligence";
import { formatTimestamp } from "../lib/scene-analysis/detector-core";
import { summarizeMusic, type MusicWindowSummary } from "../lib/scene-analysis/music-summary";

function musicWindowText(window: MusicWindowSummary) {
  if (window.kind === "silence") return "Digital silence";
  if (window.kind === "short") return "Short window. Music type unclear.";
  if (window.kind === "unclear") return "Music is uncertain in this range.";
  return window.style ? `Possible type: ${window.style}.` : "Music suggested. Type unclear.";
}

/** Observations from actual PCM, not a music verdict or model-authored timing. */
export function ShotAudioEvidence({ audio, error, busy, onSeek }: {
  audio: ShotAudioState; error: string; busy: boolean; onSeek?: (seconds: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (audio.status !== "ready") {
    const message = audio.status === "analyzing" ? "Analyzing source audio…"
      : audio.status === "stopped" ? "Audio analysis stopped. Shot descriptions are retained."
      : audio.status === "unavailable" ? "Audio analysis unavailable. Shot descriptions are retained."
      : busy ? "Source audio analysis is next." : "Source audio has not been analyzed.";
    return <div className="cp-shot-audio">
      <p className="cp-muted" role="status">{message}</p>
      {error && <details><summary>Audio details</summary><p className="cp-muted">{error}</p></details>}
    </div>;
  }
  const evidence = audio.evidence;
  const music = summarizeMusic(evidence);
  if (evidence.status === "no-audio") return <p className="cp-muted">This video has no audio track.</p>;
  if (!evidence.windows.length) return <p className="cp-muted">No decoded audio overlaps this video range.</p>;
  return <div className="cp-shot-audio">
    <p className="cp-muted">Source audio analyzed · Audio track {evidence.audio_track_index + 1}. {"labels" in evidence
      ? "AudioSet suggestions need review." : "Music type is not yet verified."}</p>
    {music && <p>{music.styles.length ? `Possible music ${music.styles.length === 1 ? "type" : "types"}: ${music.styles.slice(0, 3).join(", ")}${music.styles.length > 3 ? ", with more in the evidence" : ""}.`
      : music.windows.every(window => window.kind === "silence") ? "Digital silence in the analyzed audio."
      : music.windows.some(window => window.kind === "music") ? "Music suggested. Type unclear." : "Music type unclear."}</p>}
    <details onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary>Audio evidence · {evidence.windows.length} {evidence.windows.length === 1 ? "window" : "windows"}</summary>
      {expanded && <>
        <p className="cp-muted">Classifier suggestions are not confirmed sounds or music genres. Each range covers an audio window, which can span several shots. {"labels" in evidence
          ? "Short windows have limited context. Gaps and tails shorter than 25 ms are not classified."
          : "Gaps and short tails are not classified."}</p>
        <ol className="cp-shot-audio-windows">
          {evidence.windows.map((window, index) => <li key={window.start_us}>
            <button type="button" className="btn btn-ghost" disabled={!onSeek} onClick={() => onSeek?.(window.start_us / 1e6)}>
              {formatTimestamp(window.start_us)} to {formatTimestamp(window.end_us)}
            </button>
            {music && window.status === "classified" && <p>{musicWindowText(music.windows[index])}</p>}
            <p>{window.status === "digital-silence" ? "Digital silence"
              : window.status === "insufficient-context" ? "Short tail. Not classified."
              // A compact view of the ranked raw evidence, not a threshold or
              // inferred presence rule. All original scores remain in evidence.
              : ("scores" in window && "labels" in evidence
                ? window.scores.map((score, index) => ({ identifier: evidence.labels[index], score }))
                : "classifications" in window ? [...window.classifications] : []).sort((a, b) => b.score - a.score).slice(0, 3)
                .map(score => `${score.identifier.replaceAll("_", " ")} (score ${score.score.toFixed(3)})`).join(" · ")}</p>
          </li>)}
        </ol>
        <p className="cp-muted">{evidence.classifier} · {evidence.preprocessing_version} · {evidence.os}</p>
        {music && <p className="cp-muted">Suggestions use {music.policyVersion}, an experimental review policy. Uncertain ranges do not mean music is absent. These are analysis windows, not song boundaries.</p>}
      </>}
    </details>
  </div>;
}
