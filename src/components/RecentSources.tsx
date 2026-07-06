import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconHistory } from "./Icons";
import { formatTimeAgo } from "../lib/transcript-history";
import { secondsToHms } from "../lib/timecode";
import type { RecentSource } from "../lib/recent-sources";
import { usePopoverDismiss } from "../hooks/use-popover-dismiss";
import { useAnchoredPortal, placeBelowAlignRight } from "../hooks/use-anchored-portal";

type Props = {
  entries: RecentSource[];
  /** Loads the source through the same handlers as paste/import. */
  onOpen: (entry: RecentSource) => void;
  onRemove: (value: string) => void;
  onClearAll: () => void;
};

/**
 * History button inside the URL bar + a portaled popover listing recent
 * sources. Same popover mechanics as NotificationBell: portal to body
 * (out of the toolbar's backdrop-filter stacking context), outside-click
 * + Escape to close. Adds ↑/↓ + Enter keyboard navigation.
 */
export function RecentSources({ entries, onOpen, onRemove, onClearAll }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // Clamp the keyboard cursor when rows are removed underneath it.
  const activeIdx = Math.min(active, Math.max(0, entries.length - 1));

  const anchor = useAnchoredPortal(open, ref, placeBelowAlignRight);
  usePopoverDismiss(open, [ref, popoverRef], () => setOpen(false));

  // Refs mirror props/state for the document-level key handler — avoids
  // re-binding the listener on every arrow press or entry change.
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const activeRef = useRef(activeIdx);
  activeRef.current = activeIdx;

  // ↑/↓ + Enter list navigation — popover-specific, so it stays out of the
  // shared dismiss hook (which owns outside-press + Escape).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const dir = e.key === "ArrowDown" ? 1 : -1;
        setActive((a) => {
          const n = entriesRef.current.length;
          return n === 0 ? 0 : (Math.min(a, n - 1) + dir + n) % n;
        });
      } else if (e.key === "Enter") {
        e.preventDefault();
        const entry = entriesRef.current[Math.min(activeRef.current, entriesRef.current.length - 1)];
        if (entry) { setOpen(false); onOpen(entry); }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onOpen]);

  // Removing the last row leaves nothing to show — close instead of
  // rendering an empty shell (the trigger disables itself at 0 entries).
  useEffect(() => {
    if (open && entries.length === 0) setOpen(false);
  }, [open, entries.length]);

  const pick = (entry: RecentSource) => { setOpen(false); onOpen(entry); };

  return (
    <div className="cp-recents" ref={ref}>
      <button
        type="button"
        className={"btn-icon cp-recents-trigger" + (open ? " active" : "")}
        title={entries.length > 0 ? "Recent sources" : "Recent sources — nothing yet"}
        disabled={entries.length === 0}
        onClick={(e) => { e.stopPropagation(); setActive(0); setOpen((o) => !o); }}
      >
        <IconHistory size={13} />
      </button>
      {open && anchor && createPortal(
        <div
          ref={popoverRef}
          className="cp-recents-pop"
          role="listbox"
          aria-label="Recent sources"
          style={{ position: "fixed", top: anchor.top, right: anchor.right }}
        >
          <div className="cp-recents-list">
            {entries.map((entry, i) => (
              <div
                key={entry.value}
                role="option"
                aria-selected={i === activeIdx}
                className={"cp-recents-row" + (i === activeIdx ? " active" : "")}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(entry)}
                title={entry.value}
              >
                <div className="cp-recents-row-main">
                  <span className="cp-recents-title">{entry.title}</span>
                  <span className={"cp-recents-badge " + entry.kind}>
                    {entry.kind === "url" ? "web" : "file"}
                  </span>
                </div>
                <div className="cp-recents-meta">
                  <span>{formatTimeAgo(entry.lastOpenedAt)}</span>
                  {entry.durationSeconds != null && <span>{secondsToHms(entry.durationSeconds)}</span>}
                </div>
                <button
                  type="button"
                  className="cp-recents-remove"
                  title="Remove from recents"
                  onClick={(e) => { e.stopPropagation(); onRemove(entry.value); }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <div className="cp-recents-foot">
            <button
              type="button"
              className="cp-recents-clear"
              onClick={() => { onClearAll(); setOpen(false); }}
            >
              Clear recents
            </button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
