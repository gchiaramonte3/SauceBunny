/**
 * Audio scrubbing — the grain policy.
 *
 * Scrubbing with sound is not "unmute the video while seeking". Dragging a
 * playhead asks for audio at an arbitrary rate, sometimes zero, sometimes
 * backwards, and the two naive answers both sound bad:
 *
 *  - **Varispeed** (let the element play at drag speed) is the tape sound.
 *    It pitches up with the drag, so at any useful shuttle rate speech turns
 *    into a screech and you cannot tell one word from another - which is the
 *    entire reason someone scrubs audio.
 *  - **Seek-and-play** stutters: HTMLMediaElement seek latency is tens of
 *    milliseconds and jittery, so grains land unevenly and the result flams.
 *
 * What editors actually ship (Pro Tools shuttle, Premiere, Resolve) is
 * GRANULAR: play short overlapping excerpts taken at the playhead, windowed
 * so the joins are silent, at constant pitch. This module is that policy, and
 * only the policy - no Web Audio, no decoding, so the decisions are testable
 * on their own. `use-audio-scrub` owns the machinery.
 *
 * The numbers, and why they are these numbers:
 *
 *  - **55 ms grains.** Under ~15 ms the ear stops hearing a grain as timbre
 *    and starts hearing the repetition rate as PITCH, which is the metallic
 *    buzz cheap scrubbers make. Over ~120 ms each grain outlives the gesture
 *    that asked for it and the scrub feels laggy and smeared. A syllable
 *    nucleus runs ~80-150 ms, so 55 ms carries enough vowel colour to
 *    recognise a word while still tracking the hand.
 *  - **8 ms raised-cosine fades.** A grain boundary is a step discontinuity,
 *    and a step is a click. 8 ms is well under the ~20 ms where a fade starts
 *    being audible AS a fade, and long enough to remove the edge.
 *  - **32 ms minimum spacing.** Shorter than the grain (55 ms), so successive
 *    grains OVERLAP and a moving playhead never produces a gap. It also caps
 *    the rate: without it a fast drag schedules hundreds of voices, which is
 *    both mud and a level pile-up.
 *  - **10 ms minimum movement.** A stationary playhead must go SILENT rather
 *    than repeat its grain forever. Looping one excerpt is the stuck-record
 *    sound, and it is the single thing that makes scrub audio intolerable to
 *    leave switched on.
 *  - **Gain falls as 1/sqrt(voices).** Overlapping grains sum, so a fast drag
 *    would otherwise be much louder than a slow one. Power-summing keeps
 *    perceived loudness roughly flat across shuttle speeds.
 *  - **Never reverse the samples.** Dragging backwards steps the grain
 *    POSITIONS backwards and plays each one forwards. Reversed speech is
 *    unintelligible, so tape-style reversal actively defeats the task.
 */

/** Core grain length, seconds. */
export const GRAIN_CORE_SEC = 0.055;
/** Fade in/out at each end, seconds. */
export const GRAIN_FADE_SEC = 0.008;
/** Never fire two grains closer together than this, milliseconds. */
export const GRAIN_MIN_INTERVAL_MS = 32;
/** A playhead that moved less than this is standing still, seconds. */
export const GRAIN_MIN_MOVE_SEC = 0.010;
/** Hard ceiling on simultaneous grains. Past this it is mud, not detail. */
export const GRAIN_MAX_VOICES = 6;

export type ScrubGrainState = {
  /** Monotonic clock reading when the last grain was scheduled. */
  lastFiredAtMs: number | null;
  /** Source position the last grain was taken from, seconds. */
  lastSourceSec: number | null;
};

export type GrainPlan = {
  /** Where in the source to read, seconds. Never negative. */
  offsetSec: number;
  /** How much to read, seconds, fades included. */
  durationSec: number;
  /** Length of each raised-cosine edge, seconds. */
  fadeSec: number;
  /** Peak gain for this grain, 0..1. */
  gain: number;
};

export const idleScrubState = (): ScrubGrainState => ({ lastFiredAtMs: null, lastSourceSec: null });

/**
 * Decide whether to sound a grain for a playhead now at `sourceSec`, and if
 * so, which excerpt at what level. Returns null to stay silent — which is a
 * real answer, not a failure: a still playhead SHOULD make no sound.
 *
 * `durationSec` is clamped against `mediaDurationSec` so the last grain of a
 * file cannot ask for samples past the end.
 */
export function planGrain(
  state: ScrubGrainState,
  nowMs: number,
  sourceSec: number,
  mediaDurationSec: number,
): GrainPlan | null {
  if (!Number.isFinite(sourceSec) || sourceSec < 0) return null;
  if (!Number.isFinite(mediaDurationSec) || mediaDurationSec <= 0) return null;

  const sinceMs = state.lastFiredAtMs == null ? Infinity : nowMs - state.lastFiredAtMs;
  // A clock that went backwards (or did not move) must not be read as "ages
  // ago" and open the gate; treat it as no time passed.
  if (sinceMs < GRAIN_MIN_INTERVAL_MS) return null;

  const moved = state.lastSourceSec == null ? Infinity : Math.abs(sourceSec - state.lastSourceSec);
  if (moved < GRAIN_MIN_MOVE_SEC) return null;

  // Centre the excerpt ON the playhead. Reading forward from it instead would
  // sound the audio that FOLLOWS the frame under the cursor, which is
  // consistently half a grain late against the picture.
  const half = GRAIN_CORE_SEC / 2;
  const offsetSec = Math.max(0, Math.min(sourceSec - half, mediaDurationSec - GRAIN_CORE_SEC));
  const durationSec = Math.max(0, Math.min(GRAIN_CORE_SEC, mediaDurationSec - offsetSec));
  if (durationSec <= 0) return null;

  // How many grains are sounding at once at this spacing.
  const spacingMs = Math.min(sinceMs, 1000);
  const voices = Math.max(1, Math.min(GRAIN_MAX_VOICES, GRAIN_CORE_SEC * 1000 / spacingMs));
  const gain = 1 / Math.sqrt(voices);

  return {
    offsetSec,
    durationSec,
    // A grain shorter than two fades would never reach full level; give it
    // symmetric edges that fit instead.
    fadeSec: Math.min(GRAIN_FADE_SEC, durationSec / 2),
    gain,
  };
}

/**
 * The WHOLE grain envelope as one curve: raised-cosine up, hold, raised-
 * cosine down. A linear ramp is audible as an edge of its own on excerpts
 * this short, which is why the edges are shaped at all.
 *
 * One curve rather than three automation events, and that is a correctness
 * requirement, not tidiness. setValueCurveAtTime throws NotSupportedError if
 * ANY automation event falls within its range, endpoints included - so a
 * setValueAtTime sitting exactly on a curve's start (the obvious way to
 * write this) throws, the exception escapes the scheduling path, and scrub
 * audio is silent with nothing in the log to say why.
 */
export const grainEnvelope = (peak: number, durationSec: number, fadeSec: number): Float32Array => {
  const n = 128, a = new Float32Array(n);
  const fade = durationSec > 0 ? Math.min(0.5, fadeSec / durationSec) : 0;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const w = fade <= 0 ? 1
      : t < fade ? 0.5 - 0.5 * Math.cos(Math.PI * (t / fade))
      : t > 1 - fade ? 0.5 - 0.5 * Math.cos(Math.PI * ((1 - t) / fade))
      : 1;
    a[i] = w * peak;
  }
  return a;
};
