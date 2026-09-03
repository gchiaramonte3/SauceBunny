import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A tooltip that appears ABOVE the control.
 *
 * The app uses the native `title` attribute nearly everywhere, and that is
 * usually the right call: free, accessible, and consistent with the OS. But
 * the OS decides where it goes, and it goes BELOW the pointer - which on the
 * comment composer's icon row means the tooltip lands on top of the next row
 * of controls, and the pointer covers the very button being described.
 * `title` cannot be repositioned by CSS or JS; the only way up is to draw it.
 *
 * So this is deliberately NOT an app-wide replacement. It is for rows where
 * the tooltip must clear the pointer.
 *
 * ACCESSIBILITY: this draws a visual affordance only, and is aria-hidden. The
 * control keeps its own `aria-label`, which is what a screen reader and macOS
 * Voice Control use. Announcing both would say the same words twice, and
 * `title` is what control-naming-contract pairs against - so a wrapped button
 * carries `aria-label` and no `title`, and the label passed here is the same
 * string, for the same reason that contract exists.
 */

/** Gap between the control's top edge and the bubble. */
const OFFSET = 8;
/** Keep the bubble this far from the window edge when a control is near one. */
const MARGIN = 6;

export function Tooltip({ label, children }: {
  /** The words shown. Pass the control's own aria-label so the two agree. */
  label: string;
  children: React.ReactNode;
}) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);

  const place = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Centre on the control, sit above it. Measured after paint below, so the
    // first frame can be off; it is invisible until then.
    setAt({ x: r.left + r.width / 2, y: r.top - OFFSET });
  }, []);

  // Clamp horizontally once the bubble has a width. Without this a control at
  // the right edge of the panel pushes the bubble off-screen, which is where
  // the composer's last tool actually sits.
  useEffect(() => {
    if (!at) return;
    const tip = tipRef.current;
    if (!tip) return;
    const w = tip.offsetWidth;
    const half = w / 2;
    const min = MARGIN + half;
    const max = window.innerWidth - MARGIN - half;
    const clamped = Math.min(Math.max(at.x, min), max);
    if (Math.abs(clamped - at.x) > 0.5) setAt({ x: clamped, y: at.y });
  }, [at]);

  const hide = useCallback(() => setAt(null), []);

  // A scroll or a resize moves the control out from under the bubble.
  useEffect(() => {
    if (!at) return;
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [at, hide]);

  return (
    <span
      ref={wrapRef}
      className="cp-tip-wrap"
      onPointerEnter={place}
      onPointerLeave={hide}
      // Keyboard users get it too: focus shows, blur hides, Escape dismisses
      // without moving focus off the control.
      onFocus={place}
      onBlur={hide}
      onKeyDown={(e) => { if (e.key === "Escape" && at) hide(); }}
    >
      {children}
      {at && (
        <span
          ref={tipRef}
          className="cp-tip"
          aria-hidden
          style={{ left: at.x, top: at.y }}
        >
          {label}
        </span>
      )}
    </span>
  );
}
