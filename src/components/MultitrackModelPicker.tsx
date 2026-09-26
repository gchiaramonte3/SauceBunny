import type { WhisperModel } from "../bindings/WhisperModel";
import type { MultitrackModelChoice } from "../hooks/use-multitrack-transcription";

export function MultitrackModelPicker({ choice, models, disabled, onChange }: {
  choice: MultitrackModelChoice; models: WhisperModel[]; disabled?: boolean; onChange: (choice: MultitrackModelChoice) => void;
}) {
  return <><label><span>Engine</span><select className="cp-select" value={choice.engine} onChange={(event) => onChange({ ...choice, engine: event.target.value as MultitrackModelChoice["engine"] })} disabled={disabled}><option value="parakeet">Parakeet</option><option value="whisper">Whisper</option></select></label>
    <label><span>Model</span><select className="cp-select" value={choice.engine === "parakeet" ? "parakeet-tdt-0.6b-v3" : choice.modelId} onChange={(event) => onChange({ ...choice, modelId: event.target.value })} disabled={disabled || choice.engine === "parakeet" || !models.length}>
      {choice.engine === "parakeet" ? <option value="parakeet-tdt-0.6b-v3">Parakeet TDT 0.6B v3</option> : models.length ? models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>) : <option value="medium.en">No installed models</option>}</select></label>
    {choice.engine === "whisper" && <details className="cp-multitrack-asr-options">
      <summary>Options · {choice.fast ? "Fast" : "Accurate"}{choice.speechOnly ? " · Speech filter" : ""}</summary>
      <div><label><span>Decoding</span><select className="cp-select" value={choice.fast ? "fast" : "accurate"} disabled={disabled} onChange={event => onChange({ ...choice, fast: event.target.value === "fast" })}><option value="accurate">Accurate</option><option value="fast">Fast</option></select></label>
        <p>Fast trades some accuracy for speed.</p>
        <label><input type="checkbox" checked={choice.speechOnly === true} disabled={disabled} onChange={event => onChange({ ...choice, speechOnly: event.target.checked })} />Skip non-speech</label>
        <p>May miss quiet voices. Uses the installed speech detector; full audio if unavailable.</p>
      </div>
    </details>}</>;
}
