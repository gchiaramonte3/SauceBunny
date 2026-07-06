import { useRef } from "react";

/**
 * Floating text input for placing an annotation label on the frame — appears
 * where the reviewer clicked in label mode. Controlled (the overlay owns the
 * pending text) so commit/cancel decisions live in one place:
 *   Enter with text → onCommit · Esc → onCancel · blur → commit if text,
 *   else cancel (covers clicking anywhere off the input while empty).
 */
export function LabelInput({
  x, y, color, value, onChange, onCommit, onCancel,
}: {
  /** Anchor point, normalized 0..1 against the overlay. */
  x: number;
  y: number;
  /** Reviewer colour — tints the anchor dot + input border. */
  color: string;
  value: string;
  onChange: (s: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  // Guard against the commit firing twice (Enter keydown then the blur it
  // causes) — the second call would re-append the label.
  const doneRef = useRef(false);
  const finish = (commit: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (commit && value.trim()) onCommit();
    else onCancel();
  };
  return (
    <div
      className="cp-annot-label cp-annot-label-editing"
      style={{ left: `${x * 100}%`, top: `${y * 100}%`, ["--label-color" as string]: color }}
      // A click inside the input must not bubble to the canvas layer (which
      // would read it as "place another label here").
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span className="cp-annot-label-dot" aria-hidden />
      <input
        className="cp-annot-label-input"
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); finish(true); }
          if (e.key === "Escape") { e.preventDefault(); finish(false); }
        }}
        placeholder="Label…"
        aria-label="Annotation label text"
      />
    </div>
  );
}
