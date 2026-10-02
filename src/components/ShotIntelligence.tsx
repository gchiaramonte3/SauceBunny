import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { useShotIntelligence } from "../hooks/use-shot-intelligence";
import { analysisSnapshot, correctedRow, rowAnchor } from "../lib/scene-analysis/corrections";
import { useAnalysisCorrections } from "../hooks/use-analysis-corrections";
import { ShotAnalysisTable } from "./ShotAnalysisTable";
import { GenerateButton } from "./GenerateButton";
import { ShotAudioEvidence } from "./ShotAudioEvidence";
import { ShotCutAction } from "./ShotCutAction";
import { ShotAnalysisInfo } from "./ShotAnalysisInfo";
import { usePictureModel } from "../hooks/use-picture-model";
import { isPictureModel, PICTURE_MODELS } from "../lib/picture-model";
import type { CutMarkerChange } from "../lib/cut-markers";

const TABS = ["All", "Picture", "Transcript", "Audio"] as const;

export function ShotIntelligence({ videoPath, transcriptPath, fps = 30, infoHost, sourceKey, reloadToken, foregroundBusy, onSeek, onOpenSettings, onBusyChange, onCutMarkersChanged }: {
  videoPath: string | null; transcriptPath: string | null; sourceKey?: string | null; reloadToken?: number;
  onSeek?: (seconds: number) => void; onOpenSettings?: () => void; onBusyChange: (busy: boolean) => void;
  foregroundBusy?: boolean;
  fps?: number;
  infoHost?: HTMLElement | null;
  onCutMarkersChanged?: (change: CutMarkerChange) => void;
}) {
  const model = usePictureModel();
  const analysis = useShotIntelligence(videoPath, transcriptPath, sourceKey, reloadToken, foregroundBusy, model.id);
  const liveSnapshot = analysisSnapshot(analysis.evidence, analysis.answers, analysis.dialogue?.text, fps, analysis.modelUsed);
  const edits = useAnalysisCorrections(videoPath, liveSnapshot, JSON.stringify([sourceKey, reloadToken]));
  const [editSource, setEditSource] = useState<string | null>(null);
  const editing = !!videoPath && editSource === videoPath;
  // Reopening an edited file needs no model run. The saved baseline and user
  // layer are source-hash verified by native code before either is displayed.
  const snapshot = liveSnapshot ?? (!analysis.evidence && !analysis.busy ? edits.doc : null);
  const rows = snapshot?.rows ?? analysis.evidence?.shots.map(shot => {
    const answer = analysis.answers.find(item => item.id === shot.id);
    return { id: shot.id, start_us: shot.start_us, end_us: shot.end_us, picture: answer?.picture_description ?? answer?.text ?? "",
      dialogue: shot.transcript || analysis.dialogue?.text[shot.id] || "", summary: answer?.transcript_summary ?? "" };
  }) ?? [];
  const dialogueEmpty = analysis.dialogue?.status === "analyzing" ? "Transcribing…" : analysis.dialogue?.status === "unavailable" ? "Unavailable" : analysis.dialogue?.status === "stopped" ? "Stopped" : "No dialogue";
  // A Settings change applies to the next run, never relabels the one in flight.
  const displayedModel = analysis.busy && analysis.modelUsed && isPictureModel(analysis.modelUsed) ? analysis.modelUsed : model.id;
  const [tab, setTab] = useState<"All" | "Picture" | "Transcript" | "Audio">("All");
  const failure = analysis.nativeError || analysis.error;
  const incomplete = failure || analysis.audioError || analysis.dialogue?.error;
  const id = useId();
  const info = <ShotAnalysisInfo key={videoPath} source={videoPath} fps={fps} audio={analysis.audio} audioError={analysis.audioError}
    dialogue={analysis.dialogue}
    model={PICTURE_MODELS.find(item => item.id === (analysis.modelUsed ?? snapshot?.model))?.name ?? analysis.modelUsed ?? snapshot?.model ?? undefined} failure={failure || model.error || model.preferenceError || edits.error || ""}
    status={analysis.busy ? analysis.phase : incomplete ? "Incomplete" : model.error ? "Model unavailable" : model.preferenceError ? "Default not saved" : analysis.complete ? "Complete" : analysis.evidence ? "Partial results" : snapshot ? "Saved corrections" : "Not run"} />;
  useEffect(() => { onBusyChange(analysis.busy); return () => onBusyChange(false); }, [analysis.busy, onBusyChange]);
  return <section className="cp-shot-analysis" aria-label="Advanced Intelligence">
    <div className="cp-shot-source"><span title={videoPath ?? undefined}>{videoPath?.split(/[\\/]/).pop() ?? "No local video selected"}</span>
      <label>Picture model<select className="cp-select" aria-label="Picture model" value={displayedModel} disabled={analysis.busy || analysis.draining} onChange={event => { if (isPictureModel(event.target.value)) model.select(event.target.value); }}>
        {PICTURE_MODELS.map(item => <option key={item.id} value={item.id}>{item.name}{model.models && !model.models.some(installed => installed.id === item.id && installed.ready) ? " (not installed)" : ""}</option>)}
      </select></label>
      {infoHost ? createPortal(info, infoHost) : infoHost === undefined ? info : null}
      {!model.ready && <p className="cp-muted">{model.models ? "Download this model in settings." : "Checking models…"} {onOpenSettings && <button className="cp-multitrack-text-button" onClick={onOpenSettings}>Open settings</button>}</p>}
    </div>
    <div className="cp-shot-toolbar">
      <div className="cp-shot-tabs" role="tablist" aria-label="Analysis evidence">{TABS.map((name, index) => <button type="button" className="btn btn-ghost" key={name} role="tab" id={`${id}-${name}`} aria-controls={`${id}-evidence`} aria-selected={tab === name} tabIndex={tab === name ? 0 : -1}
        onClick={() => setTab(name)} onKeyDown={event => {
          const next = event.key === "ArrowRight" ? (index + 1) % TABS.length : event.key === "ArrowLeft" ? (index + TABS.length - 1) % TABS.length : event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : null;
          if (next === null) return;
          event.preventDefault(); event.stopPropagation(); setTab(TABS[next]); document.getElementById(`${id}-${TABS[next]}`)?.focus();
        }}>{name}</button>)}</div>
      {(analysis.evidence || snapshot) && sourceKey && <ShotCutAction key={`${sourceKey}:${analysis.evidence?.id ?? "saved"}`} markers={rows.slice(1).map(row => ({ time: correctedRow(row, edits.doc?.corrections[rowAnchor(row)]).start_us / 1e6 }))} sourceKey={sourceKey} onCutMarkersChanged={onCutMarkersChanged} />}
      {rows.length > 0 && <button type="button" className="btn btn-ghost cp-shot-edit-toggle" aria-pressed={editing} disabled={!snapshot || edits.loading || !!edits.error}
        title={edits.error || "Edit text and timecodes. Existing timeline markers stay unchanged."} onClick={() => setEditSource(editing ? null : videoPath)}>{editing ? "Done editing" : "Edit"}</button>}
    </div>
    <div className="cp-ai-thread" role="tabpanel" id={`${id}-evidence`} aria-labelledby={`${id}-${tab}`} tabIndex={0}>
      {!analysis.evidence && !snapshot && <div className="cp-shot-intro">
        <p>Analyze picture, dialogue, and audio.</p>
        {!videoPath && <p className="cp-muted">Open a local video to begin. Live inputs are not analyzed.</p>}
        {foregroundBusy && <p className="cp-muted">Pause playback and finish transcription before analyzing video.</p>}
      </div>}
      {(analysis.evidence || snapshot) && <>
        <div className="cp-shot-summary">
          <span className="cp-shot-count">{rows.length} {rows.length === 1 ? "shot" : "shots"} · {analysis.evidence?.detection.boundaries.length ?? Math.max(0, rows.length - 1)} {(analysis.evidence?.detection.boundaries.length ?? rows.length - 1) === 1 ? "cut" : "cuts"}</span>
        </div>
        {(tab === "Audio" || (tab === "All" && analysis.audio.status === "ready")) && <ShotAudioEvidence compact={tab === "All"} audio={analysis.audio} busy={analysis.busy} fps={fps} onSeek={onSeek} />}
        {tab !== "Audio" && <ShotAnalysisTable key={JSON.stringify([videoPath, sourceKey, reloadToken])} rows={rows} snapshot={snapshot} corrections={edits.doc?.corrections ?? {}} tab={tab} editing={editing && !!snapshot && !edits.loading && !edits.error}
          fps={snapshot?.fps ?? fps} busy={analysis.busy} dialogueEmpty={dialogueEmpty} onSeek={onSeek} onSave={edits.save} />}
      </>}
    </div>
    {incomplete && <span className="cp-visually-hidden" role="status">Analysis incomplete. Open Analysis info for details.</span>}
    <div className="cp-shot-actions">
      <GenerateButton idleLabel={incomplete ? "Retry analysis" : "Analyze video"} loadingLabel={analysis.stopping ? "Stopping…" : analysis.phase}
        title={analysis.busy ? (analysis.stopping ? "Stopping…" : analysis.phase) : undefined}
        loading={analysis.busy} progress={analysis.progress} onClick={() => void analysis.start()}
        disabled={!videoPath || !model.ready || foregroundBusy || analysis.busy || analysis.draining} />
      {analysis.busy && <button type="button" className="btn btn-ghost" disabled={analysis.stopping} onClick={analysis.stop}>Stop</button>}
    </div>
  </section>;
}
