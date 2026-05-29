import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/**
 * Confirmation popover for the drag-to-merge gesture on speaker chips.
 * Opens at the drop site; Enter confirms, Escape cancels, click-outside
 * cancels.
 *
 * Extracted from TranscriptViewer.tsx (r46.B). Visual chrome is shared
 * with RenamePopover via the `.cp-tx-rename` class — same surface, same
 * shadow, same border treatment.
 */

export type MergeConfirmState = {
  sourceTag: string;
  sourceName: string;
  targetTag: string;
  targetName: string;
  rect: DOMRect;
};

type Props = {
  state: MergeConfirmState;
  onCancel: () => void;
  onConfirm: () => void;
};

export function MergeConfirmPopover({ state, onCancel, onConfirm }: Props) {
  const popRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!popRef.current?.contains(e.target as Node)) onCancel();
    }
    const t = setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
      else if (e.key === "Enter") onConfirm();
    }
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onCancel, onConfirm]);

  const POP_W = 300;
  const POP_H = 140;
  const top = Math.min(window.innerHeight - POP_H - 8, state.rect.bottom + 6);
  const left = Math.max(
    8,
    Math.min(window.innerWidth - POP_W - 8, state.rect.left - 8),
  );

  return createPortal(
    <div
      ref={popRef}
      className="cp-tx-rename cp-tx-merge"
      style={{ top, left, width: POP_W }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="cp-tx-rename-label">Merge speakers</div>
      <div className="cp-tx-merge-body">
        Treat every turn currently labelled <strong>{state.sourceName}</strong>{" "}
        as if it were said by <strong>{state.targetName}</strong>?
      </div>
      <div className="cp-tx-merge-hint">
        Reversible — peel the merge apart from the roster's <code>⌥N</code>{" "}
        button.
      </div>
      <div className="cp-tx-rename-actions">
        <button className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={onConfirm}>
          Merge
        </button>
      </div>
    </div>,
    document.body,
  );
}
