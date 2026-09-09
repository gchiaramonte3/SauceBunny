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

export function presentationCanPlay(state: PlaybackReadiness | undefined, target: number, fps: number): boolean {
  if (!state || state.failed || state.seeking || !state.hasFutureData
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
