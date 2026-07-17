import { useSyncExternalStore } from "react";

/**
 * Playhead subscription store — the ONE place the live playhead lives.
 *
 * The playhead ticks up to 60×/sec while media plays. As App-level React
 * state that meant re-rendering the entire (unmemoized) App tree per frame —
 * and memoizing wasn't a fix, because Monitor's ~50-prop surface makes the
 * prop-compare itself per-frame work. So the playhead lives OUTSIDE React in
 * this module, and only the handful of components that actually paint it
 * subscribe (via `useSyncExternalStore`): the Transport timecode readout, the
 * Timeline cursor, the TranscriptViewer karaoke highlight, the CaptionOverlay
 * cue lookup, and the annotation proximity fade. Everything else in the App
 * tree stops re-rendering on playback ticks entirely.
 *
 * Canonical unit: integer FRAMES at the source fps — exactly the quantization
 * the old `playheadFrames` state used (`Math.floor(seconds × fps)` on the way
 * in). Seconds consumers derive `frames / max(1, round(fps))`, the same
 * formula App always used, so the transcript highlight, on-video captions,
 * timecode, and scrubber all stay in sync by construction (the r88
 * single-clock model — the store is a fan-out of that one clock, never a
 * second clock).
 *
 * Cadence contract:
 *   • Writers: the active player's onTimeUpdate (60Hz), every seek/step/reset
 *     path in App, and — in the floating panel window, which is a separate JS
 *     context with its own store instance — PanelApp mirroring the ~4Hz
 *     `panel:state` snapshot in.
 *   • Render subscribers re-render per tick (same cadence the old prop plumbing
 *     gave them). Action-time readers (mark in/out, frame snapshot, the co-review
 *     heartbeat) call `getPlayheadFrames()` when they fire instead of holding a
 *     possibly-stale closure value.
 */

type Listener = () => void;

let playheadFrames = 0;
const listeners = new Set<Listener>();

/** Current playhead in integer frames. Safe to call anywhere, any time. */
export function getPlayheadFrames(): number {
  return playheadFrames;
}

/** Set by App's seek entry points; arms the dev-only backward-motion canary. */
let lastUserSeekAt = 0;
let lastUserSeekFrames = 0;
export function markUserSeek(frames: number): void {
  lastUserSeekAt = Date.now();
  lastUserSeekFrames = frames;
}

/**
 * Move the playhead. No-ops (and doesn't notify) when the frame is unchanged,
 * so a paused player's timeupdate ticks don't cause re-renders.
 */
export function setPlayheadFrames(frames: number): void {
  if (frames === playheadFrames) return;
  // Dev canary (fix-plan step 7): the recurring regression class is "the
  // playhead moves backward right after a user seek without a user action".
  // Catch the NEXT one at the single publish point instead of letting the
  // user rediscover it. Dev-only: stripped from production builds.
  if (import.meta.env.DEV) {
    const sinceSeek = Date.now() - lastUserSeekAt;
    if (sinceSeek < 2000 && lastUserSeekFrames - frames > 30) {
      console.error(
        `[playhead-canary] backward publish ${playheadFrames} → ${frames} ` +
        `(${sinceSeek}ms after a user seek to ${lastUserSeekFrames}). ` +
        "A writer is fighting the seek. Check fps conversions and stale closures.",
      );
    }
  }
  playheadFrames = frames;
  // Snapshot the set so a listener unsubscribing mid-notify can't skip peers.
  for (const l of [...listeners]) l();
}

/** The `seconds → frames` conversion every WRITER uses — the exact inverse of
 *  playheadFramesToSeconds below. Publishing through any other formula is how
 *  the 24-vs-30 fps split (the 0.8x post-seek slide) shipped: one conversion,
 *  one place. */
export function playheadSecondsToFrames(seconds: number, fps: number): number {
  return Math.floor(seconds * Math.max(1, Math.round(fps)));
}

/** Subscribe to playhead changes. Returns the unsubscribe function. */
export function subscribePlayhead(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The `frames → seconds` conversion every seconds-consumer uses (same
 *  rounding App has always applied, so all derived clocks agree). */
export function playheadFramesToSeconds(frames: number, fps: number): number {
  return frames / Math.max(1, Math.round(fps));
}

/** Live playhead in frames — re-renders the caller on every tick. */
export function usePlayheadFrames(): number {
  return useSyncExternalStore(subscribePlayhead, getPlayheadFrames);
}

/**
 * Live playhead in seconds, or null while `active` is false — the shape the
 * transcript/review panels want: `null` freezes the karaoke highlight and
 * blocks "comment at playhead" stamps (a mark at 0:00 would be a lie), and
 * flipping `active` back on snaps straight to the current position. While
 * inactive the store still notifies but the snapshot pins to null, so the
 * caller doesn't re-render on ticks it can't see.
 */
export function usePlayheadSeconds(fps: number, active = true): number | null {
  return useSyncExternalStore(
    subscribePlayhead,
    () => (active ? playheadFramesToSeconds(playheadFrames, fps) : null),
  );
}
