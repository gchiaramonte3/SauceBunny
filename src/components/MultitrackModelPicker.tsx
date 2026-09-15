import type { WhisperModel } from "../bindings/WhisperModel";
import type { MultitrackModelChoice } from "../hooks/use-multitrack-transcription";

export function MultitrackModelPicker({ choice, models, disabled, onChange }: {
  choice: MultitrackModelChoice; models: WhisperModel[]; disabled?: boolean; onChange: (choice: MultitrackModelChoice) => void;
}) {
  return <><label><span>Engine</span><select className="cp-select" value={choice.engine} onChange={(event) => onChange({ ...choice, engine: event.target.value as MultitrackModelChoice["engine"] })} disabled={disabled}><option value="parakeet">Parakeet</option><option value="whisper">Whisper</option></select></label>
    <label><span>Model</span><select className="cp-select" value={choice.engine === "parakeet" ? "parakeet-tdt-0.6b-v3" : choice.modelId} onChange={(event) => onChange({ ...choice, modelId: event.target.value })} disabled={disabled || choice.engine === "parakeet" || !models.length}>
      {choice.engine === "parakeet" ? <option value="parakeet-tdt-0.6b-v3">Parakeet TDT 0.6B v3</option> : models.length ? models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>) : <option value="medium.en">No installed models</option>}</select></label></>;
}
