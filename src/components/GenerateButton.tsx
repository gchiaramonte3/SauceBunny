import { useEffect, useRef } from "react";
import { IconCircleCheck, IconCircleX } from "./Icons";

/**
 * Premium CTA for transcription — a beveled, glowing button whose idle label
 * shimmers letter-by-letter and whose sparkle flickers; on `loading` it crossfades
 * to the loading label with a green progress underfill and a faster sparkle.
 *
 * Ported from a styled-components concept to the project's hand-rolled CSS:
 * `cp-gen-*` classes in styles/buttons.css, tokens + Nunito Sans + the green
 * accent, and driven by a real `loading` prop instead of `:focus`. Motion is
 * suppressed under prefers-reduced-motion (handled in CSS).
 *
 * When a run settles, the parent passes `resolution` ("success" | "error"):
 * the sparkle + label crossfade to a drawn check/cross (the SAME icons and
 * `.cp-draw` keyframe as StatefulButton), then `onResolved` fires `resolveMs`
 * later so the parent can clear it back to idle.
 */
export function GenerateButton({
  idleLabel,
  loadingLabel = "Generating…",
  loading,
  progress = null,
  resolution = null,
  onResolved,
  resolveMs = 1600,
  onClick,
  disabled,
  title,
  className,
}: {
  /** Resting label (animates letter-by-letter). */
  idleLabel: string;
  /** Shown while `loading` (crossfades in). */
  loadingLabel?: string;
  loading: boolean;
  /** 0..100 — drives the green underfill while loading. */
  progress?: number | null;
  /** Transient run outcome — flashes a drawn check/cross, then reverts. */
  resolution?: "success" | "error" | null;
  /** Fires `resolveMs` after a resolution appears so the parent clears it. */
  onResolved?: () => void;
  resolveMs?: number;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  // Loading wins over a lingering resolution; then the flash; else resting.
  const phase = loading ? "loading" : resolution ? resolution : "idle";
  // Latest-callback ref — key the timer on resolution/loading only, so the
  // parent's inline onResolved arrow + frequent re-renders can't reset it.
  const onResolvedRef = useRef(onResolved);
  onResolvedRef.current = onResolved;
  useEffect(() => {
    if (!resolution || loading) return;
    const t = setTimeout(() => onResolvedRef.current?.(), resolveMs);
    return () => clearTimeout(t);
  }, [resolution, loading, resolveMs]);

  return (
    <button
      type="button"
      className={"cp-gen-btn" + (loading ? " loading" : "") + (className ? " " + className : "")}
      data-phase={phase}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-busy={loading}
    >
      {loading && progress != null && (
        <span className="cp-gen-fill" style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} aria-hidden />
      )}
      <svg className="cp-gen-svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" />
      </svg>
      <span className="cp-gen-txt">
        <span className="cp-gen-idle" aria-hidden={loading}>
          {Array.from(idleLabel).map((ch, i) => (
            <span key={i} className="cp-gen-letter" style={{ animationDelay: `${(i * 0.05).toFixed(2)}s` }}>
              {ch === " " ? " " : ch}
            </span>
          ))}
        </span>
        <span className="cp-gen-load" aria-hidden={!loading}>{loadingLabel}</span>
      </span>
      {/* Resolution flash — overlays the sparkle + text on success/error. */}
      <span className="cp-gen-result" aria-hidden>
        {resolution === "success" && <IconCircleCheck size={15} />}
        {resolution === "error" && <IconCircleX size={15} />}
        <span className="cp-gen-reslabel">{resolution === "error" ? "Failed" : "Done"}</span>
      </span>
      <span className="cp-sbtn-status" aria-live="polite">
        {resolution === "success" ? "Done" : resolution === "error" ? "Failed" : ""}
      </span>
    </button>
  );
}
