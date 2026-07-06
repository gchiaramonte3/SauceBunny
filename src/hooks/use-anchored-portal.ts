import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * Viewport coordinates for a `position: fixed` popover anchored to a trigger
 * element — the portal-out-of-the-stacking-context pattern shared by
 * NotificationBell, RecentSources, CoReviewPopover, and EmojiPicker.
 *
 * Measures the anchor when the popover opens and re-measures on window
 * resize, so the popover tracks its trigger through sidebar collapses and
 * drag-resizes. Resize bursts are coalesced to one measurement per frame
 * (CoReviewPopover's variant, now everyone's — a drag-resize fires dozens of
 * events per second and every setState re-renders the portal).
 *
 * `place` maps the anchor's DOMRect to whatever fixed-position CSS the caller
 * styles with (`top`/`right`, `left`/`bottom`, …) and may read
 * window.innerWidth/Height for viewport clamping. Returns null until the
 * first measurement — gate rendering on it (`open && pos && …`). The last
 * position is kept after close; reopening re-measures before paint.
 */
export function useAnchoredPortal<T>(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  place: (anchor: DOMRect) => T,
): T | null {
  const [pos, setPos] = useState<T | null>(null);
  // Callers pass inline closures — mirror in a ref so the effect binds once
  // per open instead of on every render.
  const placeRef = useRef(place);
  placeRef.current = place;

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    const el = anchorRef.current;
    const compute = () => setPos(placeRef.current(el.getBoundingClientRect()));
    compute();
    let raf = 0;
    const onResize = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; compute(); });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [open, anchorRef]);

  return pos;
}

/** The toolbar popovers' shared placement: hang below the trigger with the
 *  right edges aligned, so the popover grows leftward. CSS positions via
 *  `top` + `right` (distance from the right viewport edge). */
export function placeBelowAlignRight(anchor: DOMRect): { top: number; right: number } {
  return { top: anchor.bottom + 8, right: window.innerWidth - anchor.right };
}
