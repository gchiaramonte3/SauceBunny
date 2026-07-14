import { useEffect, useRef, useState } from "react";
import { useModalFocus } from "../hooks/use-modal-focus";
import { extractFrameAsBlob, probeVideoDuration } from "../lib/mediabunny-helpers";

/**
 * "Set thumbnail…" picker — a modal over a single local video. Scrub the range
 * slider; a debounced live preview decodes that exact frame (mediabunny, no
 * subprocess). "Use this frame" persists the chosen timestamp; "Reset to auto"
 * drops back to the representative auto-poster. Preview object URLs are revoked
 * on replace and on unmount so a long scrub never leaks decoded JPEGs.
 */

type Props = {
  path: string;
  /** Whether this path already has a user-chosen poster (shows "Reset to auto"). */
  hasChosen: boolean;
  onPick: (seconds: number) => void;
  onResetAuto: () => void;
  onClose: () => void;
};

type Probe =
  | { kind: "loading" }
  | { kind: "ready"; dur: number }
  | { kind: "error" };

/** seconds → m:ss (or h:mm:ss past an hour). */
function formatClock(s: number): string {
  const total = Math.max(0, Math.floor(s));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

export function PosterPicker({ path, hasChosen, onPick, onResetAuto, onClose }: Props) {
  const [probe, setProbe] = useState<Probe>({ kind: "loading" });
  const [t, setT] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const previewRef = useRef<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Trap Tab + restore focus (mounted = open). Esc closes below.
  useModalFocus(true, dialogRef);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Probe duration once; seed the slider at the representative default frame.
  useEffect(() => {
    let alive = true;
    probeVideoDuration(path).then((d) => {
      if (!alive) return;
      if (d && d > 0) {
        setProbe({ kind: "ready", dur: d });
        setT(Math.min(5, d * 0.1));
      } else {
        setProbe({ kind: "error" });
      }
    });
    return () => { alive = false; };
  }, [path]);

  // Debounced live preview of the frame at `t`.
  useEffect(() => {
    if (probe.kind !== "ready") return;
    let cancelled = false;
    const id = window.setTimeout(async () => {
      const blob = await extractFrameAsBlob(path, t, { maxWidth: 640 });
      if (cancelled || !blob) return;
      const objUrl = URL.createObjectURL(blob);
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      previewRef.current = objUrl;
      setPreview(objUrl);
    }, 120);
    return () => { cancelled = true; window.clearTimeout(id); };
  }, [t, probe.kind, path]);

  // Release the last preview URL on unmount.
  useEffect(() => () => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
  }, []);

  const step = probe.kind === "ready" ? Math.max(0.05, probe.dur / 1000) : 0.1;

  return (
    <div className="cp-poster-picker-scrim" onClick={onClose}>
      <div
        className="cp-poster-picker"
        role="dialog"
        aria-modal="true"
        aria-label="Set thumbnail"
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cp-poster-picker-head">
          <h2>Set thumbnail</h2>
          <button
            type="button"
            className="cp-poster-picker-close"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {probe.kind === "error" ? (
          <p className="cp-poster-picker-note">Couldn't read this video's duration.</p>
        ) : probe.kind === "loading" ? (
          <p className="cp-poster-picker-note">Loading…</p>
        ) : (
          <>
            <div className="cp-poster-picker-preview">
              {preview ? (
                <img src={preview} alt="" draggable={false} />
              ) : (
                <span className="cp-poster-picker-ph">Generating…</span>
              )}
            </div>
            <div className="cp-poster-picker-slider">
              <input
                type="range"
                min={0}
                max={probe.dur}
                step={step}
                value={t}
                autoFocus
                aria-label="Poster time"
                onChange={(e) => setT(Number(e.target.value))}
              />
              <span className="cp-poster-picker-time">{formatClock(t)}</span>
            </div>
            <div className="cp-poster-picker-actions">
              <button type="button" className="btn btn-primary" onClick={() => onPick(t)}>
                Use this frame
              </button>
              {hasChosen && (
                <button type="button" className="btn" onClick={onResetAuto}>
                  Reset to auto
                </button>
              )}
              <button type="button" className="btn" onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
