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
 * cue lookup, the annotation proximity fade, and the review composer (its
 * "Comment at 1:23" placeholder and the range pill's following edge).
 * Everything else in the App tree stops re-rendering on playback ticks
 * entirely.
 *
 * "Only what paints it" means the SMALLEST component that paints it. ReviewPanel
 * subscribed at its own top for a value the composer used, and paid for it by
 * re-rendering the whole thread list every frame; the fix was to push the
 * subscription down rather than to memoize the rows above it.
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

/** When the user last seeked (ms epoch; 0 = never). Consumers that would
 *  MOVE the playhead on their own (the co-review host chase) must yield to a
 *  fresh local gesture. */
export function getLastUserSeekAt(): number {
  return lastUserSeekAt;
}

/**
 * IS THE USER DRAGGING THE PLAYHEAD RIGHT NOW?
 *
 * A drag emits a seek per display frame, and locally that is exactly right:
 * one seek per vsync is what makes scrubbing show every frame (see Timeline).
 * But a co-review presenter also ADVERTISES its position twice a second, and
 * a mid-drag position is one the room was never meant to look at. Each one
 * costs a guest a real seek - on a web source that is a full ffmpeg stream
 * rebuild - so a two-second drag spent every guest several rebuilds racing a
 * target that had already moved, and the frame the presenter actually stopped
 * on arrived last and slowest.
 *
 * So the drag is published here, next to the playhead it is dragging, rather
 * than threaded as a prop through App: the Timeline already writes to this
 * store and the heartbeat already reads from it. Listeners exist so settling
 * can send at once instead of waiting out the next 500ms beat.
 *
 * Global by design - there is one playhead - and inert outside a session.
 */
let scrubbing = false;
const scrubListeners = new Set<(active: boolean) => void>();

export function setScrubbing(active: boolean): void {
  if (scrubbing === active) return;
  scrubbing = active;
  for (const l of scrubListeners) l(active);
}

export function isScrubbing(): boolean {
  return scrubbing;
}

/** Notified on every change. Returns an unsubscribe fn. */
export function subscribeScrub(l: (active: boolean) => void): () => void {
  scrubListeners.add(l);
  return () => { scrubListeners.delete(l); };
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
 * Playhead in seconds, read at ACTION time. The counterpart to
 * `getPlayheadFrames` for the handlers that want the seconds shape, including
 * the `null while inactive` rule so a mark taken with no playable source is
 * refused rather than silently stamped at 0:00.
 *
 * This exists so a component does not have to subscribe (and therefore
 * re-render 60×/s) just to have a value ready for a click handler. That was
 * exactly ReviewPanel's mistake: it took `usePlayheadSeconds` at the top and
 * then used the result almost entirely inside mark-in/mark-out/submit
 * handlers, so every comment row in the thread list re-rendered every frame
 * of playback to serve four functions that could have read the value when
 * they fired.
 */
export function getPlayheadSeconds(fps: number, active = true): number | null {
  return active ? playheadFramesToSeconds(playheadFrames, fps) : null;
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

/**
 * Playhead in WHOLE seconds unless `fine` - for a component whose render
 * output is second-granularity text (an h:mm:ss clock, a "Comment at 1:23"
 * placeholder). useSyncExternalStore bails on an Object.is-equal snapshot,
 * so flooring here is what turns a per-frame re-render into one per second:
 * the review composer subscribed at frame rate to paint text that changes
 * 24-60x less often than it re-rendered. `fine` flips back to frame
 * granularity for the moments that genuinely show frames - the composer's
 * armed range edge renders a full timecode that follows the playhead.
 */
export function usePlayheadSecondsCoarse(fps: number, active = true, fine = false): number | null {
  return useSyncExternalStore(
    subscribePlayhead,
    () => {
      if (!active) return null;
      const s = playheadFramesToSeconds(playheadFrames, fps);
      return fine ? s : Math.floor(s);
    },
  );
}
