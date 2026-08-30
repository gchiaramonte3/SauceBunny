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
 * survive a relaunch.
 */
export function usePaneWidth({ key, min, max, fallback, side = "left" }: {
  /** localStorage key, `saucebunny.`-namespaced by the caller. */
  key: string;
  min: number;
  max: number;
  fallback: number;
  /** Which edge the handle is on. A pane docked RIGHT grows as the pointer
   *  moves left, so its delta is inverted. */
  side?: "left" | "right";
}) {
  const [width, setWidth] = useState<number>(() => {
    try {
      const raw = Number(localStorage.getItem(key));
      return Number.isFinite(raw) && raw >= min && raw <= max ? raw : fallback;
    } catch { return fallback; }
  });
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    try { localStorage.setItem(key, String(width)); } catch { /* quota */ }
  }, [key, width]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: width };
    setResizing(true);
    // The cursor has to stay a resize cursor over the WHOLE window while the
    // button is down, not just over the 5px handle it started on.
    document.body.classList.add("cp-resizing-ew");
    function onMove(ev: MouseEvent) {
      const st = dragRef.current;
      if (!st) return;
      const delta = (ev.clientX - st.startX) * (side === "right" ? -1 : 1);
      setWidth(Math.max(min, Math.min(max, st.startWidth + delta)));
    }
    function onUp() {
      dragRef.current = null;
      setResizing(false);
      document.body.classList.remove("cp-resizing-ew");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [width, min, max, side]);

  /** Keyboard equivalent: a drag-only resize is unreachable without one. */
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 32 : 8;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const dir = (e.key === "ArrowRight" ? 1 : -1) * (side === "right" ? -1 : 1);
      setWidth((w) => Math.max(min, Math.min(max, w + dir * step)));
    } else if (e.key === "Home") {
      e.preventDefault();
      setWidth(fallback);
    }
  }, [min, max, fallback, side]);

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
    setWidth((w) => {
      const v = typeof next === "function" ? next(w) : next;
      return Math.max(min, Math.min(max, v));
    });
  }, [min, max]);

  return { width, setWidth: setClamped, resizing, onMouseDown, onKeyDown, min, max };
}
