import { describe, expect, it } from "vitest";
import { deadDefaults, findDeadSpace, GAP, isGap, lanePlay, placeWords, seamList, segmentLength, segmentStarts, type DeadSpace, type PlacedWord, type Timeline, type TimelineSegment, type TimelineWord } from "./edit-model";

/**
 * placeWords, seamList and findDeadSpace look words up by source range
 * instead of scanning every word. These are the scans they replaced, kept as
 * the reference: on random edits with overrides, lifts, lane-only clips, gaps
 * and mutes, each must give exactly what its scan gave.
 */
function reference(words: TimelineWord[], edit: Timeline): PlacedWord[] {
  const starts = segmentStarts(edit), placed: PlacedWord[] = [];
  const cutFor = (segment: TimelineSegment, lane: string) => !segment.tracks || segment.tracks.includes(lane);
  const isMuted = (word: TimelineWord) => edit.mutes.some((mute) => mute.source === word.source && mute.track === word.track && word.start >= mute.srcIn - 1e-6 && word.end <= mute.srcOut + 1e-6);
  const carriesOn = (index: number, lane: string) => {
    if (index <= 0 || index >= edit.segments.length) return false;
    const before = lanePlay(edit.segments[index - 1], lane), after = lanePlay(edit.segments[index], lane);
    return !!before && !!after && before.source === after.source && Math.abs(after.srcIn - before.srcOut) < 1e-6;
  };
  const runOf = (index: number, lane: string): [number, number] => {
    let first = index, last = index;
    while (carriesOn(first, lane)) first--;
    while (carriesOn(last + 1, lane)) last++;
    return [first, last];
  };
  edit.segments.forEach((segment, index) => {
    const length = segmentLength(segment);
    const inside = (word: TimelineWord, source: string, from: number) => { const middle = (word.start + word.end) / 2; return word.source === source && middle >= from && middle < from + length; };
    const place = (word: TimelineWord, srcIn: number, voice: string | null, silenced: boolean) => {
      const offset = starts[index] - srcIn, [first, last] = silenced ? [index, index] : runOf(index, word.track);
      placed.push({ word, segment: index, voice, offset, clip: first, programStart: Math.max(starts[first], word.start + offset),
        programEnd: Math.min(starts[last] + segmentLength(edit.segments[last]), word.end + offset), muted: silenced || isMuted(word) });
    };
    for (const word of words) {
      const over = segment.overrides?.[word.track];
      if (over) {
        if (over.source != null) { if (inside(word, over.source, over.srcIn)) place(word, over.srcIn, word.track, false); }
        else if (!isGap(segment) && cutFor(segment, word.track) && inside(word, segment.source, segment.srcIn)) place(word, segment.srcIn, null, true);
        continue;
      }
      if (isGap(segment) || !cutFor(segment, word.track) || !inside(word, segment.source, segment.srcIn)) continue;
      place(word, segment.srcIn, null, false);
    }
  });
  return placed.sort((a, b) => a.programStart - b.programStart || a.word.start - b.word.start);
}

function referenceDead(edit: Timeline, words: TimelineWord[], loudest: (source: string, from: number, to: number) => number, options = deadDefaults): DeadSpace[] {
  const starts = segmentStarts(edit), found: DeadSpace[] = [];
  const push = (from: number, to: number, gap: boolean) => {
    const last = found[found.length - 1];
    if (last && Math.abs(last.to - from) < 1e-6) { last.to = to; last.gap = last.gap && gap; } else found.push({ from, to, gap });
  };
  edit.segments.forEach((segment, index) => {
    const at = starts[index];
    if (isGap(segment)) return push(at, at + segmentLength(segment), true);
    const heard = [{ source: segment.source, srcIn: segment.srcIn },
      ...Object.values(segment.overrides ?? {}).flatMap((over) => over.source == null ? [] : [{ source: over.source, srcIn: over.srcIn }])];
    const spoken = heard.map((span) => words.filter((word) => word.source === span.source && word.end + options.pad > span.srcIn && word.start - options.pad < span.srcIn + segmentLength(segment)));
    let quietFrom: number | null = null;
    for (let t = segment.srcIn; t < segment.srcOut - 1e-9; t += options.step) {
      const until = Math.min(segment.srcOut, t + options.step);
      const quiet = heard.every((span, which) => {
        const shift = span.srcIn - segment.srcIn, a = t + shift, b = until + shift;
        return !spoken[which].some((word) => word.start - options.pad < b && word.end + options.pad > a) && loudest(span.source, a, b) < options.threshold;
      });
      if (quiet && quietFrom == null) quietFrom = t;
      if (!quiet && quietFrom != null) { push(at + quietFrom - segment.srcIn, at + t - segment.srcIn, false); quietFrom = null; }
    }
    if (quietFrom != null) push(at + quietFrom - segment.srcIn, at + segmentLength(segment), false);
  });
  return found.filter((space) => space.gap || space.to - space.from >= options.minimum);
}

/** A small seeded generator, so a failure names the seed that made it. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
}

describe("placeWords against the scan it replaced", () => {
  it("places the same words in the same order on random edits", () => {
    const lanes = ["kara", "dev", "bob"], sources = ["s1", "s2"];
    let found = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const next = random(seed), pick = <T,>(list: T[]) => list[Math.floor(next() * list.length)];
      const at = (n: number) => Math.round(next() * n * 4) / 4;
      // Words on every lane, in both sources, a quarter-second grid so middles land on segment edges too.
      const words: TimelineWord[] = Array.from({ length: 40 }, (_, index) => {
        const start = at(60), end = start + 0.25 + at(1);
        return { id: `w${index}`, source: pick(sources), track: pick(lanes), text: `w${index}`, start, end };
      });
      const segments: TimelineSegment[] = Array.from({ length: 2 + Math.floor(next() * 8) }, (_, index) => {
        if (next() < 0.15) return { id: `g${index}`, source: GAP, srcIn: 0, srcOut: 0.5 + at(2) };
        const srcIn = at(55), segment: TimelineSegment = { id: `s${index}`, source: pick(sources), srcIn, srcOut: srcIn + 0.5 + at(8) };
        if (next() < 0.3) segment.tracks = lanes.filter(() => next() < 0.6);
        if (next() < 0.4) segment.overrides = Object.fromEntries(lanes.filter(() => next() < 0.4).map((lane) => [lane, next() < 0.3 ? { source: null } : { source: pick(sources), srcIn: at(50) }]));
        return segment;
      });
      // Contiguous runs too, so a lane carrying on across segments is exercised.
      if (segments.length > 2 && !isGap(segments[0]) && !isGap(segments[1])) segments[1] = { ...segments[1], source: segments[0].source, srcIn: segments[0].srcOut, srcOut: segments[0].srcOut + 2 };
      const mutes = Array.from({ length: Math.floor(next() * 4) }, () => { const srcIn = at(55); return { source: pick(sources), track: pick(lanes), srcIn, srcOut: srcIn + at(5) }; });
      const edit: Timeline = { segments, mutes };
      const expected = reference(words, edit);
      found += expected.length;
      expect(placeWords(words, edit), `seed ${seed}`).toEqual(expected);
      // Dead space: a level that is loud on some stretches, the same for both scans.
      const loudest = (source: string, from: number) => (Math.floor(from * 3) + source.length) % 5 === 0 ? 0.5 : 0.01;
      expect(findDeadSpace(edit, words, loudest), `seed ${seed}`).toEqual(referenceDead(edit, words, loudest));
      // Edit points: the lines a cut skipped, and the lanes whose words straddle each side.
      for (const seam of seamList(edit, words)) {
        const prev = edit.segments[seam.index - 1], next = edit.segments[seam.index];
        if (isGap(prev) || isGap(next)) continue;
        const straddles = new Set(words.filter((word) => (word.source === prev.source && word.start < prev.srcOut && word.end > prev.srcOut)
          || (word.source === next.source && word.start < next.srcIn && word.end > next.srcIn)).map((word) => word.track));
        expect(seam.clipped, `seed ${seed}`).toEqual(straddles);
        if (seam.kind === "cut") expect(seam.removed, `seed ${seed}`).toEqual(words.filter((word) => word.source === prev.source && (word.start + word.end) / 2 >= prev.srcOut
          && (word.start + word.end) / 2 < next.srcIn).sort((a, b) => a.start - b.start));
      }
    }
    // The generator places plenty, or the comparison proves nothing.
    expect(found).toBeGreaterThan(1000);
  });
});
