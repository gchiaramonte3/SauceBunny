import { useEffect, useRef, useState } from "react";
import { SpeakerColorPicker } from "../SpeakerColorPicker";
import { createPortal } from "react-dom";
import { KindGlyph } from "./KindGlyph";

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

/** One reassignment target — a known speaker from the roster. */
export type ReassignChoice = {
  /** Canonical roster tag ("Speaker" sentinel for the untagged group). */
  tag: string;
  /** Display name (after any global rename). */
  name: string;
  /** Pip background (gradient or custom hex) — matches the roster chip. */
  color: string;
  /** Seconds of speech. The list is ordered by it, like every other speaker
   *  list in the app. */
  talkSeconds: number;
};

type Props = {
  state: RenameState;
  onCancel: () => void;
  onApply: (name: string, scope: "all" | "turn") => void;
  /** 4a: the same color plumbing Manage speakers uses - a compact preset
   *  row; picking commits through the shared override path (and so fires
   *  speakers-changed, recoloring the timeline lane too). */
  colorValue?: string;
  onPickColor?: (hex: string) => void;
  /** Jump the transcript to where this speaker first appears, then close.
   *  Optional so any caller without a viewport stays valid. */
  onGoToSpeaker?: () => void;
  /** Other known speakers this ONE turn can be reassigned to. When present
   *  (and non-empty) the popover grows a "this turn is actually …" row —
   *  the per-turn twin of drag-to-merge, for the "the diarizer got this one
   *  turn wrong" case. Omitted → classic rename-only popover. */
  reassignChoices?: ReassignChoice[];
  /** Reassign the anchor turn to `tag`. Parent applies + closes. */
  onReassign?: (tag: string) => void;
};

export function RenamePopover({
  state, onCancel, onApply, onGoToSpeaker, reassignChoices, onReassign,
  colorValue, onPickColor,
}: Props) {
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

  const showReassign = !!onReassign && !!reassignChoices && reassignChoices.length > 0;

  // Clamp inside the viewport so the popover never spills off-screen
  // when the chip is near a corner.
  const POP_W = 288;
  const POP_H = showReassign ? 210 : 150;
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
      <div className="cp-tx-rename-label">
        Rename <span className="cp-tx-rename-target">{state.currentName}</span>
      </div>
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
      {colorValue && onPickColor && (
        <SpeakerColorPicker compact value={colorValue} anchorRect={null} onCommit={onPickColor} onClose={() => {}} />
      )}
      <div className="cp-tx-rename-scope">
        <label>
          <input
            type="radio"
            checked={scope === "all"}
            onChange={() => setScope("all")}
          />
          <span>
            Apply to every{" "}
            <strong>{state.currentName}</strong> in this transcript
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
      {showReassign && (
        <div className="cp-tx-rename-assign">
          <div className="cp-tx-rename-assign-label">…or this turn is actually</div>
          {/* Rows in a scroll box, not a wrapped cloud of pills.
              The cloud was fine at four speakers and at twenty-six it ran off
              the bottom of the popover with its last row sliced in half, in
              first-appearance order. Rows also let this list carry the same
              badge and talk time as the Speakers view and the roster, so the
              four places that list speakers finally look like one app. */}
          <div className="cp-tx-rename-assign-list" role="listbox" aria-label="Reassign this turn to a known speaker">
            {reassignChoices!.map((c) => (
              <button
                key={c.tag}
                role="option"
                aria-selected={false}
                className="cp-tx-rename-assign-btn"
                onClick={() => onReassign!(c.tag)}
                title={`Reassign only this turn to ${c.name}`}
              >
                <span className="cp-tx-rename-assign-pip" style={{ background: c.color }} aria-hidden>
                  <KindGlyph tag={c.tag === "Speaker" ? null : c.tag} name={c.name} size={11} />
                </span>
                <span className="cp-tx-rename-assign-name">{c.name}</span>
                <span className="cp-tx-rename-assign-talk">{formatTalk(c.talkSeconds)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="cp-tx-rename-actions">
        {onGoToSpeaker && (
          <button
            className="btn btn-ghost cp-tx-rename-goto"
            onClick={onGoToSpeaker}
            title="Jump to where this speaker first appears"
          >
            Go to speaker
          </button>
        )}
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

/** Talk time, short enough to sit at the end of a narrow row. */
function formatTalk(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
