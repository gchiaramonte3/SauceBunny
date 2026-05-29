import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { IconBell, IconReveal, IconCheck, IconAlert, IconInfo } from "./Icons";
import { formatRelative } from "../lib/upload-date";

export type Notif = {
  id: string;
  kind: "success" | "error" | "info";
  title: string;
  body: string;
  /** When set, the dropdown row gets a "Reveal in Finder" button. */
  path?: string;
  timestamp: number;
  read: boolean;
};

type Props = {
  notifications: Notif[];
  onMarkAllRead: () => void;
  onClearAll: () => void;
  onDismiss: (id: string) => void;
};

export function NotificationBell({ notifications, onMarkAllRead, onClearAll, onDismiss }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // Anchor coords for the portaled popover. Recomputed whenever it opens
  // (and on window resize while open) so it tracks the bell button even
  // after a sidebar collapse or window resize. Using a portal here gets
  // the dropdown OUT of the toolbar's stacking context — the previous
  // z-index:90 inside the toolbar still ended up under the canvas/queue
  // on some layouts because those siblings created their own contexts.
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const unread = notifications.filter((n) => !n.read).length;

  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const compute = () => {
      const r = ref.current!.getBoundingClientRect();
      setAnchor({
        top: r.bottom + 8,
        // Anchor to the right edge of the bell so the popover hangs
        // leftward. CSS positions via `right` from the viewport edge.
        right: window.innerWidth - r.right,
      });
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function toggle() {
    if (open) {
      setOpen(false);
    } else {
      setOpen(true);
      // Reading the list marks everything as read.
      if (unread > 0) onMarkAllRead();
    }
  }

  function reveal(path: string) {
    invoke("reveal_in_finder", { path }).catch(() => { /* ignore */ });
  }

  return (
    <div className="cp-notifications" ref={ref}>
      <button
        type="button"
        className={"btn-icon cp-notif-trigger" + (unread > 0 ? " has-unread" : "")}
        title={unread > 0 ? `${unread} new notification${unread === 1 ? "" : "s"}` : "Notifications"}
        onClick={toggle}
      >
        <IconBell size={15} />
        {unread > 0 && <span className="cp-notif-dot" />}
      </button>
      {open && anchor && createPortal(
        <div
          ref={popoverRef}
          className="cp-notif-popover"
          style={{
            // Position fixed to viewport so the portal renders above
            // every in-flow element regardless of stacking context.
            position: "fixed",
            top: anchor.top,
            right: anchor.right,
          }}
        >
          <div className="cp-notif-header">
            <span className="title">Activity</span>
            <div className="filler" />
            {notifications.length > 0 && (
              <button className="link" onClick={onClearAll}>Clear all</button>
            )}
          </div>
          <div className="cp-notif-list">
            {notifications.length === 0 ? (
              <div className="cp-notif-empty">Nothing yet. Exports, transcripts, and snapshots will show up here.</div>
            ) : notifications.map((n) => {
              const Icon = n.kind === "error" ? IconAlert : n.kind === "info" ? IconInfo : IconCheck;
              return (
                <div key={n.id} className={"cp-notif-item " + n.kind}>
                  <div className="cp-notif-icon"><Icon size={13} /></div>
                  <div className="cp-notif-body">
                    <div className="cp-notif-title">{n.title}</div>
                    <div className="cp-notif-text">{n.body}</div>
                    <div className="cp-notif-meta">
                      <span className="when">{formatRelative(n.timestamp)}</span>
                      {n.path && (
                        <button className="reveal" onClick={() => reveal(n.path!)}>
                          <IconReveal size={11} /> Reveal
                        </button>
                      )}
                      <button className="dismiss" onClick={() => onDismiss(n.id)}>Dismiss</button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
