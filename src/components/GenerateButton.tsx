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

/**
 * One four-point sparkle: a diamond whose sides are pulled inward, which is
 * what separates a sparkle from a star.
 *
 * `k` is how hard the curve is drawn toward the centre. At 0.5 the waist is
 * thin enough to read as a glint at 14px, where a five-point star just fills
 * in and becomes a blob.
 */
function sparkPath(cx: number, cy: number, r: number): string {
  const k = r * 0.5;
  return `M${cx} ${cy - r}`
    + `C${cx} ${cy - k} ${cx + k} ${cy} ${cx + r} ${cy}`
    + `C${cx + k} ${cy} ${cx} ${cy + k} ${cx} ${cy + r}`
    + `C${cx} ${cy + k} ${cx - k} ${cy} ${cx - r} ${cy}`
    + `C${cx - k} ${cy} ${cx} ${cy - k} ${cx} ${cy - r}Z`;
}

/**
 * THREE sparkles, not one. A lone star reads as "favourite" or "rating"; the
 * cluster of one large and two small is the shape that has come to mean
 * generated, and getting that wrong makes the button's most important promise
 * in the wrong language.
 *
 * Sized and placed so they do not merge at 14px: the big one owns the left,
 * the two small ones sit off its upper-right and lower-right diagonals with
 * clear gaps. Drawn as SEPARATE paths so each can twinkle on its own clock —
 * one glyph twinkling as a unit looks like a blinking icon, three on offset
 * timers look like something thinking.
 */
const SPARKS: ReadonlyArray<readonly [number, number, number]> = [
  [9.2, 13.4, 7.4],
  [18.1, 6.6, 4.3],
  [19.4, 16.2, 2.9],
];
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
        {SPARKS.map((s, i) => (
          <path key={i} className="cp-gen-star" d={sparkPath(s[0], s[1], s[2])} />
        ))}
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
