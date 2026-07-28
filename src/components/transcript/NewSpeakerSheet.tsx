import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Name the speaker you just pulled out of someone else's dialogue.
 *
 * Opens immediately after a split, because splitting and naming are one
 * intention: nobody lassoes a stretch of dialogue in order to create
 * "CAST_A". Leaving the tag unnamed and expecting the user to go and find it
 * in the roster would turn one gesture into three.
 *
 * Two ways out, deliberately. Type a name for a person who is not in the
 * transcript yet, or pick one who already is — because the commonest reason a
 * diarizer merges two people is that it also SPLIT one of them somewhere
 * else, and the fix for the second half is to fold the selection into an
 * existing speaker rather than invent another.
 */
export function NewSpeakerSheet({ suggestions, initialColor, onName, onPickExisting, onCancel }: {
  /** Speakers already in this transcript, ordered as the roster orders them. */
  suggestions: { tag: string; name: string; color: string }[];
  initialColor: string;
  onName: (name: string, color: string) => void;
  onPickExisting: (tag: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(initialColor);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onCancel(); } };
    // Capture, so it beats App's global key map the way the other dialogs do.
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  return createPortal(
    <div className="cp-spk-backdrop" onMouseDown={onCancel}>
      <div
        className="cp-newspk"
        role="dialog"
        aria-modal="true"
        aria-label="Name the new speaker"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="cp-newspk-head">Who is speaking?</div>
        <form
          className="cp-newspk-row"
          onSubmit={(e) => { e.preventDefault(); onName(name.trim(), color); }}
        >
          <button
            type="button"
            className="cp-newspk-pip"
            style={{ background: color }}
            // The colour is chosen by cycling rather than by opening a second
            // dialog on top of this one. A picker-in-a-picker for something
            // this small is more chrome than the decision deserves.
            onClick={() => setColor(nextColor(color))}
            aria-label="Change colour"
            title="Change colour"
          />
          <input
            ref={inputRef}
            className="cp-input cp-newspk-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            spellCheck={false}
            maxLength={60}
          />
          <button type="submit" className="btn btn-ghost btn-compact" disabled={!name.trim()}>
            Name them
          </button>
        </form>

        {suggestions.length > 0 && (
          <>
            <div className="cp-newspk-or">or give these lines to someone already here</div>
            <div className="cp-newspk-list">
              {suggestions.map((s) => (
                <button
                  key={s.tag}
                  type="button"
                  className="cp-newspk-suggest"
                  onClick={() => onPickExisting(s.tag)}
                >
                  <span className="cp-newspk-pip sm" style={{ background: s.color }} aria-hidden="true" />
                  {s.name}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Step to the next palette entry, wrapping. */
function nextColor(current: string): string {
  const i = PICKABLE.indexOf(current);
  return PICKABLE[(i + 1 + PICKABLE.length) % PICKABLE.length];
}

/**
 * The colours offered here.
 *
 * Kept in step with the speaker palette by construction rather than by
 * comment: these are the same solids the pips and caption labels use, so a
 * speaker named here cannot end up wearing a hue nothing else can produce.
 */
const PICKABLE = ["#6CFF8D", "#6D52ED", "#C54AF7", "#52B5ED", "#F7B84A", "#F7714A"];
