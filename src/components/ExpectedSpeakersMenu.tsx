import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDismiss } from "../hooks/use-dismiss";
import { useMenuKeys } from "../hooks/use-menu-keys";
import { IconChevronDown } from "./Icons";

const COUNTS = [0, 2, 3, 4, 5, 6];
const label = (n: number) => n === 0 ? "Auto" : n === 6 ? "6+" : String(n);

/** Scoped radio-menu exception: macOS select highlighting ignores app colors. */
export function ExpectedSpeakersMenu({ value, disabled, onChange }: {
  value: number; disabled: boolean; onChange: (value: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = useCallback(() => setOpen(false), []);
  const visible = open && !disabled;
  useDismiss(menu, close, visible);
  useMenuKeys(menu, visible, close);
  useLayoutEffect(() => {
    if (disabled) setOpen(false);
    if (!visible) return;
    const positionMenu = () => {
      const a = trigger.current?.getBoundingClientRect();
      const b = menu.current?.getBoundingClientRect();
      if (!a || !b) return;
      setPosition({ left: Math.max(8, Math.min(a.left, innerWidth - b.width - 8)),
        top: Math.max(8, Math.min(a.bottom + 4, innerHeight - b.height - 8)) });
    };
    positionMenu();
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    return () => { window.removeEventListener("resize", positionMenu); window.removeEventListener("scroll", positionMenu, true); };
  }, [visible, disabled]);
  return <>
    <button ref={trigger} type="button" className="cp-toolbar-disclosure cp-mini-select" disabled={disabled}
      aria-label={`Expected speakers: ${label(value)}`} aria-haspopup="menu" aria-expanded={visible} aria-controls={id}
      onMouseDown={e => e.stopPropagation()}
      onClick={e => { e.currentTarget.focus(); setOpen(v => !v); }}>
      {label(value)}<IconChevronDown size={12} />
    </button>
    {visible && createPortal(<div ref={menu} id={id} role="menu" aria-label="Expected speakers"
      className="cp-speaker-count-menu" style={position}>
      {COUNTS.map(n => <button type="button" key={n} role="menuitemradio" aria-checked={n === value}
        onClick={() => { onChange(n); close(); }}>{label(n)}</button>)}
    </div>, document.body)}
  </>;
}
