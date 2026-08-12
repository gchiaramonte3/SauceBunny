import { CHANGE_COOLDOWN_MS, DOWNSHIFT_WINDOW_MS } from "./stream-rung";

/**
 * "Watch it now" also keeps it: the policy that turns a Tier B live stream
 * into a local copy while you watch.
 *
 * THE GAP THIS CLOSES. A guest with no copy of the source had two separate
 * choices — watch live (Tier B: nothing kept, and every seek re-asks the host)
 * or fetch the file (Tier C: wait, then watch). Picking "watch" meant the
 * session ended with nothing on disk, so the next session started from zero
 * again. The plan's own words for why this matters: it is the difference
 * between "we stream" and "we stream AND you end up with the file".
 *
 * IT IS TIER C IN THE BACKGROUND, NOT A SECOND MECHANISM. The obvious
 * implementation — write the received Tier B bytes to disk — cannot work, and
 * it is worth being explicit about why, because it looks correct. Tier B is
 * `ffmpeg -ss <start> … -f mp4 pipe:1`: the bytes on the wire are a FRESH
 * fragmented stream, generated on demand, whose content depends on where the
 * guest seeked to and which rung the ladder had settled on. Two seeks produce
 * two independent streams with their own headers, at possibly different
 * resolutions. Concatenating them yields a file that is not the source and
 * frequently is not playable. Tier C already moves the real bytes, resumably
 * and BLAKE3-verified, so keeping is Tier C running quietly underneath.
 *
 * THE WHOLE POLICY IS "DO NOT SPOIL THE PICTURE". A bulk transfer sharing the
 * connection with the live stream competes with it, and the loser is visible:
 * the rung ladder reads the resulting stalls as a slow network and downshifts,
 * so the reviewer spends the session looking at 360p because of a background
 * copy they never asked for. Hence: start late, yield on the first sign of
 * trouble, and stay out of the way long enough that resuming cannot be
 * mistaken for evidence.
 *
 * Pure and side-effect free, like its sibling `stream-rung.ts` and for the same
 * reason: a bad policy here does not crash, it just quietly makes someone
 * else's review worse.
 */

/**
 * How long the live stream must run before the copy starts.
 *
 * Stream start is the most fragile moment there is — ffmpeg spinning up, MSE
 * priming, the first buffer filling from empty — and it is exactly when the
 * rung machine discounts stalls (`CHANGE_COOLDOWN_MS`) because a rebuild
 * manufactures its own. Adding a bulk transfer into that window would turn a
 * normal startup wobble into a real downshift, and the guest would then watch
 * the whole session at a rung chosen in its first three seconds. Waiting out
 * the same cooldown the ladder already trusts is the principled number.
 */
export const KEEP_START_DELAY_MS = CHANGE_COOLDOWN_MS;

/**
 * How long the copy stays out of the way after the live stream stalls.
 *
 * Derived, not picked: the ladder downshifts on `DOWNSHIFT_STALLS` stalls
 * inside `DOWNSHIFT_WINDOW_MS`. Yielding for a FULL downshift window means the
 * stall that made us yield has aged out before we resume — so even if resuming
 * does cause another one, it is a lone stall and cannot complete the pattern.
 * The copy is therefore incapable of being the second stall in a downshift,
 * which is the precise harm being avoided.
 */
export const KEEP_YIELD_MS = DOWNSHIFT_WINDOW_MS;

export type KeepPhase =
  /** Not keeping: not watching, or deliberately declined. */
  | "off"
  /** Watching; holding off until the stream proves itself. */
  | "waiting"
  /** The background copy is running. */
  | "keeping"
  /** Backed off after a live stall; will resume. */
  | "yielded"
  /** The copy landed and verified. `path` is set. */
  | "done"
  /** The copy failed for a reason retrying will not fix. */
  | "failed";

export type KeepState = {
  phase: KeepPhase;
  /**
   * The file being kept. A source change must abandon the copy rather than
   * finish it and hand off the WRONG file — the failure that would be hardest
   * to see, because the handoff looks like it worked.
   */
  blake3: string | null;
  received: number;
  total: number;
  /** Where the last transition happened, so the delays above can be measured. */
  since: number;
  /** Set only in `done`. */
  path: string | null;
  /** Why keeping is off, when it is off for a reason worth saying out loud. */
  reason: "relayed" | "declined" | null;
};

export const IDLE_KEEP: KeepState = Object.freeze({
  phase: "off" as const, blake3: null, received: 0, total: 0,
  since: 0, path: null, reason: null,
});

export type KeepEvent =
  /** A Tier B watch started. `relayed` comes from the transport's X-Relay;
   *  `enabled` is the user's standing preference for this machine. */
  | { t: "watch"; blake3: string; total: number; relayed: boolean; enabled: boolean; at: number }
  /** The `<video>` ran out of buffered media — the signal to back off. */
  | { t: "stall"; at: number }
  /** Periodic poll: the only thing that starts or resumes a copy. */
  | { t: "tick"; at: number }
  | { t: "progress"; received: number; total: number }
  | { t: "done"; path: string; at: number }
  /** A failure retrying will not fix (verification, host withdrew the offer). */
  | { t: "failed"; at: number }
  /** Watching stopped, the source changed, or the session ended. */
  | { t: "stop"; at: number };

/**
 * Advance the policy. Returns a NEW state; the caller compares `phase` with the
 * old one to decide whether to start, cancel, or hand off.
 */
export function reduceKeep(s: KeepState, e: KeepEvent): KeepState {
  switch (e.t) {
    case "watch": {
      // Turned off in Settings. Recorded as a reason rather than a bare `off`
      // so the UI can stay SILENT about it: a machine that has opted out of
      // background copies should not be told about the one it just declined,
      // every single time it watches something.
      if (!e.enabled) {
        return { ...IDLE_KEEP, phase: "off", blake3: e.blake3, reason: "declined", since: e.at };
      }
      // A relayed path carries the media across n0's public infrastructure
      // rather than between the two Macs. The ladder already refuses to spend
      // more than its lowest rung there; quietly pulling the entire file
      // through it because someone pressed "watch" is a far bigger version of
      // the same bargain, and it is not ours to make silently.
      if (e.relayed) {
        return { ...IDLE_KEEP, phase: "off", blake3: e.blake3, reason: "relayed", since: e.at };
      }
      return {
        phase: "waiting", blake3: e.blake3, received: 0, total: e.total,
        since: e.at, path: null, reason: null,
      };
    }
    case "stall": {
      // Only a running copy can be the problem. Yielding from `waiting` would
      // restart the clock on a copy that has not put a single byte on the wire.
      if (s.phase !== "keeping") return s;
      return { ...s, phase: "yielded", since: e.at };
    }
    case "tick": {
      if (s.phase === "waiting" && e.at - s.since >= KEEP_START_DELAY_MS) {
        return { ...s, phase: "keeping", since: e.at };
      }
      if (s.phase === "yielded" && e.at - s.since >= KEEP_YIELD_MS) {
        return { ...s, phase: "keeping", since: e.at };
      }
      return s;
    }
    case "progress": {
      // Progress from a copy we have already abandoned or finished must not
      // resurrect it — the in-flight transfer is cancelled asynchronously, so
      // a late event after `stop` is ordinary, not exceptional.
      if (s.phase !== "keeping" && s.phase !== "yielded") return s;
      return { ...s, received: e.received, total: e.total || s.total };
    }
    case "done": {
      if (s.phase === "off" || s.phase === "done") return s;
      return { ...s, phase: "done", path: e.path, received: s.total, since: e.at };
    }
    case "failed": {
      if (s.phase === "off" || s.phase === "done") return s;
      return { ...s, phase: "failed", since: e.at };
    }
    case "stop":
      return { ...IDLE_KEEP, since: e.at };
  }
}

/**
 * Whether the caller should have a transfer running right now.
 *
 * The reducer describes intent; this is the one line the effect reads, so
 * "start it" and "cancel it" cannot drift apart into two different opinions.
 */
export function shouldTransfer(s: KeepState): boolean {
  return s.phase === "keeping";
}

/**
 * Whether the kept copy may now replace the live stream.
 *
 * Guarded on the file still being the one on screen. Without that check a copy
 * finishing just after the host loaded a different source would swap the
 * player onto the previous file — and because the handoff is designed to be
 * invisible, nothing would announce it.
 */
export function shouldHandOff(s: KeepState, watchingBlake3: string | null): boolean {
  return s.phase === "done" && s.path !== null && s.blake3 !== null && s.blake3 === watchingBlake3;
}

/** Fraction in [0, 1], or null when the size is not known yet. */
export function keepProgress(s: KeepState): number | null {
  if (s.total <= 0) return null;
  return Math.max(0, Math.min(1, s.received / s.total));
}

/**
 * One short line for the UI, or null when there is nothing worth saying.
 *
 * Deliberately quiet. This is a background convenience nobody asked for, so it
 * earns a status line and not a dialog — and it must never read as an error,
 * because a failed keep costs the user nothing they had.
 */
export function keepBadge(s: KeepState): string | null {
  switch (s.phase) {
    case "off":
      // "declined" says nothing on purpose — see the reducer.
      return s.reason === "relayed" ? "Not saving a copy on a relayed connection" : null;
    case "waiting":
      return "Saving a copy shortly";
    case "keeping": {
      const p = keepProgress(s);
      return p === null ? "Saving a copy" : `Saving a copy · ${Math.round(p * 100)}%`;
    }
    case "yielded":
      return "Saving a copy · paused for playback";
    case "done":
      return "Saved · playing your own copy";
    case "failed":
      return "Could not save a copy";
  }
}
