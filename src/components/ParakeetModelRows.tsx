import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatError } from "../lib/error-format";
import { newJobId } from "../lib/job-id";
import { PARAKEET_MODELS, PARAKEET_MODELS_CHANGED, type ParakeetModelId } from "../lib/parakeet-models";
import { IconSparkles } from "./Icons";
import { ModelDownloadProgress } from "./ModelDownloadProgress";

/** The model Clip and dictation run when Parakeet is the engine in use (`parakeet_model(None)` in transcript.rs). */
const CLIP_MODEL: ParakeetModelId = "parakeet-tdt-0.6b-v3";

type Props = {
  /** Parakeet is the transcription engine in use (Clip and dictation). */
  engineInUse: boolean;
  onUseAsDefault: () => void;
  /** The model the engine in use runs was deleted: fall back to Whisper so an engine is always usable. */
  onInUseDeleted: () => void;
  /** Settings' one arming state for every model Delete, keyed `parakeet:<id>`, so arming one disarms the others. */
  armed: string | null; onArm: (key: string | null) => void;
};

/**
 * Every Parakeet model, each with its own Download, Cancel and armed Delete.
 *
 * Settings listed one hard-coded row, v3, so Parakeet Ultra could only be
 * fetched from AAF Audio's model picker, and seen or deleted nowhere. The
 * owner asked for every model to download where the others do: here. AAF
 * Audio only says a model is missing and links to this page.
 */
export function ParakeetModelRows({ engineInUse, onUseAsDefault, onInUseDeleted, armed, onArm }: Props) {
  const [ready, setReady] = useState<Partial<Record<ParakeetModelId, boolean>>>({});
  const [busy, setBusy] = useState<ParakeetModelId | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Held BEFORE the download is awaited: FluidAudio reports no progress while
  // it transfers, so a download nothing can reach looks exactly like a hang.
  const parakeetJobRef = useRef<string | null>(null);
  const check = useCallback(async () => {
    const entries = await Promise.all(PARAKEET_MODELS.map(async (model) =>
      [model.id, await invoke<boolean>("parakeet_model_downloaded", { model: model.id }).catch(() => false)] as const));
    setReady(Object.fromEntries(entries));
  }, []);
  useEffect(() => { void check(); }, [check]);
  const changed = () => { void emit(PARAKEET_MODELS_CHANGED).catch(() => { /* AAF Audio checks again on focus too */ }); };
  const download = async (model: ParakeetModelId) => {
    if (parakeetJobRef.current) return;
    const id = newJobId();
    parakeetJobRef.current = id;
    setBusy(model); setError(null);
    try { await invoke("download_parakeet_model", { jobId: id, model }); }
    catch (cause) { setError(formatError(cause)); }
    finally { parakeetJobRef.current = null; setBusy(null); await check(); changed(); }
  };
  const cancel = () => {
    const id = parakeetJobRef.current;
    if (id) void invoke("cancel_job", { jobId: id }).catch(() => { /* already finished */ });
  };
  const remove = async (model: ParakeetModelId) => {
    setError(null);
    try {
      await invoke("delete_parakeet_model", { model });
      if (model === CLIP_MODEL && engineInUse) onInUseDeleted();
    } catch (cause) { setError(formatError(cause)); }
    finally { await check(); changed(); }
  };
  return <div className="cp-models">
    {PARAKEET_MODELS.map((model, index) => {
      const installed = ready[model.id], clip = model.id === CLIP_MODEL, inUse = clip && installed === true && engineInUse, key = `parakeet:${model.id}`;
      return <div key={model.id} className={"cp-model-row" + (inUse ? " selected" : "")}>
        <div className="cp-model-info-wrap">
          <div className="cp-model-head">
            <IconSparkles size={13} stroke="var(--fg-3)" />
            <span className="name">{model.name}</span>
            <span className="size">{model.size}</span>
            {/* The list leads with the one to recommend (lib/parakeet-models). */}
            {index === 0 && <span className="badge recommended">Recommended</span>}
            {installed && <span className="badge installed">Installed</span>}
            {inUse && <span className="badge selected">In use</span>}
          </div>
          {busy === model.id && <ModelDownloadProgress name={model.name} />}
        </div>
        <div className="cp-model-actions">
          {installed === undefined ? <span className="size">checking…</span>
            : !installed ? busy === model.id
              ? <button className="btn btn-ghost" onClick={cancel} title={`Stop downloading ${model.name}. Nothing is kept; you can start again.`}>Cancel</button>
              : <button className="btn btn-ghost" disabled={!!busy} onClick={() => { void download(model.id); }}>Download</button>
            : <>
              {clip && !inUse && <button className="btn btn-ghost" onClick={onUseAsDefault}>Use as default</button>}
              <button className={"btn btn-ghost" + (armed === key ? " armed" : "")}
                onClick={() => { if (armed === key) { onArm(null); void remove(model.id); } else onArm(key); }}
                title={`Delete ${model.name} from disk. Downloading it again is ${model.size}.`}
                aria-label={armed === key ? `Confirm deleting ${model.name}` : `Delete ${model.name}`}>
                {armed === key ? `Delete ${model.size}?` : "Delete"}</button>
            </>}
        </div>
      </div>;
    })}
    {busy && <div className="cp-source-hint muted">Downloading {PARAKEET_MODELS.find((model) => model.id === busy)?.name}. It runs once,
      can take a few minutes and reports no progress while it transfers. You can keep using the app meanwhile.</div>}
    {error && <div className="cp-source-hint err" role="alert">{error}</div>}
  </div>;
}
