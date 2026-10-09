import { playersOf, segmentLength, segmentStarts, type Layering, type Timeline, type TimelineMute } from "./edit-model";

/**
 * Strip Silence, to Media Composer's spec: on the selected tracks, between In
 * and Out (or over the whole cut), every stretch quieter than the Threshold
 * for at least the Minimum duration goes silent, with Pad Start and Pad End
 * of air kept around the sound on either side. Nothing moves: Avid leaves
 * filler on those tracks only, and so does this, as a track mute (Silence),
 * which the AAF writes as filler on that track.
 *
 * Avid strips on level alone. Bleed means a quiet line can sit under the
 * threshold on its own mic, so by default a transcribed word is never
 * stripped (String Outs never cuts through someone's words by default); the
 * option turns that off for Avid's exact behaviour.
 */
export type StripSilenceOptions = {
  /** dBFS; peaks below this are silence. */
  thresholdDb: number;
  /** Seconds a quiet stretch must last to count. */
  minimum: number;
  /** Seconds of air kept before the sound that ends a silence. */
  padStart: number;
  /** Seconds of air kept after the sound that starts a silence. */
  padEnd: number;
  keepWords: boolean;
};

export const stripSilenceDefaults: StripSilenceOptions = { thresholdDb: -40, minimum: 0.5, padStart: 0.1, padEnd: 0.2, keepWords: true };

/** Where to measure: a lane's mic over a stretch of one source, in source seconds. */
export type StripTarget = { source: string; lane: string; from: number; to: number };
/** A mic's levels over a target: min/max peak pairs spread evenly from `from` to `to`. */
export type LevelWindow = StripTarget & { peaks: [number, number][] };

const EPSILON = 1e-6;
/** Pieces shorter than this, left between two words, are not worth a mute. */
const SLIVER = 0.04;

/**
 * Every source stretch the cut plays on the selected RECORD TRACKS, inside
 * program time `from` to `to`: whoever is on each track there, from whatever
 * they play (an overwrite's material included), merged per source and person
 * so a source range used twice is measured once. It used to take everyone who
 * was ever on a selected track and strip them everywhere, so stripping A1
 * reached the same person's lines on A3, and it never measured an overwrite.
 */
export function stripTargets(edit: Timeline, from: number, to: number, layers: readonly number[], layering: Layering): StripTarget[] {
  const starts = segmentStarts(edit), found = new Map<string, StripTarget[]>(), chosen = new Set(layers);
  edit.segments.forEach((segment, index) => {
    const start = Math.max(from, starts[index]), end = Math.min(to, starts[index] + segmentLength(segment));
    if (end - start <= EPSILON) return;
    for (const { lane, layer, play } of playersOf(segment, layering)) {
      if (!chosen.has(layer)) continue;
      const key = `${play.source}\n${lane}`, list = found.get(key) ?? [];
      list.push({ source: play.source, lane, from: play.srcIn + start - starts[index], to: play.srcIn + end - starts[index] });
      found.set(key, list);
    }
  });
  return [...found.values()].flatMap((list) => merge(list.map((item) => [item.from, item.to] as [number, number]))
    .map(([a, b]) => ({ source: list[0].source, lane: list[0].lane, from: a, to: b })));
}

/**
 * The quiet stretches of one target, from its levels read in consecutive
 * windows (a silence may run across the seam between two), padded, with the
 * lane's words kept when asked. Source seconds.
 */
export function silentStretches(windows: LevelWindow[], words: { start: number; end: number }[], options: StripSilenceOptions): [number, number][] {
  const buckets = windows.flatMap((window) => {
    const step = (window.to - window.from) / Math.max(1, window.peaks.length);
    return window.peaks.map(([low, high], index) => {
      const peak = Math.max(Math.abs(low), Math.abs(high));
      return { from: window.from + index * step, to: window.from + (index + 1) * step, quiet: peak <= 0 || 20 * Math.log10(peak) < options.thresholdDb };
    });
  });
  const out: [number, number][] = [], count = buckets.length;
  for (let index = 0; index < count;) {
    if (!buckets[index].quiet) { index += 1; continue; }
    let end = index;
    while (end < count && buckets[end].quiet) end += 1;
    const a = buckets[index].from, b = buckets[end - 1].to;
    if (b - a >= options.minimum - EPSILON) {
      // Air is kept only beside sound; at the target's own edge there is none to keep.
      const from = index > 0 ? a + options.padEnd : a, to = end < count ? b - options.padStart : b;
      if (to - from > EPSILON) out.push([from, to]);
    }
    index = end;
  }
  return options.keepWords ? subtract(out, words.map((word) => [word.start, word.end] as [number, number])) : out;
}

/** The cut with every stretch silenced on its lane, merged with what was already silenced there. */
export function stripMutes(edit: Timeline, stretches: (StripTarget)[]): Timeline {
  if (!stretches.length) return edit;
  const groups = new Map<string, TimelineMute[]>();
  for (const mute of [...edit.mutes, ...stretches.map((item) => ({ source: item.source, track: item.lane, srcIn: item.from, srcOut: item.to }))]) {
    const key = `${mute.source}\n${mute.track}`;
    groups.set(key, [...(groups.get(key) ?? []), mute]);
  }
  const mutes = [...groups.values()].flatMap((list) => merge(list.map((mute) => [mute.srcIn, mute.srcOut] as [number, number]))
    .map(([srcIn, srcOut]) => ({ source: list[0].source, track: list[0].track, srcIn, srcOut })));
  return { ...edit, mutes };
}

function merge(spans: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + EPSILON) last[1] = Math.max(last[1], b); else out.push([a, b]);
  }
  return out;
}

function subtract(spans: [number, number][], holes: [number, number][]): [number, number][] {
  const cuts = merge(holes);
  return spans.flatMap(([a, b]) => {
    const pieces: [number, number][] = [];
    let at = a;
    for (const [x, y] of cuts) {
      if (y <= at || x >= b) continue;
      if (x - at > SLIVER) pieces.push([at, x]);
      at = Math.max(at, y);
    }
    if (b - at > SLIVER) pieces.push([at, b]);
    return pieces;
  });
}
