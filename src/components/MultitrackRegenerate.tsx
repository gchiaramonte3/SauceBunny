import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { WhisperModel } from "../bindings/WhisperModel";
import type { MultitrackModelChoice } from "../hooks/use-multitrack-transcription";
import { useModalFocus } from "../hooks/use-modal-focus";
import { MultitrackModelPicker } from "./MultitrackModelPicker";
import { GenerateButton } from "./GenerateButton";

export function MultitrackRegenerate({ owner, initial, models, parakeetReady, onClose, onStart }: {
  owner: string; initial: MultitrackModelChoice; models: WhisperModel[]; parakeetReady: boolean;
  onClose: () => void; onStart: (choice: MultitrackModelChoice) => void;
}) {
  const [choice, setChoice] = useState(initial), dialog = useRef<HTMLDivElement>(null);
  useModalFocus(true, dialog);
  const ready = choice.engine === "parakeet" ? parakeetReady : models.some((model) => model.id === choice.modelId);
  return createPortal(<div className="cp-modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} className="cp-multitrack-settings" role="dialog" aria-modal="true" aria-label={`Regenerate ${owner}`} tabIndex={-1} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
      <header><h2>Regenerate {owner}</h2><button className="btn btn-ghost" aria-label="Close regenerate" onClick={onClose}>×</button></header>
      <p>Transcribe this track's entire sequence with the selected engine. Its saved transcript stays available until the replacement succeeds. Other tracks stay unchanged.</p>
      <div className="cp-multitrack-options"><MultitrackModelPicker choice={choice} models={models} onChange={setChoice} /></div>
      {!ready && <p>An installed model is required. Download it in Settings first.</p>}
      <footer><button className="btn btn-ghost" onClick={onClose}>Cancel</button><GenerateButton idleLabel="Regenerate track" loading={false} disabled={!ready} onClick={() => onStart(choice)} /></footer>
    </div>
  </div>, document.body);
}
