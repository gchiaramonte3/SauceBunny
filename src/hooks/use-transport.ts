import { useCallback, useEffect, useRef, useState } from "react";
import type { PlayerHandle } from "../components/player-handle";
import type { SourceKind } from "../types";
import { clampSeekFrames, maxSeekSeconds } from "../lib/playhead-clock";
import { nextShuttleRate } from "../lib/shuttle";
import {
  getPlayheadFrames,
  markUserSeek,
  playheadSecondsToFrames,
  setPlayheadFrames as publishPlayheadFrames,
  subscribePlayhead,
} from "../lib/playhead-store";

/**
 * The transport: everything that moves the playhead or marks a point on it.
 *
 * Shuttle (J-K-L), play/pause, frame steps, second jumps, seeks, and the clip
 * in/out marks. These were 190 lines in the middle of App.tsx, and they belong
 * together for a reason that is not filing: almost every one of them has to
 * cancel a running shuttle first, and the two that deliberately do NOT
 * (`onChaseSeek` skipping `markUserSeek`, and the shuttle ladder's own
 * transitions) are only legible next to the ones that do. Scattered through a
 * six-thousand-line component that pairing was invisible.
 *
 * Same extraction pattern as use-panel-bus / use-web-playback / use-co-review:
 * one cohesive subsystem, lifted whole, App destructures the result so no call
 * site changed.
 *
 * Two rules the whole file obeys:
 *
 *  · Read the playhead at ACTION time via `getPlayheadFrames()`, never from a
 *    closure. A handler built on an early render would otherwise mark or step
 *    from wherever the playhead was then.
 *  · Compute, then write. Seeking inside a React updater made StrictMode's
 *    double-invoke seek twice.
 */
export type TransportDeps = {
  playerRef: React.RefObject<PlayerHandle | null>;
  status: string;
  isPlaying: boolean;
  setIsPlaying: React.Dispatch<React.SetStateAction<boolean>>;
  fps: number;
  durationFrames: number;
  inFrames: number | null;
  outFrames: number | null;
  setInFrames: (f: number | null) => void;
  setOutFrames: (f: number | null) => void;
  pushMarksUndo: (
    label: string,
    prevIn: number | null, prevOut: number | null,
    nextIn: number | null, nextOut: number | null,
  ) => void;
  /** Which player is mounted — decides the shuttle ceiling. */
  sourceKind: SourceKind;
  localFilePath: string | null;
  webCachePath: string | null;
  webStreamUrl: string | null;
};

export function useTransport({
  playerRef, status, isPlaying, setIsPlaying, fps, durationFrames,
  inFrames, outFrames, setInFrames, setOutFrames, pushMarksUndo,
  sourceKind, localFilePath, webCachePath, webStreamUrl,
}: TransportDeps) {
// ── Variable-speed shuttle (NLE-grade J-K-L) ────────────────────────
// rate: 0 = normal · >0 = fast-forward × · <0 = rewind ×. Each J/L press
// walks the Premiere-style ladder (lib/shuttle.ts): 1-2-4-8× in the pressed
// direction, opposite presses step back down, landing on +1 resumes REAL
// playback. K+J / K+L nudge a single frame. Routed to the live player, which
// honors it per-engine (MediaBunny does true smooth reverse; WebKit
// fast-forwards natively + scans backward — see PlayerHandle).
const shuttleRateRef = useRef(0);
// Mirrored into state so the Monitor can render the "◀◀ 4×" badge.
const [shuttleRate, setShuttleRate] = useState(0);
// Physical K held? Turns the next J/L into a frame-step (set on keydown,
// cleared on keyup/window-blur in the keyboard effect below).
const kHeldRef = useRef(false);

const applyShuttle = useCallback((rate: number) => {
  shuttleRateRef.current = rate;
  setShuttleRate(rate);
  playerRef.current?.setShuttle?.(rate);
}, [playerRef]);
const exitShuttle = useCallback(() => {
  if (shuttleRateRef.current !== 0) applyShuttle(0);
}, [applyShuttle]);

const onPlayToggle = useCallback(() => {
  // K / Space / the play button while shuttling → just stop the shuttle.
  if (shuttleRateRef.current !== 0) { applyShuttle(0); return; }
  if (status !== "loaded" && status !== "exporting" && status !== "success") return;
  const p = playerRef.current;
  if (p && p.isReady()) {
    if (isPlaying) p.pause();
    else p.play();
  } else {
    setIsPlaying((x) => !x);
  }
}, [status, isPlaying, applyShuttle, playerRef, setIsPlaying]);

const onStep = useCallback((delta: number) => {
  exitShuttle();
  const p = playerRef.current;
  const r = Math.max(1, Math.round(fps));
  // Read the live position from the store (action-time read — never a stale
  // closure), compute, THEN write. Also keeps the seek side effect out of a
  // React updater, where StrictMode's double-invoke used to double-seek.
  const next = clampSeekFrames(getPlayheadFrames() + delta, durationFrames);
  markUserSeek(next); // review fix: frame-steps must arm the co-review latch too
  if (p && p.isReady()) {
    p.pause();
    p.seekTo(next / r);
  }
  publishPlayheadFrames(next);
}, [durationFrames, fps, exitShuttle, playerRef]);

const seekBySeconds = useCallback((deltaSec: number) => {
  exitShuttle();
  const r = Math.max(1, Math.round(fps));
  const p = playerRef.current;
  const currentSec = p?.isReady() ? (p.getCurrentTime?.() ?? 0) : getPlayheadFrames() / r;
  // maxSeekSeconds is Infinity while the duration is unknown, so a jump can
  // never be dragged backward by a missing/lying metadata duration.
  const targetSec = Math.max(0, Math.min(maxSeekSeconds(durationFrames, fps), currentSec + deltaSec));
  markUserSeek(playheadSecondsToFrames(targetSec, fps)); // arms the co-review latch
  publishPlayheadFrames(playheadSecondsToFrames(targetSec, fps));
  if (p?.isReady()) p.seekTo(targetSec);
}, [fps, durationFrames, exitShuttle, playerRef]);

// Max |shuttle rate| for the ACTIVE player. The MSE web stream caps at 4× —
// reverse scans only the buffered window and forward playbackRate beyond
// that outruns the proxy's fMP4 remux. Local/downloaded playback takes 8×.
// Mirrors Monitor's player choice: MSE mounts only for an http(s) web
// stream URL (the download-fallback cachePath is a local file → 8×).
const playerShuttleCap = useCallback(() => {
  const webSrc = webCachePath ?? webStreamUrl;
  const usesMse = !(sourceKind === "file" && localFilePath)
    && !!webSrc && /^https?:\/\//i.test(webSrc);
  return usesMse ? 4 : 8;
}, [sourceKind, localFilePath, webCachePath, webStreamUrl]);

/**
 * J/L transport press. K held → single-frame nudge (the K+J / K+L editor
 * convention); otherwise walk the shuttle ladder in `direction`. Landing on
 * +1 exits the shuttle into REAL playback (native clock + audio).
 */
const shuttleStep = useCallback((direction: 1 | -1, isRepeat = false) => {
  if (kHeldRef.current) { onStep(direction); return; } // frame-step (pauses + kills shuttle)
  // Holding J/L auto-repeats the keydown — hold sustains the current rate;
  // only discrete presses climb the ladder (matches Premiere/Resolve).
  if (isRepeat) return;
  const p = playerRef.current;
  const playing = p?.isReady() ? p.isPlaying() : isPlaying;
  const cur = shuttleRateRef.current !== 0 ? shuttleRateRef.current : (playing ? 1 : 0);
  const next = nextShuttleRate(cur, direction, playerShuttleCap());
  if (next === 1) {
    // +1 = normal play, not a 1× shuttle — same start path onPlayToggle uses.
    applyShuttle(0);
    if (p?.isReady()) p.play();
    else setIsPlaying(true);
    return;
  }
  applyShuttle(next);
}, [isPlaying, onStep, applyShuttle, playerShuttleCap, playerRef, setIsPlaying]);

// The players self-terminate a shuttle at the media bounds (reverse hits 0 /
// forward hits the end) without a callback; watch the playhead STORE while a
// shuttle is active so the badge clears and the next J/L starts from a clean
// slate. A subscription, not state — the per-tick edge check must not
// re-render App.
useEffect(() => {
  if (shuttleRate === 0 || durationFrames <= 0) return;
  const check = () => {
    const f = getPlayheadFrames();
    if ((shuttleRate < 0 && f <= 0)
     || (shuttleRate > 1 && f >= durationFrames - 1)) applyShuttle(0);
  };
  check(); // the edge may already be behind us the moment the shuttle starts
  return subscribePlayhead(check);
}, [shuttleRate, durationFrames, applyShuttle]);

const onMarkIn = useCallback(() => {
  const r = Math.max(1, Math.round(fps));
  // Action-time store read: mark the frame on screen when the key lands.
  const f = getPlayheadFrames();
  // If an out mark already exists and the playhead is past it, bump out a frame.
  const next = (outFrames != null && f >= outFrames)
    ? Math.max(0, outFrames - r)
    : f;
  if (next !== inFrames) pushMarksUndo("mark in", inFrames, outFrames, next, outFrames);
  setInFrames(next);
}, [inFrames, outFrames, fps, pushMarksUndo, setInFrames]);

const onMarkOut = useCallback(() => {
  const r = Math.max(1, Math.round(fps));
  // Action-time store read: mark the frame on screen when the key lands.
  const f = getPlayheadFrames();
  const next = (inFrames != null && f <= inFrames)
    ? clampSeekFrames(inFrames + r, durationFrames)
    : f;
  if (next !== outFrames) pushMarksUndo("mark out", inFrames, outFrames, inFrames, next);
  setOutFrames(next);
}, [inFrames, outFrames, fps, durationFrames, pushMarksUndo, setOutFrames]);

// Clear literally clears — no selection at all.
const onClearMarks = useCallback(() => {
  if (inFrames != null || outFrames != null) {
    pushMarksUndo("clear in/out", inFrames, outFrames, null, null);
  }
  setInFrames(null);
  setOutFrames(null);
}, [inFrames, outFrames, pushMarksUndo, setInFrames, setOutFrames]);

const onGotoIn = useCallback(() => {
  if (inFrames == null) return;
  exitShuttle();
  const r = Math.max(1, Math.round(fps));
  markUserSeek(inFrames);
  publishPlayheadFrames(inFrames);
  playerRef.current?.seekTo?.(inFrames / r);
}, [inFrames, fps, exitShuttle, playerRef]);

const onGotoOut = useCallback(() => {
  if (outFrames == null) return;
  exitShuttle();
  const r = Math.max(1, Math.round(fps));
  markUserSeek(outFrames);
  publishPlayheadFrames(outFrames);
  playerRef.current?.seekTo?.(outFrames / r);
}, [outFrames, fps, exitShuttle, playerRef]);

const onSeek = useCallback((f: number) => {
  exitShuttle();
  const r = Math.max(1, Math.round(fps));
  // clampSeekFrames owns the duration clamp: an unknown duration (0) must
  // never clamp — the old inline `min(durationFrames - 1, f)` sent every
  // click to frame 0 whenever metadata hadn't arrived (or lied short).
  const clamped = clampSeekFrames(f, durationFrames);
  markUserSeek(clamped); // arms the store's dev backward-motion canary
  publishPlayheadFrames(clamped);
  playerRef.current?.seekTo?.(clamped / r);
}, [durationFrames, fps, exitShuttle, playerRef]);

// Co-review chase corrections: onSeek minus markUserSeek — the chase must
// never arm the latch it yields to (review fix).
const onChaseSeek = useCallback((f: number) => {
  exitShuttle();
  const r = Math.max(1, Math.round(fps));
  const clamped = clampSeekFrames(f, durationFrames);
  publishPlayheadFrames(clamped);
  playerRef.current?.seekTo?.(clamped / r);
}, [durationFrames, fps, exitShuttle, playerRef]);

  // applyShuttle and exitShuttle are deliberately NOT returned. Extracting
  // this subsystem is what revealed they were never used outside it: every
  // one of their ~20 references was another transport handler cancelling a
  // running shuttle before it moved the playhead. That is an invariant of the
  // transport, not an operation App should be able to perform on its own.
  return {
    /** 0 = normal · >0 = fast-forward × · <0 = rewind ×. Drives Monitor's badge. */
    shuttleRate,
    /** True while physical K is down — turns the next J/L into a frame step. */
    kHeldRef,
    onPlayToggle,
    onStep,
    seekBySeconds,
    shuttleStep,
    onMarkIn,
    onMarkOut,
    onClearMarks,
    onGotoIn,
    onGotoOut,
    onSeek,
    onChaseSeek,
  };
}
