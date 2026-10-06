import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useDismiss } from "../hooks/use-dismiss";

/**
 * A small non-modal panel pinned to the control that opened it, drawn in a
 * portal so no `overflow: hidden` ancestor clips it. Focus starts on its first
 * control; Escape or a click outside closes it and, when focus was inside,
 * hands focus back to that control. The trigger stops its own mousedown, or
 * the outside click that opened the panel would close it again at once.
 */
export function AnchoredPopover({ anchor, onClose, label, id, className, above = false, alignEnd = false, children }: {
  anchor: RefObject<HTMLElement>; onClose: () => void; label: string; id?: string; className: string;
  /** Opens above the control, for one at the foot of a panel. */
  above?: boolean;
  /** Lines the right edges up, so it opens leftward from a control at the right. */
  alignEnd?: boolean;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null), [position, setPosition] = useState({ left: 0, top: 0 });
  const close = useCallback(() => {
    if (!panel.current || panel.current.contains(document.activeElement)) anchor.current?.focus();
    onClose();
  }, [anchor, onClose]);
  useDismiss(panel, close, true);
  useLayoutEffect(() => {
    const place = () => {
      const at = anchor.current?.getBoundingClientRect(), box = panel.current?.getBoundingClientRect();
      if (!at || !box) return;
      const left = alignEnd ? at.right - box.width : at.left, top = above ? at.top - box.height - 6 : at.bottom + 6;
      setPosition({ left: Math.max(8, Math.min(left, innerWidth - box.width - 8)), top: Math.max(8, Math.min(top, innerHeight - box.height - 8)) });
    };
    place();
    panel.current?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), summary")?.focus();
    const observer = new ResizeObserver(place);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [anchor, above, alignEnd]);
  return createPortal(<div ref={panel} id={id} className={className} role="dialog" aria-label={label} style={position}
    onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } }}>{children}</div>, document.body);
}
