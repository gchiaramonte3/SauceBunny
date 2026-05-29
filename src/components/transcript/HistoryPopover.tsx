import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  formatTimeAgo,
  type TranscriptHistoryEntry,
} from "../../lib/transcript-history";

/**
 * "Recent transcripts" popover anchored to the History button in the
 * transcript viewer header. Portaled to <body> so it can overflow the
 * right-docked drawer and float above scroll.
 *
 * Extracted from TranscriptViewer.tsx (r46.B). State (entries list,
 * removal) is owned by the parent — this component is a pure renderer.
 */

type Props = {
  /** Bounding rect of the History trigger button — used for positioning. */
  anchor: DOMRect;
  entries: TranscriptHistoryEntry[];
  /** Currently-loaded path; highlighted in the list. */
  activePath: string | null;
  onClose: () => void;
  onPick: (entry: TranscriptHistoryEntry) => void;
  onRemove: (id: string) => void;
};

export function HistoryPopover({
  anchor, entries, activePath, onClose, onPick, onRemove,
}: Props) {
  const popRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!popRef.current?.contains(e.target as Node)) onClose();
    }
    // Defer so the click that opened the popover doesn't immediately close it.
    const t = setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDoc);
    };
  }, [onClose]);

  const POP_W = 340;
  const POP_H_MAX = 360;
  // Position under the button, right-aligned to it so it doesn't spill
  // off-screen on a narrow drawer.
  const top = Math.min(window.innerHeight - 16, anchor.bottom + 4);
  const left = Math.max(
    8,
    Math.min(window.innerWidth - POP_W - 8, anchor.right - POP_W),
  );

  return createPortal(
    <div
      ref={popRef}
      className="cp-tx-history"
      style={{ top, left, width: POP_W, maxHeight: POP_H_MAX }}
      onClick={(e) => e.stopPropagation()}
      role="menu"
      aria-label="Transcript history"
    >
      <div className="cp-tx-history-head">
        <span>Recent transcripts</span>
        {entries.length > 0 && (
          <span className="cp-tx-history-count">{entries.length}</span>
        )}
      </div>
      {entries.length === 0 ? (
        <div className="cp-tx-history-empty">
          No transcripts yet. They'll appear here automatically each time
          you generate or download one.
        </div>
      ) : (
        <div className="cp-tx-history-list">
          {entries.map((e) => {
            const isActive = e.srtPath === activePath;
            const originLabel =
              e.origin === "captions" ? "YT" :
              e.origin === "whisper"  ? "Whisper" :
              "—";
            return (
              <div
                key={e.id}
                className={"cp-tx-history-row" + (isActive ? " active" : "")}
                onClick={() => onPick(e)}
                role="menuitem"
              >
                <div className="cp-tx-history-row-main">
                  <div className="cp-tx-history-row-title" title={e.srtPath}>
                    {e.title}
                  </div>
                  <div className="cp-tx-history-row-meta">
                    <span className="cp-tx-history-origin">{originLabel}</span>
                    <span>·</span>
                    <span>{formatTimeAgo(e.lastOpenedAt)}</span>
                    {isActive && (
                      <>
                        <span>·</span>
                        <span className="cp-tx-history-active-pill">open</span>
                      </>
                    )}
                  </div>
                </div>
                <button
                  className="cp-tx-history-row-remove"
                  onClick={(ev) => { ev.stopPropagation(); onRemove(e.id); }}
                  title="Remove from history (file on disk is kept)"
                  aria-label="Remove from history"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>,
    document.body,
  );
}
