import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useModalFocus } from "../hooks/use-modal-focus";
import { ReviewGrants } from "./ReviewGrants";
import "../styles/co-review-setup.css";

/** Lives outside the hidden setup rail. Keep the grant editor mounted when
 * closed: a newly issued invitation's secret cannot be fetched again. */
export function RoomAccessDialog({ open, sessionCode, onClose }: {
  open: boolean; sessionCode: string | null; onClose: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const visible = open && !!sessionCode;
  useModalFocus(visible, dialog);
  useEffect(() => {
    if (!visible) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
    };
    // A completed async action can disable its focused button, returning
    // focus to the body. Escape must still close the visible dialog.
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [visible, onClose]);
  return createPortal(<div className={(visible ? "cp-modal-backdrop " : "") + "cp-room-access-backdrop"} hidden={!visible}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialog} tabIndex={-1} className={(visible ? "cp-modal " : "") + "cp-room-access"} role={visible ? "dialog" : undefined}
      aria-modal={visible ? true : undefined} aria-label="Invite reviewers"
      onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape") { event.preventDefault(); onClose(); } }}>
      <header className="cp-modal-header"><h2>Invite reviewers</h2><span className="filler" />
        <button type="button" className="cp-modal-close" aria-label="Close invitations" onClick={onClose}>✕</button>
      </header>
      <div className="cp-modal-content"><ReviewGrants sessionCode={sessionCode} /></div>
    </section>
  </div>, document.body);
}
