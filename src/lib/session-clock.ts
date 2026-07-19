/**
 * Cross-machine clock offset for co-review transport sync (r124).
 *
 * The transport heartbeat carries the sender's `Date.now()`, and the receiver
 * extrapolates the playhead with its OWN `Date.now()`. Two Macs are never
 * exactly aligned - a 2 second offset is ordinary, and Date.now() is wall
 * clock, so it jumps on NTP correction. Untreated, that offset is a constant
 * error that permanently exceeds the chase tolerance: the guest re-seeks on
 * every heartbeat, and on the web path every seek rebuilds the ffmpeg stream.
 *
 * The estimator is deliberately simple and needs no extra messages: it tracks
 * the running MINIMUM of (receivedAt - sentAt) over a short window. Network
 * delay is one-sided and always positive, so the minimum of that difference
 * converges on the true offset - the sample that happened to travel fastest
 * is the least polluted. (This is the NTP insight, minus the round trip.)
 *
 * Until enough samples land we report `null` and callers apply NO correction,
 * because a wrong offset is worse than none: the existing just-loaded snap
 * already covers the opening moments.
 */

/** Samples needed before the offset is trustworthy. */
const MIN_SAMPLES = 4;
/** Ring size - a few seconds of 2 Hz heartbeats. */
const WINDOW = 20;

export type ClockEstimator = {
  /** Feed one heartbeat. Both stamps in ms. */
  sample: (sentAtMs: number, receivedAtMs: number) => void;
  /** Best estimate of (receiver clock - sender clock), or null if unknown. */
  offsetMs: () => number | null;
  /** Forget everything (session start, presenter change - a different clock). */
  reset: () => void;
};

export function createClockEstimator(): ClockEstimator {
  let samples: number[] = [];
  return {
    sample(sentAtMs, receivedAtMs) {
      if (!Number.isFinite(sentAtMs) || !Number.isFinite(receivedAtMs)) return;
      samples.push(receivedAtMs - sentAtMs);
      if (samples.length > WINDOW) samples = samples.slice(-WINDOW);
    },
    offsetMs() {
      if (samples.length < MIN_SAMPLES) return null;
      return Math.min(...samples);
    },
    reset() {
      samples = [];
    },
  };
}

/**
 * Where the presenter's playhead is NOW, in seconds, from one heartbeat.
 *
 * `offsetMs` is the estimator's output; null means "not yet known", in which
 * case we do not extrapolate elapsed time at all and simply trust the reported
 * position. That is the conservative choice: better a slightly stale position
 * than one skewed by an unmeasured clock difference.
 */
export function expectedPosition(
  msg: { position: number; playing: boolean; rate: number; atMs: number },
  nowMs: number,
  offsetMs: number | null,
): number {
  if (!msg.playing) return msg.position;
  if (offsetMs == null) return msg.position;
  // Translate the sender's stamp into OUR clock before differencing.
  const elapsedMs = Math.max(0, nowMs - (msg.atMs + offsetMs));
  return msg.position + (elapsedMs / 1000) * (msg.rate || 1);
}
