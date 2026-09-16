import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { formatError } from "../lib/error-format";
import type { VideoModel } from "../bindings/VideoModel";
import { useVideoIntelligence } from "../hooks/use-video-intelligence";
import { CollapsibleSection } from "./CollapsibleSection";
import { IconSparkles } from "./Icons";

const descriptions: Record<string, string> = {
  embedding: "Find moments by what’s on screen.",
  reranker: "Refine the closest matches. Optional.",
  reasoning: "Describe selected moments.",
};
const size = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

export function VideoIntelligenceSettings() {
  const [models, setModels] = useState<VideoModel[]>([]);
  const [details, setDetails] = useState(false);
  const [activeModel, setActiveModel] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [unloadNote, setUnloadNote] = useState("");
  const { run, stop, busy, progress, error } = useVideoIntelligence();
  useEffect(() => {
    let current = true;
    void Promise.resolve().then(async () => {
      if (!current) return;
      const result = await run({ operation: "models" });
      if (current && result) setModels(result.models);
    });
    return () => { current = false; };
  }, [run]);
  async function change(model: VideoModel, remove: boolean) {
    setActiveModel(model.id); setArmed(null);
    const result = await run({ operation: remove ? "delete-model" : "download", model_id: model.id });
    if (result) setModels(result.models);
    else {
      const refreshed = await run({ operation: "models" }, true);
      if (refreshed) setModels(refreshed.models);
    }
    setActiveModel(null);
  }
  return <section>
    <h3 className="cp-pane-title">Video Intelligence</h3>
    <p className="cp-pane-sub">Find and understand video moments. Processed on your Mac.</p>
    <div className="cp-model-list">
      {models.map((model) => <div className="cp-model-row" key={model.id}>
        <div className="cp-model-info-wrap">
          <div className="cp-model-head"><IconSparkles size={13} stroke="var(--fg-3)" /><span className="name">{model.name}</span><span className="size">{size(model.bytes)}</span>{model.ready && <span className="badge installed">Installed</span>}</div>
          <p className="cp-settings-note tight">{descriptions[model.role]}</p>
          {busy && activeModel === model.id && progress?.total ? <progress aria-label={`${model.name} download`} value={progress.completed} max={progress.total} /> : null}
        </div>
        {busy && activeModel === model.id ? <button type="button" className="btn btn-ghost" onClick={stop}>Stop</button>
          : model.ready ? <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => armed === model.id ? void change(model, true) : setArmed(model.id)} onKeyDown={(event) => {
            if (event.key === "Escape" && armed === model.id) { event.stopPropagation(); setArmed(null); }
          }}>{armed === model.id ? `Delete ${size(model.bytes)}?` : "Delete"}</button>
          : <button type="button" className="btn btn-primary" disabled={busy} title={`Download ${model.name} · ${size(model.bytes)}`} onClick={() => void change(model, false)}>Download</button>}
      </div>)}
    </div>
    {busy && !activeModel && <p className="cp-settings-note" role="status">Checking local models…</p>}
    {error && <p className="cp-settings-note" role="alert">{error}</p>}
    <CollapsibleSection id="video-details" label="Details" open={details} onToggle={() => setDetails(!details)}>
      <p className="cp-settings-note tight">Choose videos in Library, then open Video Intelligence. Index only what you select. Stop keeps completed work.</p>
      <p className="cp-settings-note tight">Apple Silicon required. Search needs 16 GB of memory; video descriptions need 24 GB.</p>
      <p className="cp-settings-note tight">Downloads need internet. Analysis stays local; it does not identify people or replace transcription. Existing transcripts can provide dialogue context.</p>
      <p className="cp-settings-note tight">Playback and transcription take priority. If text AI is loaded, finish your conversation before freeing its memory for video.</p>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => {
        void invoke("stop_llm_server").then(() => setUnloadNote("Text model unloaded. It will reload when needed."), (cause) => setUnloadNote(formatError(cause)));
      }}>Unload text model</button>
      {unloadNote && <p className="cp-settings-note tight" role="status">{unloadNote}</p>}
    </CollapsibleSection>
  </section>;
}
