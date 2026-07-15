import { useEffect, useRef, useState } from "react";
import { useModalFocus } from "../hooks/use-modal-focus";
import { canMediabunnyDecode, probeVideoDuration } from "../lib/mediabunny-helpers";
import { ThumbnailPickerSlider } from "./ThumbnailPickerSlider";
import { ThumbnailPresets } from "./ThumbnailPresets";

/**
 * "Choose thumbnail…" picker — a modal over one local video. Two modes,
 * decided on mount by whether mediabunny can decode the file:
 *
 *  - decodable → a scrub slider with a latest-wins live preview
 *    (ThumbnailPickerSlider). "Use this frame" persists the scrubbed time.
 *  - NOT decodable → three ffmpeg-rendered preset frames (ThumbnailPresets).
 *
 * "Reset to auto" reverts to the representative auto-poster. Escape and a
 * backdrop click close without changes; focus is trapped + restored by
 * useModalFocus, exactly like the app's other dialogs.
 */

type Props = {
  path: string;
  /** Whether this path already has a user-chosen thumbnail (shows "Reset to auto"). */
  hasChosen: boolean;
  onPick: (seconds: number) => void;
  onResetAuto: () => void;
  onClose: () => void;
};

type Mode =
  | { kind: "loading" }
  | { kind: "scrub"; dur: number }
  | { kind: "preset"; offsets: number[]; dur: number | null; approx: boolean }
  | { kind: "error" };

/** Preset fractions of a file's duration (spec: 10% / 33% / 66%). */
const PRESET_FRACTIONS = [0.1, 0.33, 0.66];
/** Duration-less fallback offsets, in seconds (spec: 2s / 10s / 30s). */
const PRESET_FIXED = [2, 10, 30];

export function ThumbnailPicker({ path, hasChosen, onPick, onResetAuto, onClose }: Props) {
  const [mode, setMode] = useState<Mode>({ kind: "loading" });
  const [t, setT] = useState(0);
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

  // Decide the mode once: mediabunny-decodable + measurable duration → the live
  // scrubber; not decodable → ffmpeg-rendered presets (fractions of duration, or
  // fixed offsets when the duration is unknown too).
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [decodable, dur] = await Promise.all([
        canMediabunnyDecode(path),
        probeVideoDuration(path),
      ]);
      if (!alive) return;
      const hasDur = typeof dur === "number" && dur > 0;
      if (decodable && hasDur) {
        setMode({ kind: "scrub", dur });
        setT(Math.min(5, dur * 0.1));
      } else if (decodable) {
        setMode({ kind: "error" }); // decodable but unbounded — can't seat a slider
      } else {
        const offsets = hasDur ? PRESET_FRACTIONS.map((f) => f * dur) : [...PRESET_FIXED];
        setMode({ kind: "preset", offsets, dur: hasDur ? dur : null, approx: !hasDur });
      }
    })();
    return () => { alive = false; };
  }, [path]);

  return (
    <div className="cp-lib-thumb-scrim" onClick={onClose}>
      <div
        className="cp-lib-thumb"
        role="dialog"
        aria-modal="true"
        aria-label="Choose thumbnail"
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cp-lib-thumb-head">
          <h2>Choose thumbnail</h2>
          <button type="button" className="cp-lib-thumb-close" onClick={onClose} title="Close (Esc)" aria-label="Close">
            ✕
          </button>
        </div>

        {mode.kind === "error" ? (
          <p className="cp-lib-thumb-note">Couldn’t read this video.</p>
        ) : mode.kind === "loading" ? (
          <p className="cp-lib-thumb-note">Loading…</p>
        ) : mode.kind === "scrub" ? (
          <>
            <ThumbnailPickerSlider path={path} dur={mode.dur} value={t} onChange={setT} />
            <div className="cp-lib-thumb-actions">
              <button type="button" className="btn btn-primary" onClick={() => onPick(t)}>Use this frame</button>
              {hasChosen && <button type="button" className="btn" onClick={onResetAuto}>Reset to auto</button>}
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
            </div>
          </>
        ) : (
          <ThumbnailPresets
            path={path}
            offsets={mode.offsets}
            dur={mode.dur}
            approx={mode.approx}
            hasChosen={hasChosen}
            onPick={onPick}
            onResetAuto={onResetAuto}
            onClose={onClose}
          />
        )}
      </div>
    </div>
  );
}
