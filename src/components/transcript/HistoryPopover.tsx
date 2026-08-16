import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { createPortal } from "react-dom";
import { useDismiss } from "../../hooks/use-dismiss";
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
  /** Empty the list (SRT files on disk are kept). */
  onClearAll: () => void;
};

export function HistoryPopover({
  anchor, entries, activePath, onClose, onPick, onRemove, onClearAll,
}: Props) {
  const popRef = useRef<HTMLDivElement>(null);
  // Every entry opens; this probe only tells the user (and the loader)
  // whether the VIDEO still exists, so a transcript with a missing video
  // opens on its own instead of shadowing whatever else is loaded.
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let live = true;
    void (async () => {
      const gone = new Set<string>();
      for (const e of entries) {
        if (e.sourcePath) {
          const ok = await invoke<number>("get_file_size", { path: e.sourcePath })
            .then(() => true)
            .catch(() => false);
          if (!ok) gone.add(e.id);
        } else if (!e.sourceUrl) {
          gone.add(e.id);
        }
      }
      if (live) setMissing(gone);
    })();
    return () => { live = false; };
  }, [entries]);
  // Escape included, which this popover was missing entirely.
  useDismiss(popRef, onClose);

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
        {entries.length > 0 && (
          <button
            type="button"
            className="cp-tx-history-clear"
            onClick={(e) => { e.stopPropagation(); onClearAll(); }}
            title="Empty this list (the transcript files on disk are kept)"
          >
            Clear all
          </button>
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
            const gone = missing.has(e.id);
            const originLabel =
              e.origin === "captions" ? "YT" :
              e.origin === "whisper"  ? "Whisper" :
              "File";
            return (
              <div
                key={e.id}
                className={"cp-tx-history-row" + (isActive ? " active" : "")}
                onClick={() => onPick(e)}
                // Focusable and activatable from the keyboard. This row claims
                // role="menuitem" and had neither, so the history was mouse
                // only: nothing to Tab to, no arrow keys, no way to open an
                // entry - while announcing itself to a screen reader as a menu
                // full of items.
                //
                // NOT a <button>, which would be the tidier fix elsewhere: the
                // row already contains the remove button, and a button inside a
                // button is invalid. tabIndex + Enter/Space is the ARIA menu
                // pattern anyway.
                tabIndex={0}
                onKeyDown={(ev) => {
                  if (ev.key !== "Enter" && ev.key !== " ") return;
                  // Let the nested remove button handle its own activation.
                  if (ev.target !== ev.currentTarget) return;
                  ev.preventDefault();
                  onPick(e);
                }}
                role="menuitem"
                title={gone ? "Opens on its own - this transcript's video can't be found" : "Opens with its video"}
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
                    {gone && (
                      <>
                        <span>·</span>
                        <span className="cp-tx-history-gone">no video</span>
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
