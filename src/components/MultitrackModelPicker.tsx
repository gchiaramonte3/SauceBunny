import type { WhisperModel } from "../bindings/WhisperModel";
import type { MultitrackModelChoice } from "../hooks/use-multitrack-transcription";
import type { useParakeetModels } from "../hooks/use-parakeet-models";
import { PARAKEET_MODELS, type ParakeetModelId } from "../lib/parakeet-models";

type Parakeet = Pick<ReturnType<typeof useParakeetModels>, "ready" | "downloading" | "downloadError" | "download" | "cancel">;

export function MultitrackModelPicker({ choice, models, disabled, onChange, parakeet }: {
  choice: MultitrackModelChoice; models: WhisperModel[]; disabled?: boolean; onChange: (choice: MultitrackModelChoice) => void; parakeet?: Parakeet;
}) {
  const parakeetModel = choice.parakeetModel ?? PARAKEET_MODELS[0].id;
  const chosen = PARAKEET_MODELS.find((model) => model.id === parakeetModel) ?? PARAKEET_MODELS[0];
  const missing = choice.engine === "parakeet" && parakeet && !parakeet.ready[parakeetModel];
  return <><label><span>Engine</span><select className="cp-select" value={choice.engine} onChange={(event) => onChange({ ...choice, engine: event.target.value as MultitrackModelChoice["engine"] })} disabled={disabled}><option value="parakeet">Parakeet</option><option value="whisper">Whisper</option></select></label>
    <label><span>Model</span>{choice.engine === "parakeet"
      ? <select className="cp-select" value={parakeetModel} onChange={(event) => onChange({ ...choice, parakeetModel: event.target.value as ParakeetModelId })} disabled={disabled}>
        {PARAKEET_MODELS.map((model) => <option key={model.id} value={model.id}>{model.name}{parakeet && !parakeet.ready[model.id] ? " (not downloaded)" : ""}</option>)}</select>
      : <select className="cp-select" value={choice.modelId} onChange={(event) => onChange({ ...choice, modelId: event.target.value })} disabled={disabled || !models.length}>
        {models.length ? models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>) : <option value="medium.en">No installed models</option>}</select>}</label>
    {missing && <div className="cp-multitrack-model-download">
      {parakeet.downloading === parakeetModel
        ? <><span role="status">Downloading {chosen.name}. It reports no progress while it transfers.</span><button type="button" className="btn btn-ghost" onClick={parakeet.cancel}>Cancel download</button></>
        : <button type="button" className="btn btn-ghost" disabled={disabled || !!parakeet.downloading} onClick={() => { void parakeet.download(parakeetModel); }}>Download {chosen.name} ({chosen.size})</button>}
      {parakeet.downloadError && <span role="alert">{parakeet.downloadError}</span>}
    </div>}
    <label className="cp-multitrack-names" title="Tells the recognizer the mic owners' names so they are spelled right. It can occasionally respell a word that sounds like a name; Parakeet downloads a 100 MB speller the first time.">
      <input type="checkbox" checked={choice.castNames === true} disabled={disabled} onChange={(event) => onChange({ ...choice, castNames: event.target.checked })} />Spell cast names</label>
    {choice.engine === "whisper" && <details className="cp-multitrack-asr-options">
      <summary>Options · {choice.fast ? "Fast" : "Accurate"}{choice.speechOnly ? " · Speech filter" : ""}</summary>
      <div><label><span>Decoding</span><select className="cp-select" value={choice.fast ? "fast" : "accurate"} disabled={disabled} onChange={event => onChange({ ...choice, fast: event.target.value === "fast" })}><option value="accurate">Accurate</option><option value="fast">Fast</option></select></label>
        <p>Fast trades some accuracy for speed.</p>
        <label><input type="checkbox" checked={choice.speechOnly === true} disabled={disabled} onChange={event => onChange({ ...choice, speechOnly: event.target.checked })} />Skip non-speech</label>
        <p>May miss quiet voices. Uses the installed speech detector; full audio if unavailable.</p>
      </div>
    </details>}</>;
}
