import type { PlaybackReadiness } from "../components/player-handle";

/** Never count media on the far side of a gap as playable headroom. */
export function contiguousBufferAhead(ranges: TimeRanges, position: number): number {
  for (let i = 0; i < ranges.length; i++) {
    if (position >= ranges.start(i) && position <= ranges.end(i)) {
      return Math.max(0, ranges.end(i) - position);
    }
  }
  return 0;
}

export function contiguousRange(ranges: TimeRanges, position: number): [number, number] | undefined {
  for (let i = 0; i < ranges.length; i++) {
    if (position >= ranges.start(i) && position <= ranges.end(i)) return [ranges.start(i), ranges.end(i)];
  }
}

/** WebKit exposes parsed audio tracks; advertised codecs alone are not proof.
 * A browser without this observation conservatively keeps the local copy. */
export function observedRequiredAudio(el: HTMLMediaElement | null, required: boolean): boolean {
  if (!required) return true;
  const tracks = (el as (HTMLMediaElement & { audioTracks?: { length: number } }) | null)?.audioTracks;
  return !!tracks && tracks.length > 0;
}

export type DecodedObservation = { generation: number; seconds: number; sampledAtMs: number; advancingFrames: number };
export function observeDecodedFrame(previous: DecodedObservation | null, generation: number, seconds: number, now: number): DecodedObservation {
  return { generation, seconds, sampledAtMs: now, advancingFrames:
    previous?.generation === generation && seconds > previous.seconds && now >= previous.sampledAtMs && now - previous.sampledAtMs < 250
      ? previous.advancingFrames + 1 : 0 };
}

/** Running promotion is stricter than showing a parked replacement frame. */
export function presentationCanSwitch(state: PlaybackReadiness | undefined, target: number, fps: number, now: number): boolean {
  if (!state || state.failed || state.seeking || !state.hasFutureData || state.hasRequiredTracks === false || state.confirmedSeconds == null
    || state.sampledAtMs == null || now < state.sampledAtMs || now - state.sampledAtMs > 250
    || (state.advancingFrames ?? 0) < 2 || !Number.isFinite(target)) return false;
  const remaining = state.durationSeconds - target;
  const frequency = Number.isFinite(fps) && fps > 0 ? fps : 30;
  return Number.isFinite(remaining) && remaining > 0 && Math.abs(state.confirmedSeconds - target) <= 1 / frequency
    && state.bufferedAheadSeconds >= Math.min(5, remaining);
}

export function presentationCanPlay(state: PlaybackReadiness | undefined, target: number, fps: number): boolean {
  if (!state || state.failed || state.seeking || !state.hasFutureData || state.hasRequiredTracks === false
    || state.confirmedSeconds === null || !Number.isFinite(target)) return false;
  if (!sameSourceFrame(state.confirmedSeconds, target, fps)) return false;
  const remaining = state.durationSeconds > 0 ? Math.max(0, state.durationSeconds - target) : 2;
  return remaining > 0 && state.bufferedAheadSeconds >= Math.min(2, remaining) - 0.001;
}

/** Compare frame identities, not a one-frame distance (which admits a neighbour). */
export function sameSourceFrame(a: number, b: number, fps: number): boolean {
  const frequency = Number.isFinite(fps) && fps > 0 ? fps : 30;
  return Number.isFinite(a) && Number.isFinite(b)
    && Math.floor(a * frequency + 0.001) === Math.floor(b * frequency + 0.001);
}
