import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Inline rename UI for a speaker chip. Anchored to the chip's bounding
 * rect (passed in by the parent) and portaled to <body> so it can
 * overflow the right-docked drawer and float above scroll.
 *
 * Extracted from TranscriptViewer.tsx (r46.B) — same behaviour, no
 * change to the layered-overrides logic which still lives in the
 * viewer (this component only collects user input and calls onApply).
 *
 * Scope semantics:
 *   "all"  — apply to every turn whose ORIGINAL tag matches.
 *   "turn" — apply only to the anchor turn.
 *
 * Click-outside + Escape both cancel; Enter commits. Auto-selects the
 * existing text on open so users can just type the new name.
 */

export type RenameState = {
  turnIdx: number;
  originalTag: string | null;
  currentName: string;
  rect: DOMRect;
};

type Props = {
  state: RenameState;
  onCancel: () => void;
  onApply: (name: string, scope: "all" | "turn") => void;
};

export function RenamePopover({ state, onCancel, onApply }: Props) {
  const [name, setName] = useState(state.currentName);
  const [scope, setScope] = useState<"all" | "turn">("all");
  const inputRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // Select-all on mount so typing replaces the existing name.
  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.select());
  }, []);

  // Click-outside closes. Deferred a tick so the click that opened the
  // popover doesn't immediately close it.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!popRef.current?.contains(e.target as Node)) onCancel();
    }
    const t = setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDoc);
    };
  }, [onCancel]);

  function commit() {
    onApply(name, scope);
  }

  // Clamp inside the viewport so the popover never spills off-screen
  // when the chip is near a corner.
  const POP_W = 260;
  const POP_H = 150;
  const top = Math.min(window.innerHeight - POP_H - 8, state.rect.bottom + 6);
  const left = Math.max(
    8,
    Math.min(window.innerWidth - POP_W - 8, state.rect.left - 8),
  );

  return createPortal(
    <div
      ref={popRef}
      className="cp-tx-rename"
      style={{ top, left, width: POP_W }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="cp-tx-rename-label">Rename speaker</div>
      <input
        ref={inputRef}
        className="cp-tx-rename-input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        placeholder="e.g. Tim, Marc, Interviewer"
        /* Spell-check ON — catches typos in real-word labels like
           "Interviewer" / "Moderator" / "Host". Proper nouns ("Tim")
           may squiggle, but that's a one-click "Learn Spelling" away
           via the native context menu and the catch-typos value
           outweighs the noise. */
        spellCheck
        lang="en"
        autoCorrect="off"
        autoComplete="off"
      />
      <div className="cp-tx-rename-scope">
        <label>
          <input
            type="radio"
            checked={scope === "all"}
            onChange={() => setScope("all")}
          />
          <span>
            Apply to every{" "}
            <strong>{state.originalTag ?? "Speaker"}</strong> in this transcript
          </span>
        </label>
        <label>
          <input
            type="radio"
            checked={scope === "turn"}
            onChange={() => setScope("turn")}
          />
          <span>Only this turn</span>
        </label>
      </div>
      <div className="cp-tx-rename-actions">
        <button className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={commit}>
          Rename
        </button>
      </div>
    </div>,
    document.body,
  );
}
