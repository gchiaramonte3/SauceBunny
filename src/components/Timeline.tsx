import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { AppStatus } from "../types";
import { secondsToHms } from "../lib/timecode";
import { filmstripCount, filmstripTimestamps } from "../lib/filmstrip";
import { extractFilmstrip } from "../lib/mediabunny-helpers";

/** Scrub-track height (px) when a filmstrip is shown — matches
 *  `.cp-track.has-filmstrip` in transport.css; also sizes the decoded thumbs. */
const FILMSTRIP_H = 44;

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
  /** Review comment markers (seconds) — Frame.io-style dots on the track,
   *  tinted to the reviewer's colour, expanding to their initials on hover.
   *  When `timeEnd` is set the marker also draws a reviewer-tinted RANGE bar in
   *  the comment lane — deliberately unlike the orange clip in/out selection. */
  commentMarkers?: { id: string; time: number; timeEnd?: number | null; resolved: boolean; color: string; initials: string }[];
  /** Live preview of the range being set in the review composer — a dashed,
   *  pulsing reviewer-tinted bracket so it reads as "setting a comment range",
   *  distinct from both the orange clip marks and the saved comment ranges.
   *  `live` = an end still follows the playhead; false = both marks locked
   *  (renders solid with a one-shot flash). */
  reviewRangeDraft?: { start: number; end: number; color: string; live: boolean } | null;
  /** Local file path to build the thumbnail filmstrip from (mediabunny-decoded).
   *  null for web/streaming sources or when there's no decodable local file. */
  filmstripPath?: string | null;
  /** Speaker lanes from the diarized transcript — a thin strip of tinted
   *  bands along the bottom of the track showing who talks when. */
  speakerLanes?: { startMs: number; endMs: number; color: string; speaker: string | null }[];
  onSeek: (f: number) => void;
};

export function Timeline({
  status, durationFrames, playheadFrames, inFrames, outFrames, fps,
  queuedRanges, commentMarkers, reviewRangeDraft, filmstripPath, speakerLanes, onSeek,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [trackW, setTrackW] = useState(0);
  const [filmstrip, setFilmstrip] = useState<(string | null)[]>([]);
  const filmCacheRef = useRef<Map<string, (string | null)[]>>(new Map());
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
    // rAF-coalesce drag seeks: at most ONE seek per display frame. Raw
    // mousemove can fire far faster than a decode completes, and the player's
    // latest-wins guard then drops every in-flight frame — which is why
    // fast-decoding all-intra sources (ProRes) looked like they skipped frames
    // while scrubbing. One seek per vsync gives each decode a frame's worth of
    // time to land, so the scrub shows every frame the display can show.
    let rafId = 0;
    let pendingX: number | null = null;
    function onMove(e: MouseEvent) {
      pendingX = e.clientX;
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        if (pendingX != null) seekFromX(pendingX);
      });
    }
    function onUp(e: MouseEvent) {
      // Land exactly where the pointer was released, then stop.
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      seekFromX(e.clientX);
      setDragging(false);
    }
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
      if (rafId) cancelAnimationFrame(rafId);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [dragging, seekFromX]);

  // Measure the track width so the filmstrip picks a sensible thumbnail count.
  // Bucketed to 24px so a stray 1px resize doesn't re-decode the whole strip.
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setTrackW((prev) => (Math.abs(prev - w) >= 24 ? Math.round(w) : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Build the thumbnail filmstrip from the local file (mediabunny, one pass).
  // Depends on source/duration/width — NOT the playhead — so scrubbing never
  // re-decodes. Cached per source+count; aborted on source/size change.
  useEffect(() => {
    const path = filmstripPath ?? null;
    const durSec = fps > 0 ? durationFrames / fps : 0;
    const count = filmstripCount(trackW);
    if (dim || !path || durSec <= 0 || count <= 0) { setFilmstrip([]); return; }

    const key = `${path}|${count}`;
    const cached = filmCacheRef.current.get(key);
    if (cached) { setFilmstrip(cached); return; }

    const ctrl = new AbortController();
    let alive = true;
    void (async () => {
      const ts = filmstripTimestamps(durSec, count);
      const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      const strip = await extractFilmstrip(path, ts, {
        height: Math.round(FILMSTRIP_H * dpr),
        signal: ctrl.signal,
      });
      if (!alive || ctrl.signal.aborted) return;
      if (strip.length > 0) filmCacheRef.current.set(key, strip);
      setFilmstrip(strip);
    })();
    return () => { alive = false; ctrl.abort(); };
  }, [filmstripPath, durationFrames, fps, trackW, dim]);

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
        className={"cp-track" + (dragging ? " dragging" : "") + (filmstrip.length > 0 ? " has-filmstrip" : "")}
        ref={trackRef}
        onMouseDown={onMouseDown}
      >
        {/* Thumbnail filmstrip — lowest layer; the fill above becomes a scrim so
            the playhead + marks stay legible over the frames. */}
        {filmstrip.length > 0 && (
          <div className="cp-filmstrip" aria-hidden>
            {filmstrip.map((u, i) => (
              <div className="cp-filmstrip-cell" key={i}>
                {u && <img src={u} alt="" draggable={false} />}
              </div>
            ))}
          </div>
        )}
        {/* Speaker lanes — who talks when, as tinted bands hugging the bottom
            edge. Pointer-events off in CSS so clicks still seek the track. */}
        {speakerLanes && speakerLanes.length > 0 && !dim && (
          <div className="cp-track-lanes" aria-hidden>
            {speakerLanes.map((lane, i) => {
              const r = Math.max(1, Math.round(fps));
              const left = pct((lane.startMs / 1000) * r);
              const width = Math.max(0, pct(((lane.endMs - lane.startMs) / 1000) * r));
              return (
                <div
                  key={i}
                  style={{ left: `${left}%`, width: `${width}%`, background: lane.color }}
                  title={lane.speaker ?? "Unknown"}
                />
              );
            })}
          </div>
        )}
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
            {/* Review comment RANGES — a thin reviewer-tinted bar with bracket
                caps in the comment lane. Deliberately unlike the orange clip
                selection: it sits low on the track and carries the note's
                colour. Drawn before the dots so the anchor dot reads on top. */}
            {commentMarkers?.map((m) => {
              const r = Math.max(1, Math.round(fps));
              if (m.timeEnd == null || m.timeEnd <= m.time) return null;
              return (
                <div
                  key={"rng-" + m.id}
                  className={"cp-track-comment-range" + (m.resolved ? " resolved" : "")}
                  style={{ left: `${pct(m.time * r)}%`, width: `${Math.max(0.4, pct((m.timeEnd - m.time) * r))}%`, ["--marker-color" as string]: m.color }}
                  title="Review range — click to jump to its start"
                  onMouseDown={(e) => { e.stopPropagation(); onSeek(Math.floor(m.time * r)); }}
                />
              );
            })}
            {/* Live preview of the range being set in the composer — dashed +
                pulsing so it reads as "setting", not a saved range. */}
            {reviewRangeDraft && (() => {
              const r = Math.max(1, Math.round(fps));
              const a = Math.min(reviewRangeDraft.start, reviewRangeDraft.end) * r;
              const b = Math.max(reviewRangeDraft.start, reviewRangeDraft.end) * r;
              return (
                <div
                  className={"cp-track-range-draft" + (reviewRangeDraft.live ? "" : " locked")}
                  style={{ left: `${pct(a)}%`, width: `${Math.max(0.4, pct(b - a))}%`, ["--marker-color" as string]: reviewRangeDraft.color }}
                  title="New comment range"
                />
              );
            })()}
            {/* Review comment markers — click a dot to jump to that note. */}
            {commentMarkers?.map((m) => {
              const r = Math.max(1, Math.round(fps));
              return (
                <div
                  key={m.id}
                  className={"cp-track-comment" + (m.resolved ? " resolved" : "")}
                  style={{ left: `${pct(m.time * r)}%`, ["--marker-color" as string]: m.color }}
                  title="Review comment — click to jump"
                  onMouseDown={(e) => { e.stopPropagation(); onSeek(Math.floor(m.time * r)); }}
                >
                  <span className="cp-track-comment-ini">{m.initials}</span>
                </div>
              );
            })}
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
