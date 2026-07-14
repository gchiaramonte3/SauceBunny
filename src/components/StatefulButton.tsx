import { useEffect, useRef, type ReactNode } from "react";
import { IconSpinnerArc, IconCircleCheck, IconCircleX } from "./Icons";
import type { StatefulPhase } from "../lib/stateful-phase";

/**
 * Animated stateful action button — the framer-motion "StatefulButton" pattern
 * rebuilt with hand-rolled CSS (no framer-motion, no Tailwind). Three stacked
 * layers (idle label / spinner / result icon) cross-fade + translateY on a
 * `data-phase` attribute; the result check/cross draws itself in via a shared
 * stroke-dashoffset keyframe (see `.cp-sbtn-*` / `.cp-draw` in styles/buttons.css).
 *
 * The PARENT owns `phase` and wires it to real async state — there are NO
 * internal fake timers for the job itself. The one internal timer fires
 * `onResolved` `resolveMs` after entering success/error so the parent can
 * return the button to idle. Under prefers-reduced-motion the CSS swaps
 * instantly (animation suppressed); the timer still runs so `onResolved` fires.
 */
export function StatefulButton({
  phase,
  idleContent,
  loadingLabel = "Working…",
  onClick,
  onResolved,
  disabled,
  title,
  className,
  resolveMs = 1600,
}: {
  phase: StatefulPhase;
  /** Resting content (label, optional icon). */
  idleContent: ReactNode;
  /** Shown next to the spinner while loading. */
  loadingLabel?: string;
  onClick: () => void;
  /** Called `resolveMs` after entering success/error — parent returns to idle. */
  onResolved?: () => void;
  disabled?: boolean;
  title?: string;
  className?: string;
  resolveMs?: number;
}) {
  // Latest-callback ref so the resolve timer keys ONLY on phase/resolveMs —
  // parents pass inline onResolved arrows and re-render often (playhead ticks);
  // depending on that identity would reset the timer forever and never resolve.
  const onResolvedRef = useRef(onResolved);
  onResolvedRef.current = onResolved;
  useEffect(() => {
    if (phase !== "success" && phase !== "error") return;
    const t = setTimeout(() => onResolvedRef.current?.(), resolveMs);
    return () => clearTimeout(t);
  }, [phase, resolveMs]);

  const status =
    phase === "loading" ? "Loading" : phase === "success" ? "Done" : phase === "error" ? "Failed" : "";

  return (
    <button
      type="button"
      className={"cp-sbtn" + (className ? " " + className : "")}
      data-phase={phase}
      onClick={onClick}
      disabled={disabled || phase === "loading"}
      title={title}
      aria-busy={phase === "loading"}
    >
      <span className="cp-sbtn-layer cp-sbtn-idle">{idleContent}</span>
      <span className="cp-sbtn-layer cp-sbtn-loading" aria-hidden>
        <IconSpinnerArc size={14} />
        <span>{loadingLabel}</span>
      </span>
      <span className="cp-sbtn-layer cp-sbtn-result" aria-hidden>
        {phase === "success" && <IconCircleCheck size={16} />}
        {phase === "error" && <IconCircleX size={16} />}
      </span>
      <span className="cp-sbtn-status" aria-live="polite">{status}</span>
    </button>
  );
}
