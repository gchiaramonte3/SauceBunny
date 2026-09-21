import { useEffect, useState } from "react";
import { useShotIntelligence } from "../hooks/use-shot-intelligence";
import { formatTimestamp } from "../lib/scene-analysis/detector-core";
import { GenerateButton } from "./GenerateButton";
import { ShotAudioEvidence } from "./ShotAudioEvidence";
import { ShotCutAction } from "./ShotCutAction";
import { usePictureModel } from "../hooks/use-picture-model";
import { isPictureModel, PICTURE_MODELS } from "../lib/picture-model";

export function ShotIntelligence({ videoPath, transcriptPath, sourceKey, reloadToken, foregroundBusy, onSeek, onOpenSettings, onBusyChange, onCutMarkersChanged }: {
  videoPath: string | null; transcriptPath: string | null; sourceKey?: string | null; reloadToken?: number;
  onSeek?: (seconds: number) => void; onOpenSettings?: () => void; onBusyChange: (busy: boolean) => void;
  foregroundBusy?: boolean;
  onCutMarkersChanged?: () => void;
}) {
  const model = usePictureModel();
  const analysis = useShotIntelligence(videoPath, transcriptPath, sourceKey, reloadToken, foregroundBusy, model.id);
  const [tab, setTab] = useState<"All" | "Picture" | "Transcript" | "Audio">("All");
  const failure = analysis.nativeError || analysis.error;
  const decoderFailure = failure.match(/Codec: ([^.]+)\. Stage: ([^.]+)\./);
  useEffect(() => { onBusyChange(analysis.busy); return () => onBusyChange(false); }, [analysis.busy, onBusyChange]);
  return <section className="cp-shot-analysis" aria-label="Advanced Intelligence">
    <div className="cp-shot-source"><span title={videoPath ?? undefined}>{videoPath?.split(/[\\/]/).pop() ?? "No local video selected"}</span>
      <label>Picture model<select className="cp-select" aria-label="Picture model" value={model.id} disabled={analysis.busy || analysis.draining} onChange={event => { if (isPictureModel(event.target.value)) model.select(event.target.value); }}>
        {PICTURE_MODELS.map(item => <option key={item.id} value={item.id}>{item.name}{model.models?.some(installed => installed.id === item.id && installed.ready) ? "" : " (not installed)"}</option>)}
      </select></label>
      {!model.ready && <p className="cp-muted">{model.models ? "Download the selected model in settings. Downloads are never automatic." : "Checking installed models…"} {onOpenSettings && <button className="cp-multitrack-text-button" onClick={onOpenSettings}>Open settings</button>}</p>}
      {model.error && <p className="cp-muted" role="status">{model.error}</p>}
    </div>
    <div className="cp-shot-tabs" role="tablist" aria-label="Analysis evidence">{(["All", "Picture", "Transcript", "Audio"] as const).map(name => <button className="btn btn-ghost" key={name} role="tab" aria-selected={tab === name} onClick={() => setTab(name)}>{name}</button>)}<span className="cp-muted">On this Mac</span></div>
    <div className="cp-ai-thread">
      {!analysis.evidence && <div className="cp-shot-intro">
        <p>Understand the cut, shot by shot.</p>
        <p className="cp-muted">Detect hard cuts, describe the picture, place supplied dialogue beside each shot, and inspect source audio.</p>
        {!videoPath && <p className="cp-muted">Open a local video or finish downloading its local copy first. Live inputs are not analyzed.</p>}
        {foregroundBusy && <p className="cp-muted">Pause playback and finish transcription before analyzing video.</p>}
      </div>}
      {analysis.evidence && <>
        <div className="cp-shot-summary">
          <span className="cp-shot-count">{analysis.evidence.shots.length} {analysis.evidence.shots.length === 1 ? "shot" : "shots"} · {analysis.evidence.detection.boundaries.length} {analysis.evidence.detection.boundaries.length === 1 ? "cut" : "cuts"}</span>
          {sourceKey && <ShotCutAction key={`${sourceKey}:${analysis.evidence.id}`} evidence={analysis.evidence}
            sourceKey={sourceKey} onCutMarkersChanged={onCutMarkersChanged} />}
          <span className="cp-muted cp-shot-cut-help">Cuts mark shot changes along the bottom of the timeline. Chapters stay at the top.</span>
        </div>
        {analysis.modelUsed && <p className="cp-muted">Picture results: {PICTURE_MODELS.find(item => item.id === analysis.modelUsed)?.name ?? analysis.modelUsed}</p>}
        {(tab === "All" || tab === "Audio") && <ShotAudioEvidence audio={analysis.audio} error={analysis.audioError} busy={analysis.busy} onSeek={onSeek} />}
        {tab !== "Audio" && <div className="cp-shot-table-scroll"><table className="cp-shot-table"><thead><tr><th>Shot</th><th>Start / end</th><th>Duration</th>{tab !== "Transcript" && <th>Picture</th>}{tab !== "Picture" && <th>Supplied dialogue</th>}</tr></thead><tbody>
          {analysis.evidence.shots.map(shot => {
            const answer = analysis.answers.find(item => item.id === shot.id);
            return <tr key={shot.id}><th scope="row">{shot.id}</th><td><button type="button" className="cp-shot-time" aria-label={`${formatTimestamp(shot.start_us)} to ${formatTimestamp(shot.end_us)}`} disabled={!onSeek} onClick={() => onSeek?.(shot.start_us / 1e6)}>{formatTimestamp(shot.start_us)}<br />{formatTimestamp(shot.end_us)}</button></td><td>{((shot.end_us - shot.start_us) / 1e6).toFixed(3)}s</td>
              {tab !== "Transcript" && <td>{answer?.picture_description ?? (answer ? `Legacy combined response: ${answer.text}` : `Description ${analysis.busy ? "pending" : "not generated"}.`)}</td>}
              {tab !== "Picture" && <td className="cp-shot-transcript">{shot.transcript || "No supplied dialogue in this shot."}{answer?.transcript_summary && <details><summary>Transcript summary</summary>{answer.transcript_summary}</details>}</td>}
            </tr>;
          })}
        </tbody></table></div>}
      </>}
      {failure && <div role="alert" className="cp-muted"><p>Analysis could not finish for {videoPath?.split(/[\\/]/).pop() ?? "this source"}. {decoderFailure ? `Codec: ${decoderFailure[1]}. Failed stage: ${decoderFailure[2]}. Try the updated runtime or a supported local transcode.` : "Check the selected model and the source details below."} The original file is unchanged.</p><details><summary>Technical details</summary><p>{failure}</p></details></div>}
    </div>
    <div className="cp-shot-actions">
      <GenerateButton idleLabel="Analyze video" loadingLabel={analysis.stopping ? "Stopping…" : analysis.phase}
        loading={analysis.busy} progress={analysis.progress} onClick={() => void analysis.start()}
        disabled={!videoPath || !model.ready || foregroundBusy || analysis.busy || analysis.draining} />
      {analysis.busy && <button type="button" className="btn btn-ghost" disabled={analysis.stopping} onClick={analysis.stop}>Stop</button>}
    </div>
  </section>;
}
