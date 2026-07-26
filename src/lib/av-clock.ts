// The A/V clock decisions MediaBunnyPlayer makes, as pure functions.
//
// Why they live here: the player owns its own master clock (AudioContext
// time), and every bug in that clock is silent — a perfect picture with no
// sound, or a playhead that drifts from what you hear. Those are exactly the
// bugs a rendered-component test would not catch anyway, because they are
// arithmetic about arrival times. Pulling the arithmetic out means it can be
// pinned to the scenario that produced it (see av-clock.test.ts) instead of
// re-derived by hand after each regression.

/** Inputs for the one legitimate mid-generation re-anchor. */
export type AnchorRetakeInput = {
  /** Is this the FIRST audio buffer delivered for this generation? */
  firstOfGeneration: boolean;
  /** Audio nodes already scheduled this generation (0 = nothing heard yet). */
  scheduledCount: number;
  /** Context time this chunk would be scheduled at under the current anchor. */
  wouldLandAt: number;
  /** Length of the chunk in seconds. */
  chunkDuration: number;
  /** AudioContext.currentTime right now. */
  now: number;
};

/**
 * Should the audio loop TAKE BACK the clock anchor?
 *
 * The failure this exists for: audio is the master clock, but the video loop
 * anchors on a deadline so a dead audio track cannot freeze the picture. A
 * custom WASM decoder (Opus) pays a one-time instantiate on its first decode,
 * and when that cost exceeds the deadline the video loop anchors first. The
 * clock has then already run past the audio being handed over, so every chunk
 * is judged late, every chunk is dropped, and the file plays SILENTLY behind a
 * perfect picture.
 *
 * Re-anchoring is normally forbidden — it rewinds the master clock every
 * consumer reads. It is safe in exactly this window: the first buffer of a
 * generation, with nothing scheduled and therefore nothing heard, so the only
 * thing that moves is the picture.
 *
 * A chunk that is merely LATE (an ordinary decode hiccup mid-playback) must
 * still be dropped, not re-anchored — that is what keeps playback in sync
 * after a stall. So the retake requires the chunk to be *entirely* in the
 * past: its whole duration has already elapsed under the current anchor.
 */
export function shouldRetakeAnchor(i: AnchorRetakeInput): boolean {
  if (!i.firstOfGeneration) return false;
  if (i.scheduledCount > 0) return false; // audio has already been heard
  return i.wouldLandAt + i.chunkDuration <= i.now;
}

/**
 * How long the video loop waits for audio to anchor before taking the clock
 * itself, in milliseconds.
 *
 * Warm: the decoder has already produced a buffer for this source, so the
 * next one is milliseconds away and a short wait keeps the picture snappy.
 * Cold: the decoder has never run for this source and may be instantiating a
 * WASM module; cutting the wait short here is precisely what hands the anchor
 * to video and silences the file. The cold wait is generous because the cost
 * is paid once per source and only when audio has not been primed.
 */
export function audioAnchorWaitMs(audioDecoderWarm: boolean): number {
  return audioDecoderWarm ? 500 : 3000;
}
