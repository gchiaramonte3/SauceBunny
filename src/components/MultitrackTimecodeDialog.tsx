import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AafManifest } from "../bindings/AafManifest";
import { useDismiss } from "../hooks/use-dismiss";
import { useModalFocus } from "../hooks/use-modal-focus";
import { sequenceEntryFrame } from "../lib/multitrack";
import { tcDigitsToDisplay } from "../lib/timecode";

/** Same digit-fill HUD as Clip, with modal keyboard ownership and AAF timing. */
export function MultitrackTimecodeDialog({ manifest, initialDigits, onClose, onSeek }: {
  manifest: AafManifest; initialDigits: string; onClose: () => void; onSeek: (frame: number) => void;
}) {
  const [digits, setDigits] = useState(initialDigits), [error, setError] = useState(false);
  const dialog = useRef<HTMLDivElement>(null), label = useId(), hint = useId();
  useModalFocus(true, dialog);
  useDismiss(dialog, onClose);
  const display = tcDigitsToDisplay(digits).replace(/:(\d{2})$/, manifest.drop_frame ? ";$1" : ":$1");
  return createPortal(<div className="cp-modal-scrim">
    <div ref={dialog} className="cp-tc-hud cp-multitrack-timecode-dialog" role="dialog" aria-modal="true" aria-labelledby={label} aria-describedby={hint} tabIndex={-1}
      onKeyDown={(event) => {
        // Keep transport shortcuts and letters out of this numeric-only HUD.
        event.stopPropagation();
        if (event.key === "Tab") return;
        event.preventDefault();
        if (event.key === "Escape") { onClose(); return; }
        if (event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return;
        if (/^\d$/.test(event.key)) { setDigits((value) => (value + event.key).slice(-8)); setError(false); }
        else if (event.key === "Backspace" || event.key === "Delete") { setDigits((value) => value.slice(0, -1)); setError(false); }
        else if (event.key === "Enter") {
          if (!digits) { onClose(); return; }
          const frame = sequenceEntryFrame(manifest, digits);
          if (frame == null) { setError(true); return; }
          onClose(); onSeek(frame);
        }
      }}>
      <div id={label} className="cp-tc-hud-label">Go to timecode</div>
      <div className="cp-tc-hud-value" role="status" aria-label="Entered timecode">{display}</div>
      <div id={hint} className="cp-tc-hud-hint">Return to snap · Esc to cancel</div>
      {error && <div className="cp-tc-hud-hint" role="alert">That frame number is skipped in drop-frame timecode.</div>}
    </div>
  </div>, document.body);
}
