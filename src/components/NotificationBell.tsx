import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { IconBell, IconReveal, IconCheck, IconAlert, IconInfo } from "./Icons";
import { formatRelative } from "../lib/upload-date";
import { usePopoverDismiss } from "../hooks/use-popover-dismiss";
import { useAnchoredPortal, placeBelowAlignRight } from "../hooks/use-anchored-portal";

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
  const unread = notifications.filter((n) => !n.read).length;

  // Using a portal here gets the dropdown OUT of the toolbar's stacking
  // context — the previous z-index:90 inside the toolbar still ended up
  // under the canvas/queue on some layouts because those siblings created
  // their own contexts.
  const anchor = useAnchoredPortal(open, ref, placeBelowAlignRight);
  usePopoverDismiss(open, [ref, popoverRef], () => setOpen(false));

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
        aria-label={unread > 0 ? `Notifications (${unread} new)` : "Notifications"}
        aria-expanded={open}
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
