import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDismiss } from "../hooks/use-dismiss";
import { useMenuKeys } from "../hooks/use-menu-keys";
import type { StripTab } from "./TabStrip";

/** The "N more" button at the end of a tab strip, and the menu of tabs that did not fit. */
export function TabOverflowMenu({ tabs, selected, noun, onSelect, buttonRef }: {
  tabs: StripTab[]; selected: string; noun: string; onSelect: (id: string) => void;
  buttonRef: React.RefObject<HTMLButtonElement>;
}) {
  const [open, setOpen] = useState(false), [position, setPosition] = useState({ left: 0, top: 0 });
  const menu = useRef<HTMLDivElement>(null), id = useId();
  const close = useCallback(() => setOpen(false), []);
  const visible = open && tabs.length > 0;
  useDismiss(menu, close, visible);
  useMenuKeys(menu, visible, close);
  useLayoutEffect(() => {
    if (!visible) return;
    const place = () => {
      const a = buttonRef.current?.getBoundingClientRect(), b = menu.current?.getBoundingClientRect();
      if (!a || !b) return;
      setPosition({ left: Math.max(8, Math.min(a.right - b.width, innerWidth - b.width - 8)),
        top: Math.max(8, Math.min(a.bottom + 4, innerHeight - b.height - 8)) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [visible, buttonRef]);
  const name = `${tabs.length} more ${noun}`;
  return <>
    <button ref={buttonRef} type="button" className="cp-tabstrip-more" hidden={!tabs.length}
      aria-label={name} title={name} aria-haspopup="menu" aria-expanded={visible} aria-controls={visible ? id : undefined}
      onMouseDown={(event) => event.stopPropagation()} onClick={() => setOpen((value) => !value)}>
      {tabs.length} more
    </button>
    {visible && createPortal(<div ref={menu} id={id} role="menu" aria-label={name} className="cp-tabstrip-menu" style={position}>
      {tabs.map((tab) => <button type="button" key={tab.id} role="menuitemradio" aria-checked={tab.id === selected}
        onClick={() => { close(); onSelect(tab.id); }}>
        {tab.swatch && <span className="cp-tabstrip-swatch" style={{ background: tab.swatch }} aria-hidden="true" />}{tab.label}
      </button>)}
    </div>, document.body)}
  </>;
}
