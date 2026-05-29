import { useEffect, useRef, useState } from "react";
import { IconCheck, IconAlert, IconInfo } from "./Icons";

export type ToastKind = "success" | "error" | "info";

type Props = {
  kind: ToastKind;
  title: string;
  body?: string;
  /** Auto-dismiss after this many ms. 0 = never. Default depends on `kind`. */
  timeout?: number;
  onDismiss: () => void;
};

/**
 * Per-kind default visibility. Success messages can flash quickly because
 * the user already knows the outcome; info and error messages often carry
 * actionable detail (file paths, hints) and need long enough to read.
 * Hover pauses the countdown so users can re-read or copy the body.
 */
const DEFAULT_TIMEOUT: Record<ToastKind, number> = {
  success: 3500,
  info: 8000,
  error: 10000,
};

export function CanvasToast({ kind, title, body, timeout, onDismiss }: Props) {
  const ttl = timeout ?? DEFAULT_TIMEOUT[kind];
  const [paused, setPaused] = useState(false);
  // Remaining-time accounting so hover-to-pause genuinely *pauses* instead
  // of restarting the timer from the full duration when the user mouses out.
  const remainingRef = useRef(ttl);
  const startedRef = useRef<number>(Date.now());
  const timerRef = useRef<number | null>(null);

  // Stash onDismiss in a ref so the timer-driving effect can read it
  // without listing it in deps. Without this, the parent passing an
  // inline `() => setToast(null)` (App.tsx does exactly this) would
  // re-create the closure on every render, re-trigger the effect, and
  // reset the timer to `remainingRef.current` — toast would never expire
  // if the parent re-renders steadily.
  const onDismissRef = useRef(onDismiss);
  useEffect(() => { onDismissRef.current = onDismiss; }, [onDismiss]);

  useEffect(() => {
    if (ttl <= 0) return;
    const clearActive = () => {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    if (paused) {
      // Capture how much time we've already burned through before pausing.
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedRef.current));
      clearActive();
    } else {
      startedRef.current = Date.now();
      timerRef.current = window.setTimeout(() => onDismissRef.current(), remainingRef.current);
    }
    return clearActive;
    // Intentionally NOT depending on onDismiss — see ref pattern above.
  }, [paused, ttl]);

  const Icon = kind === "error" ? IconAlert : kind === "info" ? IconInfo : IconCheck;

  return (
    <div
      className={"cp-canvas-toast " + kind}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      role="status"
    >
      <div className="icon"><Icon size={16} /></div>
      <div className="text">
        <div className="title">{title}</div>
        {body && <div className="body">{body}</div>}
      </div>
      {/* Explicit dismiss — was previously the whole toast acting as a
          dismiss button, which made it impossible to keep open to read. */}
      <button
        className="cp-canvas-toast-close"
        onClick={onDismiss}
        title="Dismiss"
        aria-label="Dismiss notification"
      >
        ×
      </button>
    </div>
  );
}
