import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AafOwnershipLabel } from "../bindings/AafOwnershipLabel";
import { useDismiss } from "../hooks/use-dismiss";
import { useMenuKeys } from "../hooks/use-menu-keys";

export type CueMenuTarget = { trackId: string; cueId: string; owner: string; heardOn: string | null; heardOnName: string | null; bleed: boolean; manual: boolean; x: number; y: number };

/**
 * Right-click on a line: the editor's final say on who said it. The resolver's
 * label is a suggestion; this is stored in the document and wins.
 */
export function MultitrackCueMenu({ target, onClose, onSet }: {
  target: CueMenuTarget | null; onClose: () => void; onSet: (label: AafOwnershipLabel | null, heardOn: string | null) => void;
}) {
  const menu = useRef<HTMLDivElement>(null), [position, setPosition] = useState({ left: 8, top: 8 });
  useDismiss(menu, onClose, !!target); useMenuKeys(menu, !!target, onClose);
  useLayoutEffect(() => {
    if (!target) return;
    const bounds = menu.current?.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(target.x, window.innerWidth - (bounds?.width ?? 240) - 8)), top: Math.max(8, Math.min(target.y, window.innerHeight - (bounds?.height ?? 160) - 8)) });
  }, [target]);
  if (!target) return null;
  const choose = (label: AafOwnershipLabel | null, heardOn: string | null) => { onClose(); onSet(label, heardOn); };
  return createPortal(<div ref={menu} className="cp-multitrack-track-menu" role="menu" aria-label="Who said this line" style={position}>
    <div className="cp-multitrack-track-menu-title">Who said this</div>
    <button role="menuitem" onClick={() => choose("owner", null)}>{target.owner}, on their own mic</button>
    <button role="menuitem" onClick={() => choose("bleed", target.heardOn)}>{target.heardOnName ? `Bleed from ${target.heardOnName}'s mic` : "Bleed from another mic"}</button>
    {target.manual && <button role="menuitem" onClick={() => choose(null, null)}>Use the automatic call</button>}
  </div>, document.body);
}
