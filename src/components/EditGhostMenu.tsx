import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDismiss } from "../hooks/use-dismiss";
import { useMenuKeys } from "../hooks/use-menu-keys";

/** Right-click on a removed line: put it back. */
export function EditGhostMenu({ at, onRestore, onClose }: { at: { x: number; y: number }; onRestore: () => void; onClose: () => void }) {
  const menu = useRef<HTMLDivElement>(null), [position, setPosition] = useState({ left: at.x, top: at.y });
  useDismiss(menu, onClose, true);
  useMenuKeys(menu, true, onClose);
  useLayoutEffect(() => {
    const bounds = menu.current?.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(at.x, innerWidth - (bounds?.width ?? 200) - 8)), top: Math.max(8, Math.min(at.y, innerHeight - (bounds?.height ?? 60) - 8)) });
  }, [at]);
  return createPortal(<div ref={menu} className="cp-te-ghost-menu" role="menu" aria-label="Removed line" style={position}>
    <button type="button" role="menuitem" className="cp-popover-item" onClick={() => { onClose(); onRestore(); }}><span className="lbl">Restore this line</span></button>
  </div>, document.body);
}
