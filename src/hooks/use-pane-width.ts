import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A side pane the user can drag wider or narrower, remembered per pane.
 *
 * Extracted from the Library tree, which had the only one. The transcripts
 * picker had no width control at all - its width came from the grid, so a
 * long project name simply truncated and there was nothing to do about it.
 * Two panes that resize should not resize differently, and the difference
 * is easy to introduce by hand: the clamp, the persisted key, the body
 * cursor class while dragging, and whether the delta is inverted for a pane
 * docked on the right rather than the left.
 *
 * The width persists because it is a workspace decision, not a scroll
 * position - a wider picker is a choice about how you read, and it should
 * survive a relaunch. Only a size the user chose is stored: until then the
 * key stays empty, so a default worked out from the window is worked out
 * again on the next launch rather than frozen at the first one.
 *
 * "Width" by history: a pane docked at the bottom (String Outs' timeline) is
 * sized by its height through the same code, so the clamp, the keys and the
 * cursor cannot drift apart between the two directions either.
 */
export function usePaneWidth({ key, min, max, fallback, side = "left", measure }: {
  /** localStorage key, `saucebunny.`-namespaced by the caller. */
  key: string;
  min: number;
  max: number;
  fallback: number;
  /** Which edge the handle is on. A pane docked RIGHT grows as the pointer
   *  moves left, so its delta is inverted. One docked at the BOTTOM has its
   *  handle on its top edge: it is sized by height and grows as the pointer
   *  moves up. */
  side?: "left" | "right" | "bottom";
  /** The pane's size as drawn, for a pane CSS can hold below the stored size
   *  (a percentage cap, or room left for a neighbour): a drag or a nudge then
   *  starts from what is on screen, not from a number nobody can see. */
  measure?: () => number | null | undefined;
}) {
  const stored = () => {
    try {
      const raw = localStorage.getItem(key), value = raw === null ? NaN : Number(raw);
      return Number.isFinite(value) && value >= min && value <= max ? value : null;
    } catch { return null; }
  };
  const [width, setWidth] = useState<number>(() => stored() ?? fallback);
  /** The size is the user's, so it is stored. Home and reset() hand it back. */
  const [chosen, setChosen] = useState(() => stored() !== null);
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const vertical = side === "bottom", sign = side === "left" ? 1 : -1;

  useEffect(() => {
    try {
      if (chosen) localStorage.setItem(key, String(width));
      else localStorage.removeItem(key);
    } catch { /* quota */ }
  }, [key, width, chosen]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const at = (point: { clientX: number; clientY: number }) => (vertical ? point.clientY : point.clientX);
    dragRef.current = { startX: at(e), startWidth: measure?.() ?? width };
    setResizing(true);
    // The cursor has to stay a resize cursor over the WHOLE window while the
    // button is down, not just over the 5px handle it started on.
    const cursor = vertical ? "cp-resizing-ns" : "cp-resizing-ew";
    document.body.classList.add(cursor);
    function onMove(ev: MouseEvent) {
      const st = dragRef.current;
      if (!st) return;
      setChosen(true);
      setWidth(Math.max(min, Math.min(max, st.startWidth + (at(ev) - st.startX) * sign)));
    }
    function onUp() {
      dragRef.current = null;
      setResizing(false);
      document.body.classList.remove(cursor);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [width, min, max, vertical, sign, measure]);

  /** Keyboard equivalent: a drag-only resize is unreachable without one.
   *  The arrows follow the handle: Up and Down for one that moves vertically. */
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 32 : 8;
    const forward = vertical ? "ArrowDown" : "ArrowRight", back = vertical ? "ArrowUp" : "ArrowLeft";
    if (e.key === forward || e.key === back) {
      e.preventDefault();
      const dir = (e.key === forward ? 1 : -1) * sign, from = measure?.();
      setChosen(true);
      setWidth((w) => Math.max(min, Math.min(max, (from ?? w) + dir * step)));
    } else if (e.key === "Home") {
      e.preventDefault();
      setChosen(false);
      setWidth(fallback);
    }
  }, [min, max, fallback, vertical, sign, measure]);

  /** Back to the default, which is stored as nothing (the double-click). */
  const reset = useCallback(() => { setChosen(false); setWidth(fallback); }, [fallback]);

  /**
   * Set the width programmatically, CLAMPED like every other path.
   *
   * For the callers that resize for a reason other than a drag - a
   * double-click reset, or widening to fit a toolbar that would otherwise
   * wrap. Exposing the raw setter instead would let those bypass the bounds
   * this hook exists to hold, which is how one pane comes to have two
   * different minimum widths.
   */
  const setClamped = useCallback((next: number | ((w: number) => number)) => {
    setChosen(true);
    setWidth((w) => {
      const v = typeof next === "function" ? next(w) : next;
      return Math.max(min, Math.min(max, v));
    });
  }, [min, max]);

  return { width, setWidth: setClamped, reset, chosen, resizing, onMouseDown, onKeyDown, min, max };
}
