import { useState } from "react";
import type { AudioEvidence } from "../lib/scene-analysis/evidence";
import { AUDIO_CONTENT_POLICY, audioScores, summarizeAudio } from "../lib/scene-analysis/audio-summary";
import { summarizeMusic } from "../lib/scene-analysis/music-summary";
import { secondsToFrames, secondsToTc } from "../lib/timecode";

/** Only mounted inside Analysis info. Raw evidence is never rewritten by UI policy. */
export function ShotAudioDetails({ evidence, fps }: { evidence: AudioEvidence; fps: number }) {
  const [expanded, setExpanded] = useState(false);
  const { subframeWindows } = summarizeAudio(evidence, fps);
  const music = summarizeMusic(evidence);
  return <details className="cp-shot-audio-details" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>Audio details</summary>
    {expanded && <>
      <p>Content labels are model suggestions, not confirmed sounds. Speech + Music means both occur in the same analysis window, not necessarily at every frame. SFX groups supported non-speech sounds; it does not identify how they were recorded.</p>
      <p>Displayed ranges and seeks use source frames. Ends are exclusive. The classifier works in audio windows, not frame-level event boundaries. Missing or short evidence remains unclassified, never silence.</p>
      {!!subframeWindows && <p>{subframeWindows} {subframeWindows === 1 ? "sub-frame fragment is" : "sub-frame fragments are"} omitted from the range list and retained here.</p>}
      <p>{evidence.classifier} · {evidence.preprocessing_version} · {AUDIO_CONTENT_POLICY.version}</p>
      {music?.styles.length ? <p>Possible music types: {music.styles.join(", ")}. Not verified.</p> : null}
      <ol>{evidence.windows.map((window, index) => <li key={`${window.start_us}:${index}`}>
        <span>{secondsToTc(window.start_us / 1e6, fps)}{secondsToFrames(window.start_us / 1e6, fps) === secondsToFrames(window.end_us / 1e6, fps)
          ? " · less than one frame" : ` to ${secondsToTc(window.end_us / 1e6, fps)}`}</span>
        <p>{window.status === "classified" ? audioScores(evidence, index).sort((a, b) => b.score - a.score).slice(0, 3)
          .map(item => `${item.identifier.replaceAll("_", " ")} (${item.score.toFixed(3)})`).join(" · ")
          : window.status === "digital-silence" ? "Digital silence" : "Insufficient context"}</p>
      </li>)}</ol>
    </>}
  </details>;
}
