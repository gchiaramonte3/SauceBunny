import { useMultitrackDocument } from "../hooks/use-multitrack-document";
import { useEffect, useRef, useState } from "react";
import { IconPlus, IconSettings } from "./Icons";
import { IconMultitrack } from "./IconMultitrack";
import { MultitrackWorkspace } from "./MultitrackWorkspace";
import { MultitrackPipeline } from "./MultitrackPipeline";

export function MultitrackPage({ active, onOpenSettings, aiModelId, openRequest }: { active: boolean; onOpenSettings?: () => void; aiModelId?: string | null; openRequest?: { id: string; tick: number; frame?: number; trackId?: string } | null }) {
  const state = useMultitrackDocument(active);
  const [jobRunning, setJobRunning] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const cannotImport = state.loading || jobRunning;
  const handledRequest = useRef<number | null>(null);
  const [pendingOpen, setPendingOpen] = useState<string | null>(null);
  const load = state.load;
  useEffect(() => {
    if (!active || !openRequest || handledRequest.current === openRequest.tick) return;
    handledRequest.current = openRequest.tick;
    if (cannotImport) setPendingOpen(openRequest.id);
    else { setPendingOpen(null); void load(openRequest.id); }
  }, [active, openRequest, cannotImport, load]);
  return <section className="cp-multitrack-page" aria-label="Multitrack" hidden={!active}>
    <header className="cp-multitrack-page-head"><div><h1>Multitrack</h1><p>One timeline. Every mic.</p></div>
      <div className="cp-multitrack-page-actions">
        {state.saved.length > 0 && <select className="cp-select" aria-label="Open saved multitrack" value={state.document?.id ?? ""} disabled={cannotImport} onChange={(event) => { if (event.target.value) void state.load(event.target.value); }}><option value="">Saved sequences…</option>{state.saved.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}
        <button className="btn btn-ghost" disabled={cannotImport} title={jobRunning ? "Stop the running transcription before opening another AAF" : undefined} onClick={() => void state.load()}><IconPlus size={14} />Import AAF…</button>
        <button className="cp-icon-btn" aria-label="Multitrack settings" title="Multitrack settings" disabled={!state.document} onClick={() => setSettingsOpen(true)}><IconSettings size={16} /></button>
      </div>
    </header>
    {pendingOpen && <p className="cp-multitrack-note">Finish or stop the current operation before opening the Library sequence. <button className="btn btn-ghost" disabled={cannotImport} onClick={() => { void load(pendingOpen); setPendingOpen(null); }}>Open selected sequence</button><button className="btn btn-ghost" onClick={() => setPendingOpen(null)}>Dismiss</button></p>}
    {state.error && <p className="cp-multitrack-error cp-multitrack-page-error" role="alert">{state.error}</p>}
    {state.sequenceChoices && <div className="cp-multitrack-importing"><label>Sequence <select className="cp-select" aria-label="Choose AAF sequence" defaultValue="" onChange={(event) => { if (event.target.value) state.chooseSequence(event.target.value); }}><option value="" disabled>Choose a sequence…</option>{state.sequenceChoices.choices.map(choice => <option key={choice.id} value={choice.id}>{choice.name}</option>)}</select></label><button className="btn btn-ghost" onClick={state.cancelChoice}>Cancel</button></div>}
    {state.loading && <div className="cp-multitrack-importing" role="status"><span>Reading the AAF sequence…</span><button className="btn btn-ghost" onClick={state.cancelImport}>Stop</button></div>}
    {!state.loading && state.resolving && <div className="cp-multitrack-importing" role="status"><span>Checking linked media{state.mediaProgress?.total_frames ? ` · ${state.mediaProgress.completed_frames}/${state.mediaProgress.total_frames}` : "…"}</span><button className="btn btn-ghost" onClick={state.stopResolution}>Stop</button></div>}
    {state.document ? <MultitrackWorkspace key={state.document.id} document={state.document} active={active && !state.loading} resolvingMedia={state.resolving} openRequest={pendingOpen ? null : openRequest} waveforms={state.waveforms} waveformErrors={state.waveformErrors} labelStatus={state.labelStatus} onRename={state.rename} onTranscript={state.acceptTranscript} onOpenSettings={onOpenSettings} onJobState={setJobRunning} settingsOpen={settingsOpen} onCloseSettings={() => setSettingsOpen(false)} aiModelId={aiModelId} onVisibleTracks={state.showTracks} />
      : <div className="cp-multitrack-empty"><IconMultitrack size={32} /><h2>Read the room, mic by mic</h2><p>Import an AAF to see its audio tracks together. Solo a mic, label its owner, and generate a searchable transcript.</p><button className="btn btn-ghost" disabled={state.loading} onClick={() => void state.load()}>Import AAF…</button><span>Local processing · Your original AAF stays untouched</span></div>}
    <MultitrackPipeline documentId={state.document?.id} error={state.error} loading={state.loading || state.resolving || jobRunning} />
  </section>;
}
