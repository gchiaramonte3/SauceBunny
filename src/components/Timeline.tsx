import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { AppStatus } from "../types";
import { secondsToHms } from "../lib/timecode";

/**
 * Single queued clip's range — rendered as a muted band on the track so
 * the user can see what's already in the export queue at a glance and
 * avoid re-selecting the same section.
 */
export type TimelineRange = {
  id: string;
  inFrames: number;
  outFrames: number;
  /** Optional status — "done" vs "queued" can render slightly differently. */
  status?: "queued" | "running" | "done" | "error";
};

type Props = {
  status: AppStatus;
  durationFrames: number;
  playheadFrames: number;
  /** null = mark not set; selection range only renders when both are set. */
  inFrames: number | null;
  outFrames: number | null;
  fps: number;
  /** Ranges already in the queue (or completed) — drawn under the active selection. */
  queuedRanges?: TimelineRange[];
  onSeek: (f: number) => void;
};

export function Timeline({
  status, durationFrames, playheadFrames, inFrames, outFrames, fps,
  queuedRanges, onSeek,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const dim = status === "empty" || status === "fetching" || status === "error";

  const seekFromX = useCallback((clientX: number) => {
    if (!trackRef.current || dim || durationFrames <= 0) return;
    const r = trackRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    onSeek(Math.floor(ratio * durationFrames));
  }, [dim, durationFrames, onSeek]);

  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (dim) return;
    e.preventDefault();
    setDragging(true);
    seekFromX(e.clientX);
  };

  // Clicking the playhead triangle itself just starts a drag without
  // re-seeking to the cursor (the playhead is already there).
  const onPlayheadDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (dim) return;
    e.preventDefault();
    e.stopPropagation();
    setDragging(true);
  };

  useEffect(() => {
    if (!dragging) return;
    function onMove(e: MouseEvent) { seekFromX(e.clientX); }
    function onUp() { setDragging(false); }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setDragging(false); }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("keydown", onKey);
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("keydown", onKey);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [dragging, seekFromX]);

  const pct = (f: number) => durationFrames > 0 ? (f / durationFrames) * 100 : 0;
  const ticks = Array.from({ length: 11 }, (_, i) => i);

  return (
    <div className="cp-timeline" style={{ opacity: dim ? 0.3 : 1 }}>
      <div className="cp-timeline-ruler">
        {!dim && ticks.map((i) => {
          const left = (i / 10) * 100;
          const frames = Math.floor((i / 10) * durationFrames);
          const major = i % 2 === 0;
          return (
            <Fragment key={i}>
              <div className={"tick " + (major ? "major" : "minor")} style={{ left: `${left}%` }} />
              {major && (
                <div className="tick-label" style={{ left: `${left}%` }}>
                  {secondsToHms(frames / Math.max(1, Math.round(fps)))}
                </div>
              )}
            </Fragment>
          );
        })}
      </div>
      <div
        className={"cp-track" + (dragging ? " dragging" : "")}
        ref={trackRef}
        onMouseDown={onMouseDown}
      >
        <div className="cp-track-fill" />
        {!dim && (
          <>
            {/* Queued ranges — drawn first (lowest z) so the active orange
                selection paints over them when they overlap. Each band is
                muted-gray so the user can see "I already queued that bit"
                without it competing with the live selection. */}
            {queuedRanges?.map((r) => {
              if (r.outFrames <= r.inFrames) return null;
              const left  = pct(r.inFrames);
              const width = Math.max(0, pct(r.outFrames - r.inFrames));
              return (
                <div
                  key={r.id}
                  className={"cp-track-queued " + (r.status ?? "queued")}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={r.status === "done" ? "Already exported" : "Already in queue"}
                />
              );
            })}
            {/* Full range when both marks are set — the orange fill IS the
                visual, no decorative handles needed. */}
            {inFrames != null && outFrames != null && outFrames > inFrames && (
              <div
                className="cp-track-selection"
                style={{
                  left: `${pct(inFrames)}%`,
                  width: `${Math.max(0, pct(outFrames - inFrames))}%`,
                }}
              />
            )}
            {/* Solo mark when only one of the two is set yet. */}
            {inFrames != null && outFrames == null && (
              <div className="cp-track-mark in"  style={{ left: `${pct(inFrames)}%` }}  title="Mark in" />
            )}
            {outFrames != null && inFrames == null && (
              <div className="cp-track-mark out" style={{ left: `${pct(outFrames)}%` }} title="Mark out" />
            )}
            <div
              className="cp-playhead"
              style={{ left: `${pct(playheadFrames)}%` }}
              onMouseDown={onPlayheadDown}
              title="Drag to scrub"
            />
          </>
        )}
      </div>
    </div>
  );
}
