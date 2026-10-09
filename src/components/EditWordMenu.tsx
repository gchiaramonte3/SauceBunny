import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDismiss } from "../hooks/use-dismiss";
import { useMenuKeys } from "../hooks/use-menu-keys";

/** Right-click on a line in the record: Mute it on its own track, or Unmute it when it is muted. */
export function EditWordMenu({ at, who, muted, onToggle, onClose }: {
  at: { x: number; y: number }; who: string; muted: boolean; onToggle: () => void; onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null), [position, setPosition] = useState({ left: at.x, top: at.y });
  useDismiss(menu, onClose, true);
  useMenuKeys(menu, true, onClose);
  useLayoutEffect(() => {
    const bounds = menu.current?.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(at.x, innerWidth - (bounds?.width ?? 200) - 8)), top: Math.max(8, Math.min(at.y, innerHeight - (bounds?.height ?? 60) - 8)) });
  }, [at]);
  return createPortal(<div ref={menu} className="cp-te-word-menu" role="menu" aria-label={`${who}'s line`} style={position}>
    <button type="button" role="menuitem" className="cp-popover-item" aria-keyshortcuts="Shift+Backspace" onClick={() => { onClose(); onToggle(); }}>
      <span className="lbl">{muted ? "Unmute" : "Mute"}</span></button>
  </div>, document.body);
}
