import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { formatError } from "../lib/error-format";
import type { VideoModel } from "../bindings/VideoModel";
import { useVideoIntelligence } from "../hooks/use-video-intelligence";
import { CollapsibleSection } from "./CollapsibleSection";
import { IconSparkles } from "./Icons";
import { ModelDownloadProgress } from "./ModelDownloadProgress";
import { usePictureModelPreference } from "../hooks/use-picture-model";
import { isPictureModel, PICTURE_MODELS } from "../lib/picture-model";

const descriptions: Record<string, string> = {
  embedding: "Find moments by what’s on screen.",
  reranker: "Refine the closest matches. Optional.",
  reasoning: "Describe selected moments.",
  audio: "Analyze music and sound. Optional. Classifier suggestions need review.",
};
const size = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
const groups = [
  { title: "Picture analysis", roles: ["reasoning"], note: "Choose the default for Clip’s Picture model menu." },
  { title: "Audio analysis", roles: ["audio"], note: "" },
  { title: "Video search", roles: ["embedding", "reranker"], note: "Used by Video Intelligence in Library." },
];

export function VideoIntelligenceSettings() {
  const preference = usePictureModelPreference();
  const [models, setModels] = useState<VideoModel[]>([]);
  const [details, setDetails] = useState(false);
  const [activeModel, setActiveModel] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
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
    setActiveModel(model.id); setRemoving(remove); setArmed(null);
    const result = await run({ operation: remove ? "delete-model" : "download", model_id: model.id });
    if (result) setModels(result.models);
    else {
      const refreshed = await run({ operation: "models" }, true);
      if (refreshed) setModels(refreshed.models);
    }
    setActiveModel(null);
    void emit("panel:video-models-changed").catch(() => { /* Rechecked before Analyze. */ });
  }
  const sections = [...groups, { title: "Other models", roles: models.map(model => model.role).filter(role => !groups.some(group => group.roles.includes(role))), note: "" }];
  return <section className="cp-video-model-settings">
    <h3 className="cp-pane-title">Video Intelligence</h3>
    <p className="cp-pane-sub">Find and understand video moments. Processed on your Mac.</p>
    {sections.map(group => {
      const members = models.filter(model => group.roles.includes(model.role)).sort((a, b) =>
        PICTURE_MODELS.findIndex(item => item.id === a.id) - PICTURE_MODELS.findIndex(item => item.id === b.id));
      if (!members.length) return null;
      return <section className="cp-video-model-group" key={group.title} aria-label={group.title}>
        <h4>{group.title}</h4>
        {group.note && <p className="cp-settings-note tight">{group.note}</p>}
        <div className="cp-model-list">
      {members.map((model) => <div className={`cp-model-row${isPictureModel(model.id) && preference.id === model.id ? " selected" : ""}`} key={model.id}>
        <div className="cp-model-info-wrap">
          <div className="cp-model-head"><IconSparkles size={13} stroke="var(--fg-3)" /><span className="name">{model.name}</span><span className="size">{size(model.bytes)}</span>{model.ready && <span className="badge installed">Installed</span>}{isPictureModel(model.id) && preference.id === model.id && <span className="badge selected">Default</span>}</div>
          <p className="cp-settings-note tight">{descriptions[model.role]}</p>
          {busy && activeModel === model.id && !removing && <ModelDownloadProgress name={model.name}
            done={progress?.phase === "downloading" ? progress.completed : undefined}
            total={progress?.phase === "downloading" ? progress.total : undefined} />}
          {busy && activeModel === model.id && removing && <p className="cp-settings-note tight" role="status">Removing…</p>}
        </div>
        <div className="cp-model-actions">
        {model.ready && isPictureModel(model.id) && preference.id !== model.id && <button type="button" className="btn btn-ghost" disabled={busy}
          onClick={() => { if (isPictureModel(model.id)) { preference.select(model.id); setArmed(null); } }}>Use as default</button>}
        {busy && activeModel === model.id ? <button type="button" className="btn btn-ghost" onClick={stop}>Stop</button>
          : model.ready ? <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => armed === model.id ? void change(model, true) : setArmed(model.id)} onKeyDown={(event) => {
            if (event.key === "Escape" && armed === model.id) { event.stopPropagation(); setArmed(null); }
          }}>{armed === model.id ? `Delete ${size(model.bytes)}?` : "Delete"}</button>
          : <button type="button" className="btn btn-primary" disabled={busy} title={`Download ${model.name} · ${size(model.bytes)}`} onClick={() => void change(model, false)}>Download</button>}
        </div>
      </div>)}
        </div>
      </section>;
    })}
    {busy && !activeModel && <p className="cp-settings-note" role="status">Checking local models…</p>}
    {error && <p className="cp-settings-note" role="alert">{error}</p>}
    {preference.error && <p className="cp-settings-note" role="alert">{preference.error}</p>}
    <CollapsibleSection id="video-details" label="Details" open={details} onToggle={() => setDetails(!details)}>
      <p className="cp-settings-note tight">Analyze the open video in Clip, or choose files in Library for search. Index only what you select. Stop keeps completed work.</p>
      <p className="cp-settings-note tight">Apple Silicon required. Search and AudioSet analysis need 16 GB of memory; video descriptions need 24 GB.</p>
      <p className="cp-settings-note tight">Downloads need internet. Analysis stays local; it does not identify people or replace transcription. Existing transcripts can provide dialogue context.</p>
      <p className="cp-settings-note tight">Playback and transcription take priority. If text AI is loaded, finish your conversation before freeing its memory for video.</p>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => {
        void invoke("stop_llm_server").then(() => setUnloadNote("Text model unloaded. It will reload when needed."), (cause) => setUnloadNote(formatError(cause)));
      }}>Unload text model</button>
      {unloadNote && <p className="cp-settings-note tight" role="status">{unloadNote}</p>}
    </CollapsibleSection>
  </section>;
}
