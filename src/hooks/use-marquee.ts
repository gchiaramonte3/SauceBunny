import { useCallback, useEffect, useRef, useState } from "react";
import {
  isDrag, marqueeRect, marqueeSelection, pathsInRect, type Point, type Rect,
} from "../lib/marquee";

/**
 * Drag a band over the file wall to select what it touches.
 *
 * STARTS ONLY ON EMPTY SPACE. A press that lands on a card is that card's
 * click (or the beginning of a drag-out to Finder, later); starting a band
 * there would make every click-and-wiggle on a file select its neighbours.
 * The pane's blank gutter is the one place a band can begin.
 *
 * MEASURED ONCE, AT PRESS. Item rectangles are read when the drag starts, not
 * per pointer move — a getBoundingClientRect for every row on every mousemove
 * is a layout thrash at exactly the moment the UI must stay smooth. Rows do not
 * move mid-drag, so one read is also the correct one. The exception is scroll,
 * which is why the boxes are stored in CONTENT coordinates (offset by the
 * scroll position) rather than viewport ones: auto-scrolling during a drag then
 * keeps hitting the right items.
 */
export function useMarquee({
  containerRef, itemSelector, pathAttr = "data-path", gutterSelector, onSelect, onEnd,
}: {
  containerRef: React.RefObject<HTMLElement | null>;
  /** CSS selector matching one element per item. */
  itemSelector: string;
  /** Attribute on each item holding its path. */
  pathAttr?: string;
  /**
   * Extra elements that count as blank space.
   *
   * In the Library's folder pane the scroll container IS the grid, so every
   * gap between cards is the container itself and `target === currentTarget`
   * is the whole test. The web and frames shelves group their cards into
   * per-source sections, so the gaps belong to a section or an inner grid
   * two levels down and that test is almost never true - a band there could
   * only be started on the pane's own padding. Naming those wrappers lets a
   * press on them start a band, without loosening the rule for shelves that
   * do not need it.
   */
  gutterSelector?: string;
  /** Called live during the drag with the paths the band covers. */
  onSelect: (paths: string[], mods: { shift: boolean; meta: boolean }) => void;
  /** Fired when the band finishes or is abandoned, so the caller can forget
   *  the pre-drag selection it was composing against. */
  onEnd?: () => void;
}) {
  /** The band in CONTENT coords, or null when no drag is running. */
  const [band, setBand] = useState<Rect | null>(null);
  const startRef = useRef<Point | null>(null);
  const boxesRef = useRef<{ path: string; rect: Rect }[]>([]);
  const modsRef = useRef({ shift: false, meta: false });
  const movedRef = useRef(false);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // Only a press on blank space, and only the primary button. `matches` is
    // tested against the exact target, so a press on a control inside a
    // named wrapper is still that control's press, not a band.
    if (e.button !== 0) return;
    const onGutter = e.target === e.currentTarget
      || (!!gutterSelector && e.target instanceof Element && e.target.matches(gutterSelector));
    if (!onGutter) return;
    const el = containerRef.current;
    if (!el) return;
    const host = el.getBoundingClientRect();
    const sx = el.scrollLeft, sy = el.scrollTop;
    const toContent = (cx: number, cy: number): Point =>
      ({ x: cx - host.left + sx, y: cy - host.top + sy });

    startRef.current = toContent(e.clientX, e.clientY);
    modsRef.current = { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey };
    movedRef.current = false;
    // One measurement pass, in content coords so scrolling mid-drag stays true.
    boxesRef.current = [...el.querySelectorAll<HTMLElement>(itemSelector)]
      .map((node) => {
        const r = node.getBoundingClientRect();
        return {
          path: node.getAttribute(pathAttr) ?? "",
          rect: {
            left: r.left - host.left + sx,
            top: r.top - host.top + sy,
            right: r.right - host.left + sx,
            bottom: r.bottom - host.top + sy,
          },
        };
      })
      .filter((b) => b.path);
    el.setPointerCapture(e.pointerId);
  }, [containerRef, itemSelector, pathAttr, gutterSelector]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const start = startRef.current;
    const el = containerRef.current;
    if (!start || !el) return;
    const host = el.getBoundingClientRect();
    const here: Point = {
      x: e.clientX - host.left + el.scrollLeft,
      y: e.clientY - host.top + el.scrollTop,
    };
    // Below the threshold this is still a click; drawing a band and selecting
    // from it would make an ordinary click clear the selection.
    if (!movedRef.current && !isDrag(start, here)) return;
    movedRef.current = true;
    const rect = marqueeRect(start, here);
    setBand(rect);
    onSelect(pathsInRect(rect, boxesRef.current), modsRef.current);
  }, [containerRef, onSelect]);

  const end = useCallback(() => {
    startRef.current = null;
    boxesRef.current = [];
    setBand(null);
    onEnd?.();
    // Cleared on the NEXT frame, not now: the pointerup that ends a band also
    // fires a click on the gutter, and clearOnBlank has to still see that a
    // drag happened or it wipes the selection the drag just made.
    requestAnimationFrame(() => { movedRef.current = false; });
  }, [onEnd]);

  // A drag interrupted by Escape or a lost pointer must not leave a band
  // painted on the wall forever.
  useEffect(() => {
    if (!band) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") end(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [band, end]);

  return {
    band,
    /** True while a real band is being dragged — callers suppress the gutter
     *  click that would otherwise clear the selection on pointer-up. */
    dragging: () => movedRef.current,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: end,
      onPointerCancel: end,
    },
  };
}

export { marqueeSelection };
