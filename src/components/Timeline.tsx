import { Fragment, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AppStatus, ReviewRangeDraft } from "../types";
import { secondsToHms } from "../lib/timecode";
import { filmstripCount, filmstripTimestamps } from "../lib/filmstrip";
import { extractFilmstrip } from "../lib/mediabunny-helpers";
import { extractWaveformPeaks, lruSet, type WaveformPeaks } from "../lib/waveform";
import { TimelineWaveform } from "./TimelineWaveform";
import { usePlayheadFrames, setScrubbing } from "../lib/playhead-store";
import { getGhosts, subscribeGhosts } from "../lib/ghost-store";
import { loadReviewer, reviewerColorFor } from "../lib/review";
import { isRealSpan } from "../lib/review-range";

/** Scrub-track height (px) when a filmstrip is shown — matches
 *  `.cp-track.has-filmstrip` in transport.css; also sizes the decoded thumbs. */
const FILMSTRIP_H = 44;

/** Max cached filmstrips (source+count keys). Strips are the heavy cache —
 *  up to 24 JPEG data URLs at 2× DPR each — so the cap stays small; reads
 *  refresh recency, so the displayed source is never the one evicted. Sized so
 *  one source's open AND closed drawer widths both survive a toggle: at 4 the
 *  LRU thrashed and re-decoded the strip on every open/close. */
const FILMSTRIP_CACHE_MAX = 8;

/**
 * Single queued clip's range — rendered as a muted band on the track so
 * the user can see what's already in the export queue at a glance and
 * avoid re-selecting the same section.
 */
export type TimelineRange = {
  id: string;
  inFrames: number;
  outFrames: number;
  /** Status drives the range's color system (8a): gold queued/running,
   *  green done, red failed. */
  status?: "queued" | "running" | "done" | "error";
  /** Clip name for the hover tooltip. */
  label?: string;
};

/** The scrub cursor — the one element on the track that moves at up to 60Hz,
 *  so it alone subscribes to the playhead store. The rest of the timeline
 *  (ruler, filmstrip, marks, lanes) renders only when its own props change. */
/**
 * The playhead, and the timeline's keyboard interface.
 *
 * The slider role lives HERE rather than on the track for two reasons. First
 * it is semantically the thumb, which is what a slider role describes.
 * Second, and load-bearing: `aria-valuenow` has to carry the live playhead,
 * and this component is the only part of the timeline that subscribes to it.
 * Putting the role on the track would drag the whole timeline into a 60Hz
 * re-render and undo the deliberate isolation that keeps scrubbing smooth.
 *
 * Keyboard map follows NLE convention rather than the browser default so it
 * matches what the rest of the app does: arrows step ONE FRAME (the unit this
 * app is precise in), Shift steps a second, Page steps ten, Home/End jump to
 * the ends.
 */
/** The scrub cursor. Rendered only when the track is live — the parent's
 *  `{!dim && …}` guard is the disabled state, so there is no disabled variant
 *  here. It used to take a `disabled` prop that gated the keymap and dropped
 *  the control out of the tab order, and none of it could ever run. */
function PlayheadCursor({ durationFrames, fps, onMouseDown, onSeek }: {
  durationFrames: number;
  fps: number;
  onMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void;
  onSeek: (frames: number) => void;
}) {
  const frames = usePlayheadFrames();
  const left = durationFrames > 0 ? (frames / durationFrames) * 100 : 0;
  const rate = Math.max(1, Math.round(fps));

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (durationFrames <= 0) return;
    const second = rate;
    let next: number | null = null;
    switch (e.key) {
      case "ArrowLeft":  next = frames - (e.shiftKey ? second : 1); break;
      case "ArrowRight": next = frames + (e.shiftKey ? second : 1); break;
      case "PageDown":   next = frames - second * 10; break;
      case "PageUp":     next = frames + second * 10; break;
      case "Home":       next = 0; break;
      case "End":        next = durationFrames; break;
      default: return;
    }
    // Stop here: the app binds bare arrows globally too, and letting the event
    // through would seek twice for one keypress.
    e.preventDefault();
    e.stopPropagation();
    onSeek(Math.max(0, Math.min(durationFrames, next)));
  };

  return (
    <div
      className="cp-playhead"
      style={{ left: `${left}%` }}
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
      role="slider"
      tabIndex={0}
      aria-label="Playhead"
      aria-valuemin={0}
      aria-valuemax={Math.max(0, durationFrames)}
      aria-valuenow={frames}
      // Screen readers should say the timecode, not a frame count.
      aria-valuetext={secondsToHms(frames / rate)}
      title="Drag to scrub, or focus and use the arrow keys"
    />
  );
}

/**
 * The in-progress comment range, drawn on the track.
 *
 * A leaf that subscribes to the playhead ITSELF, exactly like PlayheadCursor
 * above and for exactly the same reason. While one edge is armed the band's
 * other end is wherever the playhead is, and the previous design computed that
 * in ReviewPanel and pushed a fresh object into App state every frame — so the
 * whole App tree re-rendered at source fps during the one gesture where the
 * editor is scrubbing to find the other end of a comment. The panel now
 * publishes the anchor once, when a mark actually moves, and the repaint stops
 * here at this div.
 */
function RangeDraftBand({ draft, fps, durationFrames }: {
  draft: ReviewRangeDraft;
  fps: number;
  durationFrames: number;
}) {
  const r = Math.max(1, Math.round(fps));
  // Only a live draft needs the clock; a locked one is two fixed numbers.
  const playhead = usePlayheadFrames();
  // A live draft too short to be a span will POST as a point comment, so it
  // must not draw as a band. Without this the preview showed a range — the
  // band has a minimum rendered width, so it was plainly visible — and then
  // the comment landed as a dot. Same rule as rangeToPost, from one place.
  if (draft.live && !isRealSpan(draft.anchor, playhead / r)) return null;
  const [a, b] = draft.live
    // Clamped against the anchor so the band cannot invert while scrubbing
    // behind the marked edge — the behaviour the old clamp in ReviewPanel had.
    ? [Math.min(draft.anchor * r, playhead), Math.max(draft.anchor * r, playhead)]
    : [Math.min(draft.start, draft.end) * r, Math.max(draft.start, draft.end) * r];
  const pct = (f: number) => (durationFrames > 0 ? (f / durationFrames) * 100 : 0);
  return (
    <div
      className={"cp-track-range-draft" + (draft.live ? "" : " locked")}
      style={{
        left: `${pct(a)}%`,
        width: `${Math.max(0.4, pct(b - a))}%`,
        ["--marker-color" as string]: draft.color,
      }}
      title="New comment range"
    />
  );
}

type Props = {
  status: AppStatus;
  durationFrames: number;
  /** null = mark not set; selection range only renders when both are set. */
  inFrames: number | null;
  outFrames: number | null;
  fps: number;
  /** Ranges already in the queue (or completed) — drawn under the active selection. */
  queuedRanges?: TimelineRange[];
  /** Click a queued range -> App opens/focuses that item in the queue. */
  onRangeClick?: (id: string) => void;
  /** Review comment markers (seconds) — Frame.io-style dots on the track,
   *  tinted to the reviewer's colour, expanding to their initials on hover.
   *  When `timeEnd` is set the marker also draws a reviewer-tinted RANGE bar in
   *  the comment lane — deliberately unlike the orange clip in/out selection. */
  commentMarkers?: { id: string; time: number; timeEnd?: number | null; resolved: boolean; color: string; initials: string; carried?: boolean }[];
  /** Live preview of the range being set in the review composer — a dashed,
   *  pulsing reviewer-tinted bracket so it reads as "setting a comment range",
   *  distinct from both the orange clip marks and the saved comment ranges.
   *  `live` = an end still follows the playhead; false = both marks locked
   *  (renders solid with a one-shot flash). */
  reviewRangeDraft?: ReviewRangeDraft | null;
  /** Local file path to build the thumbnail filmstrip from (mediabunny-decoded).
   *  null for web/streaming sources or when there's no decodable local file.
   *  Also feeds the audio waveform lane — same local-files-only scope. */
  filmstripPath?: string | null;
  /** Audio waveform lane visibility (ViewOptions toggle). Default true;
   *  files with no decodable audio track simply render no waveform. */
  waveformOn?: boolean;
  /** Speaker lanes from the diarized transcript — a thin strip of tinted
   *  bands along the bottom of the track showing who talks when. */
  speakerLanes?: { startMs: number; endMs: number; color: string; speaker: string | null }[];
  /** Co-review ghost cursors — other participants' live playheads, one faint
   *  tinted line + name chip each (empty when not in a session). */
  /** Auto-detected chapters (seconds) — thin neutral ticks at the TOP edge of
   *  the track, a title chip on hover, click → seek. Deliberately unlike the
   *  reviewer-tinted comment dots (which sit mid-track). */
  chapterMarkers?: { time: number; title: string }[];
  onSeek: (f: number) => void;
};

/** The one piece of the timeline that re-renders on a peer's playhead tick.
 *  Private leaf, same file: it exists to fence a subscription, not for
 *  reuse, and it renders nothing outside a live session (empty store). */
function TimelineGhosts({ fps, pct }: { fps: number; pct: (f: number) => number }) {
  const ghosts = useSyncExternalStore(subscribeGhosts, getGhosts);
  if (ghosts.length === 0) return null;
  const me = loadReviewer();
  const r = Math.max(1, Math.round(fps));
  return (
    <>
      {ghosts.map((g) => (
        <div
          key={"ghost-" + g.name}
          className="cp-ghost-playhead"
          style={{ left: `${pct(Math.floor(g.position * r))}%`, ["--ghost-color" as string]: reviewerColorFor(g.name, me) }}
          title={`${g.name} is here`}
        >
          <span className="cp-ghost-chip">{g.name}</span>
        </div>
      ))}
    </>
  );
}

export function Timeline({
  status, durationFrames, inFrames, outFrames, fps,
  queuedRanges, onRangeClick, commentMarkers, reviewRangeDraft, filmstripPath, waveformOn, speakerLanes,
  chapterMarkers, onSeek,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [trackW, setTrackW] = useState(0);
  const [filmstrip, setFilmstrip] = useState<(string | null)[]>([]);
  const [wavePeaks, setWavePeaks] = useState<WaveformPeaks | null>(null);
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
    // Tell the rest of the app a drag is in progress. The co-review heartbeat
    // uses it to stop advertising positions the room was never meant to see;
    // the cleanup below covers mouseup, Escape and unmount alike.
    setScrubbing(true);
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
      setScrubbing(false);
    };
  }, [dragging, seekFromX]);

  // Measure the track width so the filmstrip picks a sensible thumbnail count.
  // Bucketed to 24px so a stray 1px resize doesn't re-decode the whole strip.
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    let timer = 0;
    let primed = false;
    const commit = (w: number) =>
      setTrackW((prev) => (Math.abs(prev - w) >= 24 ? Math.round(w) : prev));
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      // A hidden view reports 0. Committing that would drop the filmstrip and
      // change the cache key, so every trip to Home and back re-decoded the
      // whole strip. Width is never meaningfully 0 while on screen.
      if (w <= 0) return;
      // First measurement paints immediately; after that, commit only on the
      // trailing edge. The drawer's 280ms width transition fires this
      // continuously, and each distinct 24px bucket used to start a whole new
      // filmstrip decode — a second mediabunny Input + VideoDecoder on the same
      // file, competing for the same read_file_range IPC the audio pump needs.
      if (!primed) { primed = true; commit(w); return; }
      window.clearTimeout(timer);
      timer = window.setTimeout(() => commit(w), 350);
    });
    ro.observe(el);
    return () => { window.clearTimeout(timer); ro.disconnect(); };
  }, []);

  // Build the thumbnail filmstrip from the local file (mediabunny, one pass).
  // Depends on source/duration/width — NOT the playhead — so scrubbing never
  // re-decodes. Cached per source+count (LRU-bounded); aborted on source/size
  // change.
  useEffect(() => {
    const path = filmstripPath ?? null;
    const durSec = fps > 0 ? durationFrames / fps : 0;
    const count = filmstripCount(trackW);
    if (dim || !path || durSec <= 0 || count <= 0) { setFilmstrip([]); return; }

    const key = `${path}|${count}`;
    const cached = filmCacheRef.current.get(key);
    if (cached) {
      lruSet(filmCacheRef.current, key, cached, FILMSTRIP_CACHE_MAX); // hit → newest
      setFilmstrip(cached);
      return;
    }

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
      if (strip.length > 0) lruSet(filmCacheRef.current, key, strip, FILMSTRIP_CACHE_MAX);
      setFilmstrip(strip);
    })();
    return () => { alive = false; ctrl.abort(); };
  }, [filmstripPath, durationFrames, fps, trackW, dim]);

  // Extract audio peaks for the waveform lane. Mirrors the filmstrip's
  // scheduling: local files only, deferred until the duration is known (so
  // it never delays playback start or transcription), aborted on source
  // change. Bucket count is fixed, so no dependency on track width — resize
  // only redraws the canvas. Caching per path lives in lib/waveform.ts.
  useEffect(() => {
    const path = filmstripPath ?? null;
    const durSec = fps > 0 ? durationFrames / fps : 0;
    if (dim || !path || durSec <= 0 || waveformOn === false) { setWavePeaks(null); return; }

    const ctrl = new AbortController();
    let alive = true;
    void (async () => {
      const peaks = await extractWaveformPeaks(path, { signal: ctrl.signal });
      if (!alive || ctrl.signal.aborted) return;
      setWavePeaks(peaks);
    })();
    return () => { alive = false; ctrl.abort(); };
  }, [filmstripPath, durationFrames, fps, dim, waveformOn]);

  const pct = (f: number) => durationFrames > 0 ? (f / durationFrames) * 100 : 0;
  const ticks = Array.from({ length: 11 }, (_, i) => i);

  return (
    <div className="cp-timeline" role="region" aria-label="Timeline" style={{ opacity: dim ? 0.3 : 1 }}>
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
        className={"cp-track" + (dragging ? " dragging" : "") + (filmstrip.length > 0 ? " has-filmstrip" : "") + (wavePeaks ? " has-wave" : "")}
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
        {/* Audio waveform lane — muted peaks over the filmstrip, under the
            scrim and every overlay (playhead/marks/comments stay dominant). */}
        {wavePeaks && <TimelineWaveform peaks={wavePeaks} widthPx={trackW} />}
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
              const word =
                r.status === "done" ? "Exported"
                : r.status === "error" ? "Failed"
                : r.status === "running" ? "Exporting" : "Queued";
              const span = `${secondsToHms(r.inFrames / fps)} to ${secondsToHms(r.outFrames / fps)}`;
              return (
                // role/tabIndex/keydown, not a <button>: the band is an
                // absolutely-positioned percent-sized overlay inside the
                // track, and a UA button here would need its whole box model
                // reset. Enter/Space mirror the click (a11y r141).
                <div
                  key={r.id}
                  role="button"
                  tabIndex={onRangeClick ? 0 : -1}
                  aria-label={`${r.label ?? "Clip"}, ${word}, ${span}. Open in the queue.`}
                  className={"cp-track-queued " + (r.status ?? "queued")}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={`${r.label ?? "Clip"} · ${word} · ${span}`}
                  onClick={(e) => {
                    if (!onRangeClick) return;
                    e.stopPropagation(); // the track itself seeks on click
                    onRangeClick(r.id);
                  }}
                  onKeyDown={(e) => {
                    if (!onRangeClick || (e.key !== "Enter" && e.key !== " ")) return;
                    e.preventDefault();
                    e.stopPropagation();
                    onRangeClick(r.id);
                  }}
                />
              );
            })}
            {/* Full range when both marks are set. The edges carry small
                "[" / "]" bracket caps (CSS pseudo-elements on
                .cp-track-selection) echoing the IconMarkIn / IconMarkOut
                transport glyphs — one dialect from button to timeline. */}
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
            {/* Chapter ticks — thin neutral lines hugging the TOP edge so they
                never obscure the filmstrip, waveform, or speaker lanes below.
                Hover reveals the title chip; click seeks to the chapter. */}
            {chapterMarkers?.map((c, i) => {
              const r = Math.max(1, Math.round(fps));
              return (
                <div
                  key={`ch-${c.time}-${i}`}
                  className="cp-track-chapter"
                  style={{ left: `${pct(c.time * r)}%` }}
                  onMouseDown={(e) => { e.stopPropagation(); onSeek(Math.floor(c.time * r)); }}
                >
                  <span className="cp-track-chapter-tip">{c.title}</span>
                </div>
              );
            })}
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
                  className={"cp-track-comment-range" + (m.resolved ? " resolved" : "") + (m.carried ? " carried" : "")}
                  style={{ left: `${pct(m.time * r)}%`, width: `${Math.max(0.4, pct((m.timeEnd - m.time) * r))}%`, ["--marker-color" as string]: m.color }}
                  title={m.carried ? "Range note from an earlier cut · click to jump to its start" : "Review range · click to jump to its start"}
                  onMouseDown={(e) => { e.stopPropagation(); onSeek(Math.floor(m.time * r)); }}
                />
              );
            })}
            {/* Live preview of the range being set in the composer — dashed +
                pulsing so it reads as "setting", not a saved range. */}
            {reviewRangeDraft && (
              <RangeDraftBand draft={reviewRangeDraft} fps={fps} durationFrames={durationFrames} />
            )}
            {/* Review comment markers — click a dot to jump to that note. */}
            {commentMarkers?.map((m) => {
              const r = Math.max(1, Math.round(fps));
              return (
                <div
                  key={m.id}
                  className={"cp-track-comment" + (m.resolved ? " resolved" : "") + (m.carried ? " carried" : "")}
                  style={{ left: `${pct(m.time * r)}%`, ["--marker-color" as string]: m.color }}
                  title={m.carried ? "Open note from an earlier cut · click to jump" : "Review comment · click to jump"}
                  onMouseDown={(e) => { e.stopPropagation(); onSeek(Math.floor(m.time * r)); }}
                >
                  <span className="cp-track-comment-ini">{m.initials}</span>
                </div>
              );
            })}
            {/* Co-review ghost cursors — other participants' live playheads.
                Faint tinted lines with a name chip; behind the real playhead.
                A self-subscribing leaf: presence ticks at up to 3 Hz per
                peer, and as a prop threaded from App that rate re-rendered
                the entire keep-alive App tree for the life of a session. */}
            <TimelineGhosts fps={fps} pct={pct} />
            <PlayheadCursor
              durationFrames={durationFrames}
              fps={fps}
              onMouseDown={onPlayheadDown}
              onSeek={onSeek}
            />
          </>
        )}
      </div>
    </div>
  );
}
