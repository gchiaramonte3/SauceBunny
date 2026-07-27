/**
 * The Tier B quality ladder, and the state machine that walks it.
 *
 * Pure and side-effect free on purpose: this is the component of adaptive
 * streaming most likely to be wrong in a way nobody notices, because a bad
 * policy does not crash — it just makes the picture worse than it needed to
 * be, intermittently, on someone else's network. So it lives here, away from
 * the player, and every rule below has a test.
 *
 * WHO DECIDES. The peer chooses the rung and the host executes it. Starvation
 * is observable only where the video actually plays, so the guest owns the
 * policy; the host is told a number and encodes to it. There is no manifest,
 * no pre-generated ladder and no bandwidth probe — the stream is the probe.
 *
 * THE ASYMMETRY IS THE DESIGN. Downshift fast, upshift slowly and rarely.
 * Every rung change costs a full pipeline rebuild (a new ffmpeg spin-up plus
 * the round trip), so a symmetric controller oscillates and ends up worse than
 * simply pinning 720p forever. If you are tempted to make upshift more eager,
 * that is the failure mode you are walking into.
 */

/** Rung heights, and the only values that may cross the wire. */
export const RUNG_HEIGHTS = [1080, 720, 540, 360] as const;
export type RungHeight = (typeof RUNG_HEIGHTS)[number];

export type Rung = {
  height: RungHeight;
  /** ffmpeg `-b:v`, in kbit/s. */
  videoKbps: number;
  /** ffmpeg `-b:a`, in kbit/s. */
  audioKbps: number;
};

/**
 * The ladder, widest first. Bitrates are measured, not guessed: the design
 * notes record 3.13 / 1.80 / 0.90 / 0.47 Mbps achieved and 7.4x / 14x / 22x /
 * 34x realtime encode on the target hardware.
 *
 * Audio holds at 96k on the bottom rung instead of dropping to 64k. In a
 * review tool intelligibility outranks picture — a reviewer who cannot make
 * out a word has lost the session, while one looking at a soft 360p image has
 * not. Cut video first, deliberately.
 */
export const RUNGS: readonly Rung[] = [
  { height: 1080, videoKbps: 4500, audioKbps: 128 },
  { height: 720, videoKbps: 2500, audioKbps: 128 },
  { height: 540, videoKbps: 1200, audioKbps: 96 },
  { height: 360, videoKbps: 600, audioKbps: 96 },
];

export const DEFAULT_RUNG: RungHeight = 720;
export const LOWEST_RUNG: RungHeight = RUNGS[RUNGS.length - 1].height;

export function rungFor(height: RungHeight): Rung {
  const r = RUNGS.find((x) => x.height === height);
  // Unreachable through the type, but the wire is not typed: a rung number
  // arriving from a peer on a different build must land somewhere sane rather
  // than crash the pipeline.
  return r ?? RUNGS[1];
}

export function isRungHeight(n: unknown): n is RungHeight {
  return typeof n === "number" && (RUNG_HEIGHTS as readonly number[]).includes(n);
}

// ── Policy constants (all from the measured design notes) ────────────
/** Two stalls this close together mean the network is not keeping up. */
export const DOWNSHIFT_WINDOW_MS = 30_000;
export const DOWNSHIFT_STALLS = 2;
/** A clean stretch before the first upshift. */
export const UPSHIFT_CLEAN_MS = 60_000;
/** A longer one before a SECOND upshift, so we cannot climb in steps. */
export const UPSHIFT_REPEAT_CLEAN_MS = 120_000;
/**
 * Stalls this soon after a rung change do not count toward the next downshift.
 *
 * Not in the original design notes; a test caught the omission. Changing rung
 * IS a full pipeline rebuild — ffmpeg respawns and the buffer refills from
 * empty — so the change reliably makes the `<video>` fire `waiting` once or
 * twice all by itself. Without a cooldown those self-inflicted stalls satisfy
 * the downshift rule immediately, and a single bad burst walks the ladder
 * straight to the floor two rungs at a time, each step manufacturing the
 * evidence for the next.
 */
export const CHANGE_COOLDOWN_MS = 10_000;

/**
 * `auto` walks the ladder; a number pins it and disables the policy entirely.
 * Pinning is a real user choice, not a debug affordance: an editor on a known
 * connection reviewing fine detail would rather hold 1080 and wait.
 */
export type RungPreference = "auto" | RungHeight;

export type RungState = {
  /** The rung currently being streamed. */
  current: RungHeight;
  pref: RungPreference;
  /**
   * Highest rung `auto` may select. Normally 1080; forced to the lowest rung
   * when the QUIC path is relayed, because that traffic crosses n0's public
   * infrastructure rather than a direct link between the two Macs. See R6 in
   * the plan: kilobytes of control traffic through a relay was an accepted
   * cost, megabits of someone's media is a different bargain.
   */
  ceiling: RungHeight;
  /** Times of recent stalls, oldest first, pruned to the downshift window. */
  stalls: number[];
  /** When the stream last became clean (start, or the last stall/change). */
  cleanSince: number;
  /** Whether the last automatic change was an upshift, which raises the bar. */
  lastChangeWasUpshift: boolean;
  /** When the rung last changed, so a rebuild's own stalls can be discounted. */
  lastChangeAt: number;
};

export function initialRungState(
  now: number,
  pref: RungPreference = "auto",
  ceiling: RungHeight = RUNG_HEIGHTS[0],
): RungState {
  const start = pref === "auto" ? clampToCeiling(DEFAULT_RUNG, ceiling) : clampToCeiling(pref, ceiling);
  return {
    current: start, pref, ceiling, stalls: [],
    cleanSince: now, lastChangeWasUpshift: false, lastChangeAt: now,
  };
}

function indexOf(h: RungHeight): number {
  return RUNGS.findIndex((r) => r.height === h);
}

/** Ladder order is widest-first, so "worse" means a HIGHER index. */
function clampToCeiling(h: RungHeight, ceiling: RungHeight): RungHeight {
  return indexOf(h) < indexOf(ceiling) ? ceiling : h;
}

export type RungEvent =
  /** The `<video>` fired `waiting` — it ran out of buffered media. */
  | { t: "stall"; at: number }
  /** Periodic poll; the only thing that can trigger an upshift. */
  | { t: "tick"; at: number }
  /** The user changed the Settings selector. */
  | { t: "prefer"; pref: RungPreference; at: number }
  /** The transport told us whether the path is direct or relayed. */
  | { t: "path"; relayed: boolean; at: number };

/**
 * Advance the state machine. Returns a NEW state; compare `current` with the
 * old one to decide whether to rebuild the pipeline.
 */
export function reduceRung(s: RungState, e: RungEvent): RungState {
  switch (e.t) {
    case "prefer": {
      const next = e.pref === "auto"
        // Returning to auto restarts from the default rather than from
        // wherever the user had pinned it. A pinned 1080 that failed is not
        // evidence about the network; a fresh probe is.
        ? clampToCeiling(DEFAULT_RUNG, s.ceiling)
        : clampToCeiling(e.pref, s.ceiling);
      return {
        ...s, pref: e.pref, current: next, stalls: [],
        cleanSince: e.at, lastChangeWasUpshift: false, lastChangeAt: e.at,
      };
    }

    case "path": {
      const ceiling = e.relayed ? LOWEST_RUNG : RUNG_HEIGHTS[0];
      if (ceiling === s.ceiling) return s;
      // A late hole-punch can turn a relayed path direct mid-session, so this
      // raises the ceiling as well as lowering it. Raising does NOT jump the
      // current rung — it only permits the normal upshift policy to climb,
      // which keeps one rebuild-per-decision.
      const current = clampToCeiling(s.current, ceiling);
      return {
        ...s, ceiling, current, cleanSince: e.at, stalls: [],
        lastChangeAt: current === s.current ? s.lastChangeAt : e.at,
      };
    }

    case "stall": {
      if (s.pref !== "auto") return s; // pinned means pinned
      // Discount a stall the last rebuild almost certainly caused. The clean
      // clock still resets, so this delays an upshift; it just does not count
      // as evidence against the rung we only just switched to.
      if (e.at - s.lastChangeAt < CHANGE_COOLDOWN_MS) {
        return { ...s, cleanSince: e.at };
      }
      const stalls = [...s.stalls, e.at].filter((t) => e.at - t <= DOWNSHIFT_WINDOW_MS);
      if (stalls.length < DOWNSHIFT_STALLS) {
        return { ...s, stalls, cleanSince: e.at };
      }
      const i = indexOf(s.current);
      if (i >= RUNGS.length - 1) {
        // Already at the bottom. Keep the clean clock reset so we do not
        // immediately try to climb out of a network that is still failing.
        return { ...s, stalls: [], cleanSince: e.at, lastChangeWasUpshift: false };
      }
      return {
        ...s,
        current: RUNGS[i + 1].height,
        stalls: [],
        cleanSince: e.at,
        lastChangeWasUpshift: false,
        lastChangeAt: e.at,
      };
    }

    case "tick": {
      if (s.pref !== "auto") return s;
      const i = indexOf(s.current);
      if (i <= indexOf(s.ceiling)) return s; // at the ceiling, nothing to gain
      const needed = s.lastChangeWasUpshift ? UPSHIFT_REPEAT_CLEAN_MS : UPSHIFT_CLEAN_MS;
      if (e.at - s.cleanSince < needed) return s;
      // Prune here as well as on `stall`. Stalls only ever expired when a NEW
      // stall arrived, so a single stall on an otherwise healthy connection
      // sat in the array forever and blocked every future upshift — the rung
      // could fall but never climb back.
      const stalls = s.stalls.filter((t) => e.at - t <= DOWNSHIFT_WINDOW_MS);
      if (stalls.length > 0) return { ...s, stalls };
      return {
        ...s,
        stalls,
        current: RUNGS[i - 1].height,
        cleanSince: e.at,
        lastChangeWasUpshift: true,
        lastChangeAt: e.at,
      };
    }
  }
}

/** True when the pipeline has to be rebuilt for the new rung to take effect. */
export function needsRebuild(before: RungState, after: RungState): boolean {
  return before.current !== after.current;
}

/**
 * What to show the user. Empty string when there is nothing worth saying —
 * a badge that is always present stops being read.
 */
export function rungBadge(s: RungState): string {
  if (s.ceiling === LOWEST_RUNG) return `${s.current}p · relayed`;
  if (s.pref !== "auto") return `${s.current}p`;
  return s.current === DEFAULT_RUNG ? "" : `${s.current}p`;
}
