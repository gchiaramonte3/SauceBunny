import { useEffect } from "react";
import { useShotIntelligence } from "../hooks/use-shot-intelligence";
import { formatTimestamp } from "../lib/scene-analysis/detector-core";
import { GenerateButton } from "./GenerateButton";
import { Markdown } from "./Markdown";

export function ShotIntelligence({ videoPath, transcriptPath, sourceKey, reloadToken, foregroundBusy, onSeek, onOpenSettings, onBusyChange }: {
  videoPath: string | null; transcriptPath: string | null; sourceKey?: string | null; reloadToken?: number;
  onSeek?: (seconds: number) => void; onOpenSettings?: () => void; onBusyChange: (busy: boolean) => void;
  foregroundBusy?: boolean;
}) {
  const analysis = useShotIntelligence(videoPath, transcriptPath, sourceKey, reloadToken, foregroundBusy);
  useEffect(() => { onBusyChange(analysis.busy); return () => onBusyChange(false); }, [analysis.busy, onBusyChange]);
  return <section className="cp-shot-analysis" aria-label="Advanced Intelligence">
    <div className="cp-ai-bar">
      <span>Picture + transcript · on this Mac</span>
      {onOpenSettings && <button type="button" className="btn btn-ghost" onClick={onOpenSettings}>Models…</button>}
    </div>
    <div className="cp-ai-thread">
      {!analysis.evidence && <div className="cp-shot-intro">
        <p>Understand the cut, shot by shot.</p>
        <p className="cp-muted">Detect hard cuts, describe the picture, and place supplied dialogue beside each shot.</p>
        {!videoPath && <p className="cp-muted">Open a local video or finish downloading its local copy first. Live inputs are not analyzed.</p>}
        {foregroundBusy && <p className="cp-muted">Pause playback and finish transcription before analyzing video.</p>}
      </div>}
      {analysis.evidence && <>
        <p className="cp-shot-count">{analysis.evidence.shots.length} shots · {analysis.evidence.detection.boundaries.length} detected cuts</p>
        <p className="cp-muted">Music and other audio have not been analyzed.</p>
        <ol className="cp-shot-list">
          {analysis.evidence.shots.map(shot => {
            const answer = analysis.answers.find(item => item.id === shot.id);
            return <li key={shot.id}>
              <div className="cp-shot-heading"><span>Shot {shot.id}</span>
                <button type="button" className="btn btn-ghost" disabled={!onSeek} onClick={() => onSeek?.(shot.start_us / 1e6)}>
                  {formatTimestamp(shot.start_us)} to {formatTimestamp(shot.end_us)}
                </button>
              </div>
              {answer ? <Markdown source={answer.text} onSeek={onSeek} /> : <p className="cp-muted">Description {analysis.busy ? "pending" : "not generated"}.</p>}
              {shot.transcript ? <details><summary>Supplied transcript</summary><p className="cp-shot-transcript">{shot.transcript}</p>
                {shot.contextLimited && <p className="cp-muted">The model used the first 12 KB of this shot’s transcript. Full supplied text is shown here.</p>}
              </details> : <p className="cp-muted">No supplied dialogue in this shot.</p>}
            </li>;
          })}
        </ol>
      </>}
      {(analysis.error || analysis.nativeError) && <p role="alert" className="cp-muted">{analysis.nativeError || analysis.error}</p>}
    </div>
    <div className="cp-shot-actions">
      <GenerateButton idleLabel="Analyze video" loadingLabel={analysis.stopping ? "Stopping…" : analysis.phase}
        loading={analysis.busy} progress={analysis.progress} onClick={() => void analysis.start()}
        disabled={!videoPath || foregroundBusy || analysis.busy || analysis.draining} />
      {analysis.busy && <button type="button" className="btn btn-ghost" disabled={analysis.stopping} onClick={analysis.stop}>Stop</button>}
    </div>
  </section>;
}
