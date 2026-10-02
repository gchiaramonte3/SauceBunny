import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMenuKeys } from "../hooks/use-menu-keys";
import { useDismiss } from "../hooks/use-dismiss";

export type OrganizationMenuAction = { label: string; run: () => void; disabled?: boolean };

/** Same menu geometry and keyboard model as file actions, without file verbs. */
export function LibraryOrganizationMenu({ anchor, actions, onClose }: {
  anchor: { x: number; y: number }; actions: OrganizationMenuAction[]; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(anchor);
  // This menu unmounts on close. Restore the opener without stealing focus
  // from a dialog an action deliberately opened.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const menu = ref.current;
    return () => { if (opener?.isConnected && (document.activeElement === document.body || menu?.contains(document.activeElement))) opener.focus(); };
  }, []);
  useMenuKeys(ref, true, onClose);
  useDismiss(ref, onClose);
  useEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (box) setPosition({ x: Math.max(8, Math.min(anchor.x, innerWidth - box.width - 8)), y: Math.max(8, Math.min(anchor.y, innerHeight - box.height - 8)) });
  }, [anchor]);
  return createPortal(<div ref={ref} className="cp-lib-menu" role="menu" aria-label="Library organization actions" style={{ position: "fixed", left: position.x, top: position.y }}>
    {actions.map((action) => <button key={action.label} type="button" role="menuitem" className="cp-lib-menu-item" disabled={action.disabled} onClick={() => { onClose(); action.run(); }}>{action.label}</button>)}
  </div>, document.body);
}
