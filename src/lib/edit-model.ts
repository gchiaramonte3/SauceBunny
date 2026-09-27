/**
 * The Transcript Editor's edit model: the one place the text, the timeline,
 * playback and export agree on what an edit is. Ported from the design
 * catalog prototype (design-system/transcript-editor-model.ts), whose
 * behaviour was approved by hand; its tests came with it.
 *
 * One idea carries all of it. The EDIT is an ordered list of SEGMENTS, each a
 * range of one source's record time that plays on every track at once.
 * Program time is the running sum of segment lengths, so removing a range
 * closes up by construction: the timeline is magnetic because there is
 * nothing else it could be. A GAP is a segment too (source `GAP`): empty time
 * on every track, like Avid's filler. A MUTE silences one track over a source
 * range and never ripples, which is what keeps overtalk intact.
 *
 * Times here are seconds of source time, as the prototype's were. The saved
 * document (src/bindings/EditDocument.ts) is whole frames, and
 * edit-document.ts snaps every boundary to a frame on the way out: Avid cannot
 * express a subframe cut, so neither can a saved edit.
 */

export type TimelineWord = { id: string; source: string; track: string; text: string; start: number; end: number };
export type TimelineSegment = { id: string; source: string; srcIn: number; srcOut: number };
export type TimelineMute = { source: string; track: string; srcIn: number; srcOut: number };
export type Timeline = { segments: TimelineSegment[]; mutes: TimelineMute[] };

/** A word as it appears in the edit, with its place in program time. */
export type PlacedWord = {
  word: TimelineWord; segment: number; programStart: number; programEnd: number; muted: boolean;
};

/**
 * One appearance of a word in the edit. The same source word can be used
 * twice (a line spliced in again later), so a word id alone does not say
 * WHICH one the editor selected; the segment it plays in does.
 */
export const placementKey = (item: PlacedWord) => `${item.segment}:${item.word.id}`;

/**
 * A paragraph of the edit: one track's run of words, broken by a change of
 * track or a long pause. A cut does NOT break a paragraph: it is drawn
 * inline, between the two words it separates, the way a reader expects.
 */
export type TimelineParagraph = {
  id: string; track: string; words: PlacedWord[];
  /** True when an edit point sits right before this paragraph's first word. */
  cutBefore: boolean;
};

const PAUSE_BREAK = 1.2; // seconds of silence that starts a new paragraph
const HANDLE = 0.12;     // seconds of air kept around a cut, never into a neighbour

/** The source id of a gap segment. Its srcIn is 0 and srcOut its length. */
export const GAP = "gap";
export const isGap = (segment: TimelineSegment) => segment.source === GAP;

/** Segment ids persist in saved edits, so they are random, never a counter. */
const nextId = (prefix: string) => {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

export function segmentLength(segment: TimelineSegment) { return segment.srcOut - segment.srcIn; }

export function programDuration(edit: Timeline) {
  return edit.segments.reduce((sum, segment) => sum + segmentLength(segment), 0);
}

/** Program start of each segment. */
export function segmentStarts(edit: Timeline) {
  const starts: number[] = [];
  let at = 0;
  for (const segment of edit.segments) { starts.push(at); at += segmentLength(segment); }
  return starts;
}

/** Source position under a program position (clamped to the edit). */
export function programToSource(edit: Timeline, program: number): { segment: number; source: number } | null {
  let at = 0;
  for (const [index, segment] of edit.segments.entries()) {
    const length = segmentLength(segment);
    if (program < at + length || index === edit.segments.length - 1) {
      return { segment: index, source: Math.min(segment.srcOut, segment.srcIn + Math.max(0, program - at)) };
    }
    at += length;
  }
  return null;
}

const isMuted = (edit: Timeline, word: TimelineWord) => edit.mutes.some((mute) =>
  mute.source === word.source && mute.track === word.track && word.start >= mute.srcIn - 1e-6 && word.end <= mute.srcOut + 1e-6);

/** Words that play in the edit, in program order. A word belongs to a segment
 *  when its midpoint does; a later edit can never leave half a word showing. */
export function placeWords(words: TimelineWord[], edit: Timeline): PlacedWord[] {
  const starts = segmentStarts(edit);
  const placed: PlacedWord[] = [];
  edit.segments.forEach((segment, index) => {
    for (const word of words) {
      const middle = (word.start + word.end) / 2;
      if (word.source !== segment.source || middle < segment.srcIn || middle >= segment.srcOut) continue;
      const offset = starts[index] - segment.srcIn;
      placed.push({ word, segment: index, programStart: Math.max(starts[index], word.start + offset),
        programEnd: Math.min(starts[index] + segmentLength(segment), word.end + offset), muted: isMuted(edit, word) });
    }
  });
  return placed.sort((a, b) => a.programStart - b.programStart || a.word.start - b.word.start);
}

/** Paragraphs: a new one on a track change or a long pause (in program time). */
export function paragraphs(placed: PlacedWord[]): TimelineParagraph[] {
  const out: TimelineParagraph[] = [];
  let previous: PlacedWord | null = null;
  for (const item of placed) {
    const last = out[out.length - 1];
    const cut = !!previous && previous.segment !== item.segment;
    if (!last || last.track !== item.word.track || item.programStart - (previous?.programEnd ?? 0) > PAUSE_BREAK) {
      out.push({ id: `p-${placementKey(item)}`, track: item.word.track, words: [item], cutBefore: cut });
    } else last.words.push(item);
    previous = item;
  }
  return out;
}

/** Remove [srcIn, srcOut) of one source from every segment. What is left closes up. */
export function removeRange(edit: Timeline, source: string, srcIn: number, srcOut: number): Timeline {
  if (srcOut <= srcIn) return edit;
  const segments: TimelineSegment[] = [];
  for (const segment of edit.segments) {
    if (segment.source !== source || srcOut <= segment.srcIn || srcIn >= segment.srcOut) { segments.push(segment); continue; }
    if (srcIn > segment.srcIn) segments.push({ id: nextId("seg"), source, srcIn: segment.srcIn, srcOut: srcIn });
    if (srcOut < segment.srcOut) segments.push({ id: nextId("seg"), source, srcIn: srcOut, srcOut: segment.srcOut });
  }
  return { ...edit, segments };
}

/**
 * The source range a deletion takes: from just before the first selected word
 * to just after the last, keeping a little air but never reaching into the
 * words on either side (any track's), and never outside the segment.
 */
export function cutRange(words: TimelineWord[], selected: TimelineWord[], segment: TimelineSegment): [number, number] {
  const first = Math.min(...selected.map((word) => word.start));
  const last = Math.max(...selected.map((word) => word.end));
  const inside = words.filter((word) => word.source === segment.source && word.end > segment.srcIn && word.start < segment.srcOut && !selected.includes(word));
  const before = Math.max(segment.srcIn, ...inside.filter((word) => word.end <= first).map((word) => word.end));
  const after = Math.min(segment.srcOut, ...inside.filter((word) => word.start >= last).map((word) => word.start));
  const into = (gap: number) => Math.min(HANDLE, gap / 2);
  return [Math.max(segment.srcIn, first - into(first - before)), Math.min(segment.srcOut, last + into(after - last))];
}

/** Selected placements grouped into runs that are contiguous in the edit. */
function runs(placed: PlacedWord[], keys: Set<string>): PlacedWord[][] {
  const groups: PlacedWord[][] = [];
  let current: PlacedWord[] = [];
  for (const item of placed) {
    const chosen = keys.has(placementKey(item));
    if (chosen && (!current.length || current[0].segment === item.segment)) current.push(item);
    else if (chosen) { groups.push(current); current = [item]; }
    else if (current.length) { groups.push(current); current = []; }
  }
  if (current.length) groups.push(current);
  return groups;
}

export type DeleteResult = { edit: Timeline; removed: TimelineWord[]; crosstalk: TimelineWord[]; seconds: number };

/**
 * Delete selected words (by placement key) from the edit: a ripple on every
 * track. Anything any other track said in the same span goes too (it was on
 * their mic at that moment), and is reported so the editor can choose a
 * track-only removal instead.
 */
export function deleteWords(words: TimelineWord[], edit: Timeline, keys: Set<string>): DeleteResult {
  const placed = placeWords(words, edit);
  let seconds = 0;
  const removed: TimelineWord[] = [], crosstalk: TimelineWord[] = [];
  // Ranges per segment: only the appearance that was selected is cut, even
  // when the same source range plays somewhere else in the edit too.
  const cuts = new Map<number, [number, number][]>();
  for (const run of runs(placed, keys)) {
    const segment = run[0].segment;
    const [srcIn, srcOut] = cutRange(words, run.map((item) => item.word), edit.segments[segment]);
    cuts.set(segment, [...(cuts.get(segment) ?? []), [srcIn, srcOut]]);
    seconds += srcOut - srcIn;
    for (const item of placed) {
      const middle = (item.word.start + item.word.end) / 2;
      if (item.segment !== segment || middle < srcIn || middle >= srcOut) continue;
      (keys.has(placementKey(item)) ? removed : crosstalk).push(item.word);
    }
  }
  const segments = edit.segments.flatMap((segment, index) =>
    (cuts.get(index) ?? []).reduce((pieces, [srcIn, srcOut]) => removeRange({ segments: pieces, mutes: [] }, segment.source, srcIn, srcOut).segments, [segment]));
  return { edit: { ...edit, segments }, removed, crosstalk, seconds };
}

/** Silence only these words, on their track's track. No ripple. */
export function muteWords(words: TimelineWord[], edit: Timeline, ids: Set<string>): Timeline {
  const mutes = [...edit.mutes];
  for (const word of words) if (ids.has(word.id)) mutes.push({ source: word.source, track: word.track, srcIn: word.start, srcOut: word.end });
  return { ...edit, mutes };
}

/** Undo a track-only removal of these words. */
export function unmuteWords(words: TimelineWord[], edit: Timeline, ids: Set<string>): Timeline {
  const targets = words.filter((word) => ids.has(word.id));
  return { ...edit, mutes: edit.mutes.filter((mute) => !targets.some((word) =>
    word.source === mute.source && word.track === mute.track && word.start >= mute.srcIn - 1e-6 && word.end <= mute.srcOut + 1e-6)) };
}

/** Split the edit at a program position; returns the index to insert at. */
function splitAt(edit: Timeline, program: number): { edit: Timeline; index: number } {
  let at = 0;
  const segments: TimelineSegment[] = [];
  let index = edit.segments.length;
  for (const [position, segment] of edit.segments.entries()) {
    const length = segmentLength(segment);
    if (index === edit.segments.length && program <= at + 1e-6) index = segments.length;
    if (index === edit.segments.length && program > at + 1e-6 && program < at + length - 1e-6) {
      const cut = segment.srcIn + (program - at);
      segments.push({ id: nextId("seg"), source: segment.source, srcIn: segment.srcIn, srcOut: cut });
      index = segments.length;
      segments.push({ id: nextId("seg"), source: segment.source, srcIn: cut, srcOut: segment.srcOut });
    } else segments.push(segment);
    at += length;
    if (position === edit.segments.length - 1 && index === edit.segments.length && program >= at - 1e-6) index = segments.length;
  }
  return { edit: { ...edit, segments }, index };
}

/** Splice a source range into the edit at a program position (Avid's splice-in). */
export function spliceIn(edit: Timeline, source: string, srcIn: number, srcOut: number, program: number): Timeline {
  if (srcOut <= srcIn) return edit;
  const split = splitAt(edit, program);
  const segments = [...split.edit.segments];
  segments.splice(split.index, 0, { id: nextId("seg"), source, srcIn, srcOut });
  return { ...split.edit, segments };
}

/** Add Edit: cut every track at a program position and remove nothing. */
export function addEdit(edit: Timeline, program: number): Timeline {
  const split = splitAt(edit, program);
  return split.edit.segments.length === edit.segments.length ? edit : split.edit;
}

/**
 * Lift: take a program range out and leave a gap of the same length, so
 * nothing after it moves (Avid's Lift, FCP's Replace with Gap). The mirror of
 * extractProgram, which closes up.
 */
export function liftProgram(edit: Timeline, programIn: number, programOut: number): Timeline {
  if (programOut <= programIn) return edit;
  const first = splitAt(edit, programIn);
  const second = splitAt(first.edit, programOut);
  const segments = [...second.edit.segments];
  segments.splice(first.index, second.index - first.index, { id: nextId("gap"), source: GAP, srcIn: 0, srcOut: programOut - programIn });
  return { ...second.edit, segments: mergeGaps(segments) };
}

/**
 * Lift on some tracks only (Avid, with only those track selectors on): the
 * range goes silent on each selected track that has a mic in that source,
 * and nothing moves. A gap cannot do this, because a segment plays on every
 * track at once.
 */
export function liftOnTracks(edit: Timeline, programIn: number, programOut: number, tracksOf: (source: string) => string[]): Timeline {
  const mutes = [...edit.mutes];
  let at = 0;
  for (const segment of edit.segments) {
    const from = Math.max(programIn, at), to = Math.min(programOut, at + segmentLength(segment));
    if (to > from && !isGap(segment)) for (const track of tracksOf(segment.source)) mutes.push({ source: segment.source, track, srcIn: segment.srcIn + from - at, srcOut: segment.srcIn + to - at });
    at += segmentLength(segment);
  }
  return mutes.length === edit.mutes.length ? edit : { ...edit, mutes };
}

/** Mark Clip: the segment under a program position, as In and Out. */
export function clipAround(edit: Timeline, program: number): [number, number] | null {
  const starts = segmentStarts(edit);
  const index = edit.segments.findIndex((segment, i) => program >= starts[i] && program < starts[i] + segmentLength(segment));
  return index < 0 ? null : [starts[index], starts[index] + segmentLength(edit.segments[index])];
}

/** Neighbouring gaps become one, so a gap never shows a pointless edit point. */
function mergeGaps(segments: TimelineSegment[]): TimelineSegment[] {
  const out: TimelineSegment[] = [];
  for (const segment of segments) {
    const last = out[out.length - 1];
    if (last && isGap(last) && isGap(segment)) out[out.length - 1] = { ...last, srcOut: last.srcOut + segmentLength(segment) };
    else out.push(segment);
  }
  return out;
}

/** An empty stretch of this length at a program position (Insert Gap). */
export function insertGap(edit: Timeline, program: number, seconds: number): Timeline {
  if (seconds <= 0) return edit;
  const split = splitAt(edit, program);
  const segments = [...split.edit.segments];
  segments.splice(split.index, 0, { id: nextId("gap"), source: GAP, srcIn: 0, srcOut: seconds });
  return { ...split.edit, segments: mergeGaps(segments) };
}

/**
 * Dead space: stretches of program time where nobody is speaking. A stretch
 * counts only when BOTH say so: no word of the transcript falls in it (with
 * `pad` of air kept around every word), and every mic the source has stays
 * under `threshold`. A gap segment is dead space whole. The transcript alone
 * would take laughs, gasps and a door slam, which Whisper does not write
 * down; the waveform alone would take a quiet line, which bleed makes loud.
 */
export type DeadSpace = { from: number; to: number; gap: boolean };
export type DeadOptions = { threshold: number; minimum: number; pad: number; step: number };
export const deadDefaults: DeadOptions = { threshold: 0.12, minimum: 0.7, pad: 0.15, step: 0.05 };

export function findDeadSpace(edit: Timeline, words: TimelineWord[], loudest: (source: string, from: number, to: number) => number, options: DeadOptions = deadDefaults): DeadSpace[] {
  const starts = segmentStarts(edit);
  const found: DeadSpace[] = [];
  const push = (from: number, to: number, gap: boolean) => {
    const last = found[found.length - 1];
    if (last && Math.abs(last.to - from) < 1e-6) { last.to = to; last.gap = last.gap && gap; } else found.push({ from, to, gap });
  };
  edit.segments.forEach((segment, index) => {
    const at = starts[index];
    if (isGap(segment)) return push(at, at + segmentLength(segment), true);
    const spoken = words.filter((word) => word.source === segment.source && word.end + options.pad > segment.srcIn && word.start - options.pad < segment.srcOut);
    let quietFrom: number | null = null;
    for (let t = segment.srcIn; t < segment.srcOut - 1e-9; t += options.step) {
      const until = Math.min(segment.srcOut, t + options.step);
      const talking = spoken.some((word) => word.start - options.pad < until && word.end + options.pad > t);
      const quiet = !talking && loudest(segment.source, t, until) < options.threshold;
      if (quiet && quietFrom == null) quietFrom = t;
      if (!quiet && quietFrom != null) { push(at + quietFrom - segment.srcIn, at + t - segment.srcIn, false); quietFrom = null; }
    }
    if (quietFrom != null) push(at + quietFrom - segment.srcIn, at + segmentLength(segment), false);
  });
  return found.filter((space) => space.gap || space.to - space.from >= options.minimum);
}

/**
 * Take dead space out, leaving `keep` seconds of each stretch (split either
 * side, so the pause still breathes) and nothing of a gap. Later ranges
 * first, so earlier program positions stay valid.
 */
export function removeDeadSpace(edit: Timeline, spaces: DeadSpace[], keep: number): { edit: Timeline; seconds: number } {
  let next = edit, seconds = 0;
  for (const space of [...spaces].sort((a, b) => b.from - a.from)) {
    const leave = space.gap ? 0 : Math.min(keep, space.to - space.from);
    const from = space.from + leave / 2, to = space.to - leave / 2;
    if (to - from < 1e-6) continue;
    next = extractProgram(next, from, to).edit;
    seconds += to - from;
  }
  return { edit: { ...next, segments: mergeGaps(next.segments) }, seconds };
}

/** Take a program range out of the edit, returning the pieces that were in it. */
export function extractProgram(edit: Timeline, programIn: number, programOut: number): { edit: Timeline; pieces: TimelineSegment[] } {
  const first = splitAt(edit, programIn);
  const second = splitAt(first.edit, programOut);
  const pieces = second.edit.segments.slice(first.index, second.index);
  return { edit: { ...second.edit, segments: [...second.edit.segments.slice(0, first.index), ...second.edit.segments.slice(second.index)] }, pieces };
}

/** Program range a paragraph occupies, with the same air a deletion keeps. */
function paragraphSpan(placed: PlacedWord[], paragraph: TimelineParagraph): [number, number] {
  // By word id: the paragraph may come from an earlier placement of the same edit.
  const at = (item: PlacedWord) => placed.findIndex((other) => placementKey(other) === placementKey(item));
  const first = at(paragraph.words[0]), last = at(paragraph.words[paragraph.words.length - 1]);
  const start = placed[first].programStart, end = placed[last].programEnd;
  const before = first > 0 ? placed[first - 1].programEnd : 0;
  const after = last < placed.length - 1 ? placed[last + 1].programStart : Infinity;
  return [Math.max(before, start - Math.min(HANDLE, (start - before) / 2)), Math.min(after, end + Math.min(HANDLE, (after - end) / 2))];
}

/**
 * Move a paragraph to before another paragraph (or to the end). Its program
 * range travels as a unit on every track, cuts and all, like a clip on a
 * magnetic storyline.
 */
export function moveParagraph(words: TimelineWord[], edit: Timeline, paragraph: TimelineParagraph, before: TimelineParagraph | null): Timeline {
  const placed = placeWords(words, edit);
  const [programIn, programOut] = paragraphSpan(placed, paragraph);
  const taken = extractProgram(edit, programIn, programOut);
  let at = programDuration(taken.edit);
  if (before) {
    const rest = placeWords(words, taken.edit);
    const target = paragraphs(rest).find((item) => item.words[0].word.id === before.words[0].word.id);
    if (!target) return edit;
    at = paragraphSpan(rest, target)[0];
  }
  const split = splitAt(taken.edit, at);
  const segments = [...split.edit.segments];
  segments.splice(split.index, 0, ...taken.pieces);
  return { ...split.edit, segments };
}

/**
 * Restore a cut: join a segment to the one before it, bringing back whatever
 * the cut removed. Only a cut that went forward in the scene can be healed;
 * a moved paragraph jumps backwards and has nothing in between to restore.
 */
export function healSeam(edit: Timeline, index: number): Timeline {
  const prev = edit.segments[index - 1], next = edit.segments[index];
  if (!prev || !next || prev.source !== next.source || next.srcIn < prev.srcOut) return edit;
  const segments = [...edit.segments];
  segments.splice(index - 1, 2, { id: nextId("seg"), source: prev.source, srcIn: prev.srcIn, srcOut: next.srcOut });
  return { ...edit, segments };
}

/**
 * An edit point, and what KIND it is. A cut skips forward over source that
 * plays nowhere else, so it can be restored. A through edit skips nothing. A
 * jump goes somewhere the editor put there on purpose (a move or a splice):
 * the source it skips is still in the edit, so "restoring" it would play
 * those words twice. A gap edge is where a gap starts or ends.
 */
export type SeamKind = "cut" | "through" | "jump" | "gap";
/** `gap` is the source time the seam skips; NaN when the two sides are different sources. */
export type Seam = { index: number; at: number; gap: number; kind: SeamKind; removed: TimelineWord[]; clipped: Set<string> };

/** Every edit point, keyed by the index of the segment that starts there. */
export function seamList(edit: Timeline, words: TimelineWord[]): Seam[] {
  const starts = segmentStarts(edit);
  const used = new Set(placeWords(words, edit).map((item) => item.word.id));
  return edit.segments.slice(1).map((next, offset) => {
    const prev = edit.segments[offset];
    if (isGap(prev) || isGap(next)) return { index: offset + 1, at: starts[offset + 1], gap: NaN, kind: "gap" as const, removed: [], clipped: new Set<string>() };
    const same = prev.source === next.source;
    const gap = same ? next.srcIn - prev.srcOut : NaN;
    const skipped = !(gap > 0) ? [] : sourceWords(words, prev.source, prev.srcOut, next.srcIn);
    const kind: SeamKind = same && Math.abs(gap) < 1e-6 ? "through" : gap > 0 && !skipped.some((word) => used.has(word.id)) ? "cut" : "jump";
    const clipped = new Set(words.filter((word) => (word.source === prev.source && word.start < prev.srcOut && word.end > prev.srcOut)
      || (word.source === next.source && word.start < next.srcIn && word.end > next.srcIn)).map((word) => word.track));
    return { index: offset + 1, at: starts[offset + 1], gap, kind, removed: kind === "cut" ? skipped : [], clipped };
  });
}

/** One source's words whose midpoints fall in [from, to), in time order. */
function sourceWords(words: TimelineWord[], source: string, from: number, to: number) {
  return words.filter((word) => {
    const middle = (word.start + word.end) / 2;
    return word.source === source && middle >= from && middle < to;
  }).sort((a, b) => a.start - b.start);
}

/**
 * A removed line, as the text shows it: struck through, in place, restorable.
 * `at` is where it would go back (the index of the segment it goes before;
 * `segments.length` means the end). `from`/`to` is exactly the source it
 * restores, so restoring one line of a longer cut brings back that line and
 * nothing either side of it.
 */
export type Ghost = { id: string; at: number; source: string; track: string; words: TimelineWord[]; from: number; to: number };

/**
 * Every removed line next to the edit: the cuts between segments, plus
 * anything trimmed off the head or the tail of a source. Split into lines by
 * track and by long pauses, the same way the edit's paragraphs are.
 */
export function ghostLines(edit: Timeline, words: TimelineWord[], durations: Record<string, number>): Ghost[] {
  // Look through gaps: a lifted line sits between the same two stretches of
  // source that a deleted one would, and restores into its gap.
  const real = edit.segments.map((segment, index) => ({ segment, index })).filter((item) => !isGap(item.segment));
  if (real.length !== edit.segments.length) {
    const view = ghostLines({ ...edit, segments: real.map((item) => item.segment) }, words, durations);
    return view.map((ghost) => ({ ...ghost, at: ghost.at >= real.length ? edit.segments.length : real[ghost.at].index }));
  }
  if (!edit.segments.length) return [];
  const used = new Set(placeWords(words, edit).map((item) => item.word.id));
  const first = edit.segments[0], last = edit.segments[edit.segments.length - 1];
  const gaps: { at: number; source: string; from: number; to: number }[] = [
    { at: 0, source: first.source, from: 0, to: first.srcIn },
    ...seamList(edit, words).filter((seam) => seam.kind === "cut").map((seam) =>
      ({ at: seam.index, source: edit.segments[seam.index].source, from: edit.segments[seam.index - 1].srcOut, to: edit.segments[seam.index].srcIn })),
    { at: edit.segments.length, source: last.source, from: last.srcOut, to: durations[last.source] ?? last.srcOut },
  ];
  const ghosts: Ghost[] = [];
  for (const gap of gaps) {
    const skipped = sourceWords(words, gap.source, gap.from, gap.to);
    if (!skipped.length || skipped.some((word) => used.has(word.id))) continue;
    const lines: TimelineWord[][] = [];
    for (const word of skipped) {
      const line = lines[lines.length - 1], previous = line?.[line.length - 1];
      if (!line || previous.track !== word.track || word.start - previous.end > PAUSE_BREAK) lines.push([word]);
      else line.push(word);
    }
    lines.forEach((line, index) => {
      const before = lines[index - 1]?.[lines[index - 1].length - 1], after = lines[index + 1]?.[0];
      ghosts.push({ id: `g-${line[0].id}`, at: gap.at, source: gap.source, track: line[0].track, words: line,
        from: before ? (before.end + line[0].start) / 2 : gap.from, to: after ? (line[line.length - 1].end + after.start) / 2 : gap.to });
    });
  }
  return ghosts;
}

/**
 * Put a removed range of source back where it came from. It joins the
 * segment on either side when they are the same source and meet it, and
 * otherwise goes in as its own segment, so restoring the middle line of a
 * three-line cut leaves the other two cut.
 */
export function restoreRange(edit: Timeline, at: number, source: string, from: number, to: number): Timeline {
  // Restoring into a lifted hole fills it: the gap before `at` gives up the
  // restored length, so nothing after the hole moves.
  const hole = edit.segments[at - 1];
  if (hole && isGap(hole)) {
    const rest = segmentLength(hole) - (to - from);
    const filled = restoreRange({ ...edit, segments: edit.segments.filter((_, index) => index !== at - 1) }, at - 1, source, from, to);
    if (rest <= 1e-6) return filled;
    // What is left of the hole stays on the side the line did not come from.
    const home = filled.segments.findIndex((segment) => segment.source === source && segment.srcIn <= from + 1e-6 && segment.srcOut >= to - 1e-6);
    const before = filled.segments[home - 1];
    const joinedBefore = !!before && before.source === source ? false : filled.segments[home].srcIn < from - 1e-6;
    const segments = [...filled.segments];
    segments.splice(joinedBefore || filled.segments[home].srcOut <= to + 1e-6 ? home + 1 : home, 0, { ...hole, srcOut: rest });
    return { ...filled, segments };
  }
  const segments = [...edit.segments];
  const prev = segments[at - 1], next = segments[at];
  const joinsPrev = prev?.source === source && prev.srcOut >= from - 1e-6;
  const joinsNext = next?.source === source && next.srcIn <= to + 1e-6;
  if (joinsPrev && joinsNext) segments.splice(at - 1, 2, { id: nextId("seg"), source, srcIn: prev.srcIn, srcOut: next.srcOut });
  else if (joinsPrev) segments.splice(at - 1, 1, { ...prev, id: nextId("seg"), srcOut: Math.max(prev.srcOut, to) });
  else if (joinsNext) segments.splice(at, 1, { ...next, id: nextId("seg"), srcIn: Math.min(next.srcIn, from) });
  else segments.splice(at, 0, { id: nextId("seg"), source, srcIn: from, srcOut: to });
  return { ...edit, segments };
}
