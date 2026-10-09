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
 * A segment is cut on every track at once, so a ripple (a delete, an
 * Extract, a Splice-in, a moved paragraph) keeps every track in sync, which is
 * Avid with every sync lock on. What only SOME tracks do lives in a segment's
 * OVERRIDES: for a lane, either another source range it plays for the
 * segment's whole length (Overwrite on that track alone, Avid's B with only
 * some tracks on) or nothing (Lift on that track alone). An override covers its
 * segment whole: an edit that ends inside a segment splits the segment first,
 * so what a lane plays at any program time is one lookup. Storing a clip per
 * track instead would make every one-word delete on a 98-mic string out cut 98
 * clips; this way it cuts one segment, and lanes differ only where an editor
 * made them differ.
 *
 * A lane is a PERSON (a mic owner, with a mic in each source), and words,
 * silences and playback are keyed by it. A record track is not: it is a layer,
 * A1, A2…, as in Avid, holding whatever was cut onto it. A segment's `layers`
 * says which track each person who plays there sits on, so A1 can carry one
 * person's lav for one clip and someone else's for the next. Two people never
 * share a track at once: an Overwrite onto a track lifts whoever was on it.
 * A segment without `layers` (a string out from before them) puts each person
 * on the track they were patched to, which is what it showed then.
 *
 * Times here are seconds of source time, as the prototype's were. The saved
 * document (src/bindings/EditDocument.ts) is whole frames, and
 * edit-document.ts snaps every boundary to a frame on the way out: Avid cannot
 * express a subframe cut, so neither can a saved edit.
 */
import { multitrackTextLayout } from "./multitrack-text-layout";

/** A person. `track` is their AAF track number, 0 when they have none; `angle` marks a group angle given one. */
export type TimelineLane = { id: string; name: string; track: number; angle?: boolean };
/** `cue` is the transcript cue the word was said in (AAF Audio's cue id), when known. */
/** `heardOn`: the AAF track this word was really spoken into, when the bleed resolver says it is bleed on this mic. */
export type TimelineWord = { id: string; source: string; track: string; text: string; start: number; end: number; cue?: string; heardOn?: string };
/**
 * What one lane plays across a whole segment instead of the segment's own
 * clip: another source range from `srcIn` for the segment's length (an
 * Overwrite on that track alone), or nothing (a Lift on that track alone).
 */
export type LaneOverride = { source: string; srcIn: number } | { source: null };
/**
 * `tracks`: the lanes this clip plays on, when it was cut with only some (a bite of one person); absent, every lane on a track.
 * `overrides`: per lane, what that lane plays here instead (see the note at the top).
 * `layers`: per lane, the record track (1 for A1) it sits on here.
 * `cuts`: lanes with an edit of their own where this segment starts, though
 * their material runs straight on (Add Edit or the blade on their track: a
 * through edit, which Avid and Neo both keep as a real cut on that track).
 */
export type TimelineSegment = {
  id: string; source: string; srcIn: number; srcOut: number; tracks?: string[]; overrides?: Record<string, LaneOverride>; layers?: Record<string, number>; cuts?: string[];
};
export type TimelineMute = { source: string; track: string; srcIn: number; srcOut: number };
export type Timeline = { segments: TimelineSegment[]; mutes: TimelineMute[] };

/**
 * A word as it appears in the edit, with its place in program time. `voice`
 * is the lane whose override it plays in, or null for the segment's own clip;
 * `offset` maps its source time to program time (program = source + offset).
 * `clip` is the first segment of the run its lane plays without a cut (see
 * `laneClips`): two words of one person in the same clip have no edit
 * between them, however many segments other people's edits made.
 */
export type PlacedWord = {
  word: TimelineWord; segment: number; voice: string | null; offset: number; clip: number; programStart: number; programEnd: number; muted: boolean;
};

/**
 * One appearance of a word in the edit. The same source word can be used
 * twice (a line spliced in again later), so a word id alone does not say
 * WHICH one the editor selected; the segment it plays in does.
 */
export const placementKey = (item: PlacedWord) => item.voice == null ? `${item.segment}:${item.word.id}` : `${item.segment}@${item.voice}:${item.word.id}`;

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

/** Whether a clip's own range is cut for this lane: every lane unless the clip names its own. Overrides aside. */
const cutFor = (segment: TimelineSegment, lane: string) => !segment.tracks || segment.tracks.includes(lane);
/** Whether a clip plays its own range on this lane: cut for it, and not overridden there. */
export const playsOn = (segment: TimelineSegment, lane: string) => cutFor(segment, lane) && !segment.overrides?.[lane];
/** Two clips that play the same lanes, which is when they can be one clip. */
const sameTracks = (a: TimelineSegment, b: TimelineSegment) => (a.tracks ? [...a.tracks].sort().join("\n") : null) === (b.tracks ? [...b.tracks].sort().join("\n") : null);

/** A source range one lane plays, or what a segment's own clip plays. */
export type SourceSpan = { source: string; srcIn: number; srcOut: number };

/** What a lane plays across a segment: its override, else the segment's own clip if that plays it, else nothing. */
export function lanePlay(segment: TimelineSegment, lane: string): SourceSpan | null {
  const over = segment.overrides?.[lane];
  if (over) return over.source == null ? null : { source: over.source, srcIn: over.srcIn, srcOut: over.srcIn + segmentLength(segment) };
  return !isGap(segment) && cutFor(segment, lane) ? { source: segment.source, srcIn: segment.srcIn, srcOut: segment.srcOut } : null;
}

/** The source range a placed word's voice plays in its segment. */
export function voiceSpan(edit: Timeline, item: PlacedWord): SourceSpan {
  const segment = edit.segments[item.segment];
  return (item.voice != null ? lanePlay(segment, item.voice) : null) ?? { source: segment.source, srcIn: segment.srcIn, srcOut: segment.srcOut };
}

/**
 * Where people sit on the record's tracks. `carries` lists the lanes with a
 * mic in a source; `home` is a lane's track wherever a segment does not say
 * (its patched track in a string out from before layers), or undefined.
 */
export type Layering = { carries: (source: string) => readonly string[]; home: (lane: string) => number | undefined };
/** Someone put on a record track by an edit. */
export type Placement = { lane: string; layer: number };

const carried = new WeakMap<readonly string[], Set<string>>();
const carriesLane = (layering: Layering, source: string, lane: string) => {
  const list = layering.carries(source);
  let set = carried.get(list);
  if (!set) carried.set(list, set = new Set(list));
  return set.has(lane);
};

/** The record track a lane sits on in a segment, or undefined when it has none there. */
export function layerOf(segment: TimelineSegment, lane: string, layering: Layering): number | undefined {
  return segment.layers?.[lane] ?? layering.home(lane);
}

/** Who sounds in a segment and on which track: each lane whose clip or override plays there, with a mic in what it plays. */
export function playersOf(segment: TimelineSegment, layering: Layering): { lane: string; layer: number; play: SourceSpan }[] {
  if (isGap(segment)) return [];
  const out: { lane: string; layer: number; play: SourceSpan }[] = [];
  const candidates = new Set([...(segment.tracks ?? layering.carries(segment.source)), ...Object.keys(segment.overrides ?? {})]);
  for (const lane of candidates) {
    const play = lanePlay(segment, lane);
    if (!play || !carriesLane(layering, play.source, lane)) continue;
    const layer = layerOf(segment, lane, layering);
    if (layer != null) out.push({ lane, layer, play });
  }
  return out;
}

/**
 * Someone this edit would put on a record track over a stretch where they
 * already play on ANOTHER track, or null. A segment holds each person on one
 * track at a time (its overrides and layers are keyed by person), so an
 * Overwrite there would move them off the first track without a word: Kara
 * cut onto A2 over a stretch where her other line plays on A1 lost the A1
 * line. Callers refuse instead, and say who and where.
 */
export function doubledLane(edit: Timeline, program: number, length: number, placements: readonly Placement[], layering: Layering): Placement | null {
  const starts = segmentStarts(edit);
  for (let index = 0; index < edit.segments.length; index++) {
    const segment = edit.segments[index], from = starts[index], to = from + segmentLength(segment);
    if (isGap(segment) || to <= program + 1e-6 || from >= program + length - 1e-6) continue;
    const players = playersOf(segment, layering);
    for (const { lane, layer } of placements) {
      const other = players.find((player) => player.lane === lane && player.layer !== layer);
      if (other) return { lane, layer: other.layer };
    }
  }
  return null;
}

/** How many record tracks the edit uses, and never fewer than `minimum` (empty tracks to cut onto, as a new Avid sequence has). */
export function layerCount(edit: Timeline, layering: Layering, minimum = 4): number {
  let most = minimum;
  for (const segment of edit.segments) for (const player of playersOf(segment, layering)) most = Math.max(most, player.layer);
  return most;
}

/** One stretch of a record track: one lane playing one source range across a run of segments. */
export type LayerClip = LaneClip & { lane: string };

/**
 * What a record track holds, as clips: on track `layer`, consecutive segments
 * where the same lane carries on the same source range are one clip, so an
 * edit on other tracks alone is no cut here. Empty stretches are filler.
 */
export function layerClips(edit: Timeline, layer: number, layering: Layering): LayerClip[] {
  return clipsByLayer(edit, layering).get(layer) ?? [];
}

const clipsCache = new WeakMap<Timeline, { segments: TimelineSegment[]; count: number; layering: Layering; byLayer: Map<number, LayerClip[]> }>();

/**
 * Every record track's clips (layerClips), in one pass over the segments with
 * playersOf asked once per segment, and kept per edit: a timeline is never
 * changed in place (every edit makes a new one), and the timeline, the
 * gestures, the selection and the Inspector all ask for the same tracks of
 * the same edit. Asked per track, it was tracks × segments × people.
 */
export function clipsByLayer(edit: Timeline, layering: Layering): ReadonlyMap<number, LayerClip[]> {
  const known = clipsCache.get(edit);
  if (known && known.segments === edit.segments && known.count === edit.segments.length && known.layering === layering) return known.byLayer;
  const byLayer = new Map<number, LayerClip[]>();
  let at = 0;
  edit.segments.forEach((segment, index) => {
    const length = segmentLength(segment), taken = new Set<number>();
    for (const player of playersOf(segment, layering)) {
      // The first person on a track holds it, as a lookup by track always took the first.
      if (taken.has(player.layer)) continue;
      taken.add(player.layer);
      let out = byLayer.get(player.layer);
      if (!out) byLayer.set(player.layer, out = []);
      const last = out[out.length - 1];
      if (last && last.last === index - 1 && last.lane === player.lane && last.source === player.play.source && Math.abs(last.srcOut - player.play.srcIn) < 1e-6
        && !segment.cuts?.includes(player.lane)) {
        last.to = at + length; last.srcOut = player.play.srcOut; last.last = index;
      } else out.push({ lane: player.lane, from: at, to: at + length, source: player.play.source, srcIn: player.play.srcIn, srcOut: player.play.srcOut, first: index, last: index });
    }
    at += length;
  });
  clipsCache.set(edit, { segments: edit.segments, count: edit.segments.length, layering, byLayer });
  return byLayer;
}

/** Overrides as they are `from` seconds into their segment: a split keeps each lane on the same material. */
function shiftOverrides(segment: TimelineSegment, from: number): Pick<TimelineSegment, "overrides"> {
  if (!segment.overrides) return {};
  return { overrides: Object.fromEntries(Object.entries(segment.overrides).map(([lane, over]) =>
    [lane, over.source == null ? over : { source: over.source, srcIn: over.srcIn + from }])) };
}

/** Part of a segment, [from, to) seconds into it, with its overrides carried along. */
function sliceSegment(segment: TimelineSegment, from: number, to: number): TimelineSegment {
  // An edit at the segment's start stays with the piece that starts there.
  const { cuts, ...rest } = segment;
  return { ...rest, id: nextId("seg"), srcIn: segment.srcIn + from, srcOut: segment.srcIn + to, ...shiftOverrides(segment, from), ...(cuts && from < 1e-9 ? { cuts } : {}) };
}

/** Whether two segments put everyone on the same tracks. */
function sameLayers(prev: TimelineSegment, next: TimelineSegment) {
  const a = prev.layers ?? {}, b = next.layers ?? {};
  const lanes = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const lane of lanes) if (a[lane] !== b[lane]) return false;
  return true;
}

/** Whether `next` carries on every lane's override from `prev` without a jump, and on the same tracks, which is when the two can be one segment. */
function overridesContinue(prev: TimelineSegment, next: TimelineSegment) {
  if (!sameLayers(prev, next)) return false;
  const a = prev.overrides ?? {}, b = next.overrides ?? {};
  const lanes = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const lane of lanes) {
    const x = a[lane], y = b[lane];
    if (!x || !y) return false;
    if (x.source == null || y.source == null) { if (x.source !== y.source) return false; continue; }
    if (x.source !== y.source || Math.abs(y.srcIn - (x.srcIn + segmentLength(prev))) > 1e-6) return false;
  }
  return true;
}

/**
 * A segment as it reads after its overrides changed: an override that just
 * repeats the segment's own clip is dropped, and when nobody hears the
 * segment's own clip any more and every lane plays the same new range, the
 * segment simply becomes that range on those lanes.
 */
function tidy(segment: TimelineSegment, carries?: (source: string) => readonly string[]): TimelineSegment {
  const kept = Object.entries(segment.overrides ?? {}).filter(([lane, over]) =>
    !(over.source === segment.source && Math.abs(over.srcIn - segment.srcIn) < 1e-9 && cutFor(segment, lane)));
  const { overrides: _dropped, ...plain } = segment;
  if (!kept.length) return plain;
  const ownLanes = segment.tracks ?? carries?.(segment.source);
  const first = kept[0][1];
  if (ownLanes && first.source != null && ownLanes.every((lane) => kept.some(([other]) => other === lane))
    && kept.every(([, over]) => over.source === first.source && Math.abs(over.srcIn - first.srcIn) < 1e-9)) {
    return { id: segment.id, source: first.source, srcIn: first.srcIn, srcOut: first.srcIn + segmentLength(segment), tracks: kept.map(([lane]) => lane),
      ...(segment.layers ? { layers: segment.layers } : {}) };
  }
  return { ...plain, overrides: Object.fromEntries(kept) };
}

/** Each lane's silenced ranges, by source and lane, so a word asks only its own. */
function mutesByLane(edit: Timeline) {
  const out = new Map<string, TimelineMute[]>();
  for (const mute of edit.mutes) {
    const key = `${mute.source}\n${mute.track}`, list = out.get(key);
    if (list) list.push(mute); else out.set(key, [mute]);
  }
  return out;
}

/**
 * A word list's by-source index, and where each word sits in the list (to
 * break ties the way that order did), built once per list. Kept with the
 * length it was built at, so a list grown in place is indexed again.
 */
const wordIndexes = new WeakMap<readonly TimelineWord[], { length: number; index: ReturnType<typeof indexBySource>; order: Map<TimelineWord, number> }>();
function wordIndex(words: TimelineWord[]) {
  let known = wordIndexes.get(words);
  if (!known || known.length !== words.length) wordIndexes.set(words, known = { length: words.length, index: indexBySource(words), order: new Map(words.map((word, at) => [word, at])) });
  return known;
}

/** Words that play in the edit, in program order. A word belongs to a segment
 *  when its midpoint does; a later edit can never leave half a word showing.
 *  Each segment looks up only the words whose middles fall in the ranges it
 *  plays (a binary search per range in a by-source index), rather than every
 *  word in every segment: a three-hour source under a string out of a few
 *  hundred clips was millions of checks, four or five times per edit. */
export function placeWords(words: TimelineWord[], edit: Timeline): PlacedWord[] {
  const starts = segmentStarts(edit);
  const placed: PlacedWord[] = [];
  const { index, order } = wordIndex(words);
  const silenced = mutesByLane(edit);
  const isMuted = (word: TimelineWord) => (silenced.get(`${word.source}\n${word.track}`) ?? []).some((mute) => word.start >= mute.srcIn - 1e-6 && word.end <= mute.srcOut + 1e-6);
  // Each lane's continuous runs, found as words ask for them: a word that
  // straddles an edit made on other lanes alone is neither clipped by it nor
  // read as cut.
  const runs = new Map<string, [number, number]>();
  const carriesOn = (at: number, lane: string) => {
    if (at <= 0 || at >= edit.segments.length) return false;
    const before = lanePlay(edit.segments[at - 1], lane), after = lanePlay(edit.segments[at], lane);
    return !!before && !!after && before.source === after.source && Math.abs(after.srcIn - before.srcOut) < 1e-6;
  };
  const runOf = (at: number, lane: string): [number, number] => {
    const known = runs.get(`${at}\n${lane}`);
    if (known) return known;
    let first = at, last = at;
    while (carriesOn(first, lane)) first--;
    while (carriesOn(last + 1, lane)) last++;
    const run: [number, number] = [first, last];
    for (let step = first; step <= last; step++) runs.set(`${step}\n${lane}`, run);
    return run;
  };
  edit.segments.forEach((segment, at) => {
    if (isGap(segment)) return;
    const length = segmentLength(segment);
    const place = (word: TimelineWord, srcIn: number, voice: string | null, lifted: boolean) => {
      const offset = starts[at] - srcIn;
      const [first, last] = lifted ? [at, at] : runOf(at, word.track);
      placed.push({ word, segment: at, voice, offset, clip: first, programStart: Math.max(starts[first], word.start + offset),
        programEnd: Math.min(starts[last] + segmentLength(edit.segments[last]), word.end + offset), muted: lifted || isMuted(word) });
    };
    // The clip's own range: every lane it carries, unless that lane plays something else here.
    for (const word of between(index, segment.source, segment.srcIn, segment.srcIn + length)) {
      const over = segment.overrides?.[word.track];
      if (!cutFor(segment, word.track)) continue;
      // Lifted on this lane alone: its own words stay in the text, silenced.
      if (over) { if (over.source == null) place(word, segment.srcIn, null, true); continue; }
      place(word, segment.srcIn, null, false);
    }
    // Overwritten on one lane alone: that lane plays the override's range.
    for (const [lane, over] of Object.entries(segment.overrides ?? {})) {
      if (over.source == null) continue;
      for (const word of between(index, over.source, over.srcIn, over.srcIn + length)) if (word.track === lane) place(word, over.srcIn, lane, false);
    }
  });
  // Program order; a tie keeps the order a scan of segments, then of the words as given, would have met them.
  return placed.sort((a, b) => a.programStart - b.programStart || a.word.start - b.word.start || a.segment - b.segment || (order.get(a.word) ?? 0) - (order.get(b.word) ?? 0));
}

/**
 * Paragraphs: a new one on a track change or a long pause (in program time).
 * `byCue` also starts one at every transcript cue, the way AAF Audio lists a
 * person's transcript: one line per thing they said.
 */
/**
 * Placed words as the record transcript reads them: each person's phrase
 * kept whole, phrases ordered by when they start (then by lane, so a tie
 * reads the same every time). In strict word order, people talking over one
 * another interleaved word by word, and with a crowd of open mics every
 * paragraph was a single word ("don't", "have", "wanted", "walls"). A phrase
 * is a cue within one continuous clip of its lane; words keep program order
 * inside it.
 */
export function recordOrder(placed: PlacedWord[]): PlacedWord[] {
  const phrases = new Map<string, PlacedWord[]>();
  for (const item of placed) {
    const key = `${item.clip}\n${item.word.track}\n${item.word.cue ?? item.word.id}`, phrase = phrases.get(key);
    if (phrase) phrase.push(item); else phrases.set(key, [item]);
  }
  return [...phrases.values()].sort((a, b) => a[0].programStart - b[0].programStart || a[0].word.track.localeCompare(b[0].word.track)).flat();
}

export function paragraphs(placed: PlacedWord[], byCue = false): TimelineParagraph[] {
  const out: TimelineParagraph[] = [];
  let previous: PlacedWord | null = null;
  for (const item of placed) {
    const last = out[out.length - 1];
    // An edit made on other lanes alone is not a cut in this person's line.
    const cut = !!previous && previous.segment !== item.segment && !(previous.word.track === item.word.track && previous.clip === item.clip);
    if (!last || last.track !== item.word.track || item.programStart - (previous?.programEnd ?? 0) > PAUSE_BREAK
      || (byCue && item.word.cue !== previous?.word.cue)) {
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
    if (srcIn > segment.srcIn) segments.push(sliceSegment(segment, 0, srcIn - segment.srcIn));
    if (srcOut < segment.srcOut) segments.push(sliceSegment(segment, srcOut - segment.srcIn, segmentLength(segment)));
  }
  return { ...edit, segments };
}

/**
 * The source range a deletion takes: from just before the first selected word
 * to just after the last, keeping a little air but never reaching into the
 * words on either side (any track's), and never outside the segment.
 */
export function cutRange(words: TimelineWord[], selected: TimelineWord[], segment: SourceSpan): [number, number] {
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
    if (chosen && (!current.length || (current[0].segment === item.segment && current[0].voice === item.voice))) current.push(item);
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
  // Program ranges: only the appearance that was selected is cut, even when
  // the same source range plays somewhere else in the edit too, and a word an
  // override plays is cut where it plays.
  const spans: [number, number][] = [];
  for (const run of runs(placed, keys)) {
    const first = run[0];
    const [srcIn, srcOut] = cutRange(words, run.map((item) => item.word), voiceSpan(edit, first));
    const from = srcIn + first.offset, to = srcOut + first.offset;
    spans.push([from, to]);
    seconds += to - from;
    for (const item of placed) {
      const middle = (item.word.start + item.word.end) / 2 + item.offset;
      if (item.segment !== first.segment || middle < from || middle >= to) continue;
      if (keys.has(placementKey(item))) removed.push(item.word);
      // A bleed copy of a line is the same speech heard on a neighbour's mic,
      // not someone talking over it: cutting it costs nobody their words.
      else if (!item.word.heardOn) crosstalk.push(item.word);
    }
  }
  // Later ranges first, so earlier program positions stay where they were.
  let next = edit;
  for (const [from, to] of [...spans].sort((a, b) => b[0] - a[0])) next = extractProgram(next, from, to).edit;
  return { edit: next, removed, crosstalk, seconds };
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
      segments.push(sliceSegment(segment, 0, program - at));
      index = segments.length;
      segments.push(sliceSegment(segment, program - at, length));
    } else segments.push(segment);
    at += length;
    if (position === edit.segments.length - 1 && index === edit.segments.length && program >= at - 1e-6) index = segments.length;
  }
  return { edit: { ...edit, segments }, index };
}

/** Splice a source range into the edit at a program position (Avid's splice-in), on `tracks` only when given. */
export function spliceIn(edit: Timeline, source: string, srcIn: number, srcOut: number, program: number, placements?: Placement[]): Timeline {
  if (srcOut <= srcIn) return edit;
  const split = splitAt(edit, program);
  const segments = [...split.edit.segments];
  segments.splice(split.index, 0, { id: nextId("seg"), source, srcIn, srcOut, ...placed(placements) });
  return { ...split.edit, segments };
}

/** A new clip's tracks and their places on the record. */
const placed = (placements?: Placement[]): Pick<TimelineSegment, "tracks" | "layers"> => placements
  ? { tracks: placements.map((item) => item.lane), layers: Object.fromEntries(placements.map((item) => [item.lane, item.layer])) } : {};

/**
 * Overwrite (Avid's B): the source range replaces what is at the program
 * position for its own length, and nothing after it moves. Past the end of
 * the edit it simply runs on, as Avid's does.
 *
 * With `placements`, only those record tracks change and every other track
 * keeps exactly what it had there, as an Avid overwrite with only those
 * tracks patched. Each person placed plays the new material on their track,
 * and whoever was on that track there is lifted, since a track holds one
 * clip at a time. It used to clear the range on every lane and splice the new
 * clip back on these, so overwriting one person silenced everyone else.
 */
export function overwrite(edit: Timeline, source: string, srcIn: number, srcOut: number, program: number, placements?: Placement[], layering?: Layering): Timeline {
  if (srcOut <= srcIn) return edit;
  const length = srcOut - srcIn, total = programDuration(edit);
  if (!placements || !layering) {
    const end = Math.min(total, program + length);
    const cleared = end > program ? extractProgram(edit, program, end).edit : edit;
    return spliceIn(cleared, source, srcIn, srcOut, program);
  }
  // Past the end (a clip dropped beyond the last one), filler runs up to it.
  const start = Math.max(0, program), end = start + length;
  // Running past the end: the new part is filler on every other lane.
  const base = end > total ? { ...edit, segments: [...edit.segments, { id: nextId("gap"), source: GAP, srcIn: 0, srcOut: end - total }] } : edit;
  const first = splitAt(base, start), second = splitAt(first.edit, end);
  const segments = [...second.edit.segments], starts = segmentStarts(second.edit);
  for (let index = first.index; index < second.index; index++) {
    const segment = segments[index], from = srcIn + starts[index] - start;
    if (isGap(segment)) { segments[index] = { id: nextId("seg"), source, srcIn: from, srcOut: from + segmentLength(segment), ...placed(placements) }; continue; }
    const players = playersOf(segment, layering);
    const overrides: Record<string, LaneOverride> = { ...segment.overrides }, layers: Record<string, number> = { ...segment.layers };
    for (const { lane, layer } of placements) {
      // Whoever holds this track here gives it up.
      for (const other of players) if (other.layer === layer && other.lane !== lane) overrides[other.lane] = { source: null };
      overrides[lane] = { source, srcIn: from };
      layers[lane] = layer;
    }
    segments[index] = tidy({ ...segment, overrides, layers }, layering.carries);
  }
  return { ...second.edit, segments: mergeGaps(segments) };
}

/**
 * Where a splice lands with Snap on: the program position nearest `program`
 * that is not inside a word, so a cut never lands mid-word. Candidates are the
 * edit's start and end, every edit point, and the middle of each gap between
 * two words that play one after another.
 */
export function snapToGap(edit: Timeline, placed: PlacedWord[], program: number): number {
  const total = programDuration(edit);
  const candidates = [0, total, ...segmentStarts(edit)];
  // In time order: the record lists each phrase whole (recordOrder), so its
  // words are not in the order they sound.
  const audible = placed.filter((item) => !item.muted).sort((a, b) => a.programStart - b.programStart);
  // Overtalk overlaps: a gap starts where the LAST word still sounding ends.
  let reach = audible[0]?.programEnd ?? 0;
  for (const item of audible.slice(1)) {
    if (item.programStart >= reach - 1e-6) candidates.push((reach + item.programStart) / 2);
    reach = Math.max(reach, item.programEnd);
  }
  const inside = audible.find((item) => program > item.programStart + 1e-6 && program < item.programEnd - 1e-6);
  if (!inside) return Math.max(0, Math.min(total, program));
  return candidates.reduce((best, at) => Math.abs(at - program) < Math.abs(best - program) ? at : best, candidates[0]);
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
 * Lift on some tracks only (Avid, with only those record tracks selected):
 * the range goes silent on those tracks, there and nowhere else, and nothing
 * moves. The lifted words stay in the text, struck through. This used to
 * silence that SOURCE range on the lane, which also silenced it anywhere else
 * the same material played: Avid's lift leaves filler at one place.
 */
export function liftLayers(edit: Timeline, programIn: number, programOut: number, layers: number[], layering: Layering): Timeline {
  if (programOut <= programIn || !layers.length) return edit;
  const first = splitAt(edit, programIn), second = splitAt(first.edit, programOut);
  const segments = [...second.edit.segments];
  let changed = false;
  for (let index = first.index; index < second.index; index++) {
    const segment = segments[index];
    // Whoever is on those tracks there; an empty track has nothing to lift.
    const lifted = playersOf(segment, layering).filter((player) => layers.includes(player.layer)).map((player) => player.lane);
    if (!lifted.length) continue;
    changed = true;
    segments[index] = { ...segment, overrides: { ...segment.overrides, ...Object.fromEntries(lifted.map((lane) => [lane, { source: null }])) } };
  }
  return changed ? { ...second.edit, segments } : edit;
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
  const starts = segmentStarts(edit), byWords = wordIndex(words).index;
  const found: DeadSpace[] = [];
  const push = (from: number, to: number, gap: boolean) => {
    const last = found[found.length - 1];
    if (last && Math.abs(last.to - from) < 1e-6) { last.to = to; last.gap = last.gap && gap; } else found.push({ from, to, gap });
  };
  edit.segments.forEach((segment, index) => {
    const at = starts[index];
    if (isGap(segment)) return push(at, at + segmentLength(segment), true);
    // Every range heard here: the clip's own and any a lane overwrote. Quiet
    // means quiet in all of them, since taking it out closes every lane.
    const heard = [{ source: segment.source, srcIn: segment.srcIn },
      ...Object.values(segment.overrides ?? {}).flatMap((over) => over.source == null ? [] : [{ source: over.source, srcIn: over.srcIn }])];
    // Each range's speech as merged spans (padded), walked with one cursor as
    // the step moves on: it was every word in the segment at every 0.05 s
    // step, billions of checks over an uncut three-hour source.
    const spoken = heard.map((span) => mergeSpans(touching(byWords, span.source, span.srcIn - options.pad, span.srcIn + segmentLength(segment) + options.pad)
      .map((word) => [word.start - options.pad, word.end + options.pad] as [number, number])));
    const cursor = heard.map(() => 0);
    let quietFrom: number | null = null;
    for (let t = segment.srcIn; t < segment.srcOut - 1e-9; t += options.step) {
      const until = Math.min(segment.srcOut, t + options.step);
      const quiet = heard.every((span, which) => {
        const shift = span.srcIn - segment.srcIn, a = t + shift, b = until + shift, spans = spoken[which];
        while (cursor[which] < spans.length && spans[cursor[which]][1] <= a) cursor[which]++;
        const talking = cursor[which] < spans.length && spans[cursor[which]][0] < b;
        return !talking && loudest(span.source, a, b) < options.threshold;
      });
      if (quiet && quietFrom == null) quietFrom = t;
      if (!quiet && quietFrom != null) { push(at + quietFrom - segment.srcIn, at + t - segment.srcIn, false); quietFrom = null; }
    }
    if (quietFrom != null) push(at + quietFrom - segment.srcIn, at + segmentLength(segment), false);
  });
  return found.filter((space) => space.gap || space.to - space.from >= options.minimum);
}

/** Spans sorted and merged where they overlap or touch. */
function mergeSpans(spans: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [from, to] of [...spans].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to); else out.push([from, to]);
  }
  return out;
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
  // The neighbours in time, not in the list: the record lists each phrase
  // whole (recordOrder), so the word beside it there may sound over it.
  let before = 0, after = Infinity;
  placed.forEach((item, index) => {
    if (index >= first && index <= last) return;
    if (item.programEnd <= start) before = Math.max(before, item.programEnd);
    if (item.programStart >= end) after = Math.min(after, item.programStart);
  });
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
export function healSeam(edit: Timeline, index: number, andCuts = false): Timeline {
  const prev = edit.segments[index - 1], next = edit.segments[index];
  if (!prev || !next || prev.source !== next.source || next.srcIn < prev.srcOut || !sameTracks(prev, next) || !overridesContinue(prev, next)) return edit;
  // A track's own edit there is only taken away when the editor heals it.
  if (next.cuts?.length && !andCuts) return edit;
  const segments = [...edit.segments];
  segments.splice(index - 1, 2, { ...prev, id: nextId("seg"), srcIn: prev.srcIn, srcOut: next.srcOut });
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
  const starts = segmentStarts(edit), { index, order } = wordIndex(words);
  const used = new Set(placeWords(words, edit).map((item) => item.word.id));
  // Words starting together keep the order they came in, as a filter over the list kept them.
  const inOrder = (list: TimelineWord[]) => list.sort((a, b) => a.start - b.start || (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return edit.segments.slice(1).map((next, offset) => {
    const prev = edit.segments[offset];
    if (isGap(prev) || isGap(next)) return { index: offset + 1, at: starts[offset + 1], gap: NaN, kind: "gap" as const, removed: [], clipped: new Set<string>() };
    const same = prev.source === next.source;
    const gap = same ? next.srcIn - prev.srcOut : NaN;
    const skipped = !(gap > 0) ? [] : inOrder(between(index, prev.source, prev.srcOut, next.srcIn));
    // Where some lane's override does not carry on, that lane jumps: the edit point is not a plain cut.
    const kind: SeamKind = !overridesContinue(prev, next) ? "jump"
      : same && Math.abs(gap) < 1e-6 ? "through" : gap > 0 && !skipped.some((word) => used.has(word.id)) ? "cut" : "jump";
    // Words that straddle either side of the edit point.
    const clipped = new Set([...touching(index, prev.source, prev.srcOut, prev.srcOut + 1e-9).filter((word) => word.start < prev.srcOut && word.end > prev.srcOut),
      ...touching(index, next.source, next.srcIn, next.srcIn + 1e-9).filter((word) => word.start < next.srcIn && word.end > next.srcIn)].map((word) => word.track));
    return { index: offset + 1, at: starts[offset + 1], gap, kind, removed: kind === "cut" ? skipped : [], clipped };
  });
}

/**
 * A removed line, as the text shows it: struck through, in place, restorable.
 * `at` is where it would go back (the index of the segment it goes before;
 * `segments.length` means the end). `from`/`to` is exactly the source it
 * restores, so restoring one line of a longer cut brings back that line and
 * nothing either side of it.
 */
/** The sentence holding word `index` within its paragraph, as a double-click selects it: back and on to the nearest sentence ends. */
export function sentenceAround(placed: PlacedWord[], firsts: number[], paragraphs: TimelineParagraph[], index: number): [number, number] {
  const ends = (text: string) => /[.!?]["”']?$/.test(text);
  const paragraph = paragraphHolding(firsts, index) ?? -1;
  const first = firsts[paragraph], last = first + paragraphs[paragraph].words.length - 1;
  let from = index, to = index;
  while (from > first && !ends(placed[from - 1].word.text)) from--;
  while (to < last && !ends(placed[to].word.text)) to++;
  return [from, to];
}

/** Each placed word's latest end so far: non-decreasing, though words on two tracks overlap, so a playhead can be found by a binary search. */
export function runningEnds(placed: PlacedWord[]): number[] {
  let latest = -Infinity;
  return placed.map((item) => (latest = Math.max(latest, item.programEnd)));
}

/** The index of the placed word under program time `at`, or -1: the first word ending after it, when it has started. */
export function wordUnder(placed: PlacedWord[], ends: number[], at: number): number {
  const index = firstAbove(ends, at);
  return index < placed.length && placed[index].programStart <= at ? index : -1;
}

/** The first index whose value is above `value` in a non-decreasing list, or its length: where a playhead sits among running latest ends. */
export function firstAbove(sorted: number[], value: number): number {
  let low = 0, high = sorted.length;
  while (low < high) { const mid = (low + high) >> 1; if (sorted[mid] > value) high = mid; else low = mid + 1; }
  return low;
}

export type Ghost = { id: string; at: number; source: string; track: string; words: TimelineWord[]; from: number; to: number };

/**
 * The removed lines of the edit: the source each cut between two kept pieces
 * skipped, read as lines, each restorable on its own.
 *
 * Only cuts BETWEEN kept pieces. What lies before the first piece or after
 * the last was never in the string out: counting it as removed showed the
 * whole rest of a half-hour sequence under a 29-second string out, for every
 * mic, and was most of what flooded the page
 * (docs/UI-CORRECTIONS-2026-10-05.md, item 15).
 *
 * A line is one speaker's turn: their cues run together until a long pause or
 * someone else's line. Bleed copies are left out, both the words the resolver
 * says were heard on another mic and, where it has not run, a cue that says
 * nearly the same words at the same time as a longer one on another mic. Lines
 * used to break at every change of track, so interleaved mics drew one row per
 * word. `placed` is the edit's placement when the caller already has it.
 */
export function ghostLines(edit: Timeline, words: TimelineWord[], placed?: PlacedWord[]): Ghost[] {
  const used = new Set((placed ?? placeWords(words, edit)).map((item) => item.word.id));
  return ghostsOf(edit, wordIndex(words).index, used);
}

/** Each source's words in time order, keyed by their middle, for a binary search per cut. */
function indexBySource(words: TimelineWord[]) {
  // `longest` is the longest word in the source, so a search for words that
  // touch a range can widen it by that much and still use the middles.
  const out = new Map<string, { words: TimelineWord[]; middles: number[]; longest: number }>();
  for (const word of words) {
    let entry = out.get(word.source);
    if (!entry) out.set(word.source, entry = { words: [], middles: [], longest: 0 });
    entry.words.push(word);
    entry.longest = Math.max(entry.longest, word.end - word.start);
  }
  for (const entry of out.values()) {
    entry.words.sort((a, b) => a.start + a.end - b.start - b.end || a.start - b.start);
    entry.middles = entry.words.map((word) => (word.start + word.end) / 2);
  }
  return out;
}

/** One source's words that overlap [from, to) at all, by the index: those whose middles lie within half the longest word of it. */
function touching(index: ReturnType<typeof indexBySource>, source: string, from: number, to: number) {
  const reach = (index.get(source)?.longest ?? 0) / 2 + 1e-9;
  return between(index, source, from - reach, to + reach).filter((word) => word.start < to && word.end > from);
}

function between(index: ReturnType<typeof indexBySource>, source: string, from: number, to: number) {
  const entry = index.get(source);
  if (!entry) return [];
  const first = (at: number) => {
    let low = 0, high = entry.middles.length;
    while (low < high) { const mid = (low + high) >> 1; if (entry.middles[mid] < at) low = mid + 1; else high = mid; }
    return low;
  };
  return entry.words.slice(first(from), first(to)).sort((a, b) => a.start - b.start);
}

function ghostsOf(edit: Timeline, index: ReturnType<typeof indexBySource>, used: Set<string>): Ghost[] {
  // Look through gaps: a lifted line sits between the same two stretches of
  // source that a deleted one would, and restores into its gap.
  const real = edit.segments.map((segment, at) => ({ segment, at })).filter((item) => !isGap(item.segment));
  if (real.length !== edit.segments.length) {
    const view = ghostsOf({ ...edit, segments: real.map((item) => item.segment) }, index, used);
    return view.map((ghost) => ({ ...ghost, at: ghost.at >= real.length ? edit.segments.length : real[ghost.at].at }));
  }
  const ghosts: Ghost[] = [];
  for (let at = 1; at < edit.segments.length; at++) {
    const before = edit.segments[at - 1], after = edit.segments[at];
    // A cut is the same source carrying on later; anything else is a jump, and restores nothing.
    if (before.source !== after.source || after.srcIn - before.srcOut <= 1e-6) continue;
    const gap = { at, source: after.source, from: before.srcOut, to: after.srcIn };
    const skipped = between(index, gap.source, gap.from, gap.to);
    if (!skipped.length || skipped.some((word) => used.has(word.id))) continue;
    const turns = speakerTurns(skipped);
    let reached = gap.from;
    turns.forEach((turn, position) => {
      const next = turns[position + 1];
      const from = position === 0 ? gap.from : reached < turn.start ? (reached + turn.start) / 2 : turn.start;
      const to = !next ? gap.to : next.start > turn.end ? (turn.end + next.start) / 2 : turn.end;
      reached = Math.max(reached, turn.end);
      ghosts.push({ id: `g-${turn.words[0].id}`, at: gap.at, source: gap.source, track: turn.track, words: turn.words, from, to: Math.max(from, to) });
    });
  }
  return ghosts;
}

/** What makes two cues the same speech heard twice: most of the shorter one's words, over most of its time. */
const COPY_WORDS = 0.6, COPY_TIME = 0.5;
const wordsOf = (cue: TimelineWord[]) => new Set(cue.map((word) => word.text.toLocaleLowerCase().replace(/[^\p{L}\p{N}']/gu, "")).filter(Boolean));

/** Removed words as speaker turns, bleed copies left out, in time order. */
function speakerTurns(skipped: TimelineWord[]) {
  const cues = new Map<string, TimelineWord[]>();
  for (const word of skipped) {
    if (word.heardOn) continue;
    const key = `${word.track}\n${word.cue ?? word.id}`, cue = cues.get(key);
    if (cue) cue.push(word); else cues.set(key, [word]);
  }
  type Turn = { track: string; words: TimelineWord[]; start: number; end: number; vocabulary: Set<string> };
  const lines: Turn[] = [...cues.values()].map((cue) => ({ track: cue[0].track, words: cue, start: cue[0].start, end: cue[cue.length - 1].end, vocabulary: wordsOf(cue) }))
    .sort((a, b) => a.start - b.start || b.words.length - a.words.length);
  // Only cues still open when a line starts can be its copy, so the sweep stays short.
  const kept: Turn[] = [];
  let open: Turn[] = [];
  for (const line of lines) {
    open = open.filter((other) => other.end > line.start);
    const copy = open.some((other) => {
      if (other.track === line.track) return false;
      const shorter = Math.min(other.end - other.start, line.end - line.start), shared = Math.min(other.end, line.end) - Math.max(other.start, line.start);
      if (shared < COPY_TIME * Math.max(shorter, 1e-3)) return false;
      const small = other.vocabulary.size < line.vocabulary.size ? other.vocabulary : line.vocabulary, large = small === other.vocabulary ? line.vocabulary : other.vocabulary;
      return small.size > 0 && [...small].filter((word) => large.has(word)).length >= COPY_WORDS * small.size;
    });
    if (copy) continue;
    kept.push(line); open.push(line);
  }
  // One speaker's cues in a row are one turn, until a long pause.
  const turns: Turn[] = [];
  for (const line of kept) {
    const last = turns[turns.length - 1];
    if (last && last.track === line.track && line.start - last.end <= PAUSE_BREAK) { last.words = [...last.words, ...line.words]; last.end = Math.max(last.end, line.end); }
    else turns.push({ ...line });
  }
  return turns;
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
  // A segment where some lanes play something else cannot simply grow: the restored range goes in on its own.
  const joinsPrev = prev?.source === source && prev.srcOut >= from - 1e-6 && !prev.overrides;
  const joinsNext = next?.source === source && next.srcIn <= to + 1e-6 && !next.overrides;
  if (joinsPrev && joinsNext && sameTracks(prev, next)) segments.splice(at - 1, 2, { ...prev, id: nextId("seg"), srcIn: prev.srcIn, srcOut: next.srcOut });
  else if (joinsPrev) segments.splice(at - 1, 1, { ...prev, id: nextId("seg"), srcOut: Math.max(prev.srcOut, to) });
  else if (joinsNext) segments.splice(at, 1, { ...next, id: nextId("seg"), srcIn: Math.min(next.srcIn, from) });
  else {
    // On its own, it plays the people the clip it was cut from played, on their tracks there.
    // With neither, every patched lane played it: a middle line brought back every mic.
    const kin = prev?.source === source ? prev : next?.source === source ? next : null;
    segments.splice(at, 0, { id: nextId("seg"), source, srcIn: from, srcOut: to, ...(kin?.tracks ? { tracks: kin.tracks } : {}), ...(kin?.layers ? { layers: kin.layers } : {}) });
  }
  return { ...edit, segments };
}

/** Where each paragraph's words start in the run of placed words. */
export function paragraphStarts(paragraphs: { words: unknown[] }[]): number[] {
  let at = 0;
  return paragraphs.map((paragraph) => { const first = at; at += paragraph.words.length; return first; });
}

/** The paragraph holding word `index`, found by its start; null for no word. */
export function paragraphHolding(starts: number[], index: number | null): number | null {
  if (index == null || index < 0 || !starts.length) return null;
  let low = 0, high = starts.length - 1;
  while (low < high) { const mid = (low + high + 1) >> 1; if (starts[mid] <= index) low = mid; else high = mid - 1; }
  return low;
}

/** A speaker's words as lines: a new line at a pause over 1.2 s or an edit point. */
export function trackPhrases(placed: PlacedWord[], speaker: string | null) {
  const out: { id: string; text: string; startFrame: number; endFrame: number; segment: number; track: string }[] = [];
  for (const item of placed) {
    // `speaker` null: every word given, as a record track holding several people's clips has them.
    if ((speaker != null && item.word.track !== speaker) || item.muted) continue;
    const last = out[out.length - 1];
    if (last && last.segment === item.segment && last.track === item.word.track && item.programStart - last.endFrame < 1.2) { last.text += ` ${item.word.text}`; last.endFrame = item.programEnd; }
    else out.push({ id: placementKey(item), text: item.word.text, startFrame: item.programStart, endFrame: item.programEnd, segment: item.segment, track: item.word.track });
  }
  return out;
}

/**
 * A lane's words laid over its clips (T), with AAF Audio's layout, except
 * that a column holding a single phrase shows the phrase itself rather than
 * "1 passage": the words are the point of T.
 */
export function phraseLabels(placed: PlacedWord[], speaker: string | null, start: number, span: number, width: number) {
  const lines = trackPhrases(placed, speaker);
  return multitrackTextLayout(lines, start, span, width).map((cue) => {
    const line = cue.summary && cue.text === "1 passage" ? lines.find((item) => item.text === cue.title.split("\n")[1]) : undefined;
    if (!line) return cue;
    const from = Math.max(start, line.startFrame), to = Math.min(start + span, line.endFrame);
    return { ...cue, summary: false, text: line.text, style: { left: `${((from - start) / span) * 100}%`, width: `${((to - from) / span) * 100}%` } };
  });
}

/**
 * Who else holds `lane`'s record track in a segment, or null when it is free.
 * A Lift leaves a person's track empty, and an Overwrite can then seat someone
 * else there; bringing the first person back must ask this first, or two
 * people play on one track (drawn as one, played as both, exported as one).
 */
export function trackTakenFrom(segment: TimelineSegment, lane: string, layering: Layering): Placement | null {
  const layer = layerOf(segment, lane, layering);
  if (layer == null) return null;
  const other = playersOf(segment, layering).find((player) => player.lane !== lane && player.layer === layer);
  return other ? { lane: other.lane, layer } : null;
}

/**
 * Undo a Lift on one lane over a program range: the lane plays its segments'
 * own clips there again. Where that leaves a cut the Lift made with the same
 * clip running on through it, the two sides join again. Given the layering,
 * a segment where someone else now holds the lane's track is left lifted
 * (trackTakenFrom); callers say so rather than rely on that.
 */
export function unliftOnTrack(edit: Timeline, programIn: number, programOut: number, lane: string, layering?: Layering): Timeline {
  if (programOut <= programIn) return edit;
  const first = splitAt(edit, programIn), second = splitAt(first.edit, programOut);
  const segments = [...second.edit.segments];
  let changed = false;
  for (let index = first.index; index < second.index; index++) {
    const segment = segments[index];
    if (segment.overrides?.[lane]?.source !== null) continue;
    if (layering && trackTakenFrom(segment, lane, layering)) continue;
    changed = true;
    const { [lane]: _restored, ...rest } = segment.overrides!;
    const { overrides: _old, ...plain } = segment;
    segments[index] = Object.keys(rest).length ? { ...plain, overrides: rest } : plain;
  }
  if (!changed) return edit;
  let next: Timeline = { ...second.edit, segments };
  // The far seam first, so the near one's index still holds. Only a through
  // edit joins: healing a real cut would bring back the source it skipped.
  for (const seam of [second.index, first.index]) {
    const before = next.segments[seam - 1], after = next.segments[seam];
    if (before && after && Math.abs(after.srcIn - before.srcOut) < 1e-6) next = healSeam(next, seam);
  }
  return next;
}

/**
 * How much of a lane to restore for words lifted on it, [from, to) in program
 * time: out from the words to the next lifted word of theirs either side, or
 * to where the lift ends. Restoring every lifted word of a Lift brings the
 * whole of it back, air included, and restoring one brings back that word and
 * the air around it without its neighbours.
 */
export function liftedAround(edit: Timeline, placed: PlacedWord[], lane: string, from: number, to: number): [number, number] {
  const starts = segmentStarts(edit);
  const lifted = (index: number) => edit.segments[index]?.overrides?.[lane]?.source === null;
  let first = edit.segments.findIndex((segment, index) => starts[index] + segmentLength(segment) > from + 1e-9);
  let last = first;
  if (first < 0 || !lifted(first)) return [from, to];
  while (first > 0 && lifted(first - 1)) first--;
  while (last + 1 < edit.segments.length && lifted(last + 1) && starts[last + 1] < to) last++;
  while (last + 1 < edit.segments.length && lifted(last + 1)) last++;
  let start = starts[first], end = starts[last] + segmentLength(edit.segments[last]);
  for (const item of placed) {
    if (item.word.track !== lane || !item.muted || item.voice != null) continue;
    if (item.programEnd <= from + 1e-9 && item.programEnd > start) start = item.programEnd;
    if (item.programStart >= to - 1e-9 && item.programStart < end) end = item.programStart;
  }
  return [Math.min(start, from), Math.max(end, to)];
}

/**
 * Add Edit on some record tracks (Neo's ⌘K and blade, Avid's Add Edit): a
 * cut at `at` on each of `layers` whose clip runs through it, and nowhere
 * else. Null when there is nothing to cut: no clip crosses there on those
 * tracks, or each already has an edit there.
 */
export function addCut(edit: Timeline, at: number, layers: number[], layering: Layering): Timeline | null {
  const split = splitAt(edit, at);
  const segments = [...split.edit.segments], prev = segments[split.index - 1], next = segments[split.index];
  if (!prev || !next) return null;
  const before = playersOf(prev, layering);
  const lanes = playersOf(next, layering).filter((player) => layers.includes(player.layer) && !next.cuts?.includes(player.lane)
    && before.some((other) => other.lane === player.lane && other.layer === player.layer && other.play.source === player.play.source
      && Math.abs(other.play.srcOut - player.play.srcIn) < 1e-6)).map((player) => player.lane);
  if (!lanes.length) return null;
  segments[split.index] = { ...next, cuts: [...(next.cuts ?? []), ...lanes] };
  return { ...split.edit, segments };
}

/** One stretch of a lane: a run of segments it plays continuously from one source range. */
export type LaneClip = { from: number; to: number; source: string; srcIn: number; srcOut: number; first: number; last: number };

/**
 * What a lane plays, as clips: consecutive segments that carry on the same
 * source range join into one, the way a track in Avid shows one clip until
 * an edit actually changes what that track plays. A cut on another lane
 * alone is not a cut here. Lifted stretches and gaps are simply absent.
 */
export function laneClips(edit: Timeline, lane: string): LaneClip[] {
  const out: LaneClip[] = [];
  let at = 0;
  edit.segments.forEach((segment, index) => {
    const length = segmentLength(segment), play = lanePlay(segment, lane);
    const last = out[out.length - 1];
    if (play && last && last.last === index - 1 && last.source === play.source && Math.abs(last.srcOut - play.srcIn) < 1e-6) {
      last.to = at + length; last.srcOut = play.srcOut; last.last = index;
    } else if (play) out.push({ from: at, to: at + length, source: play.source, srcIn: play.srcIn, srcOut: play.srcOut, first: index, last: index });
    at += length;
  });
  return out;
}

/**
 * Remove words the way the Ask panel's proposals do: words nobody talks over
 * are cut (the time closes up on every track); a word someone else talks
 * under is silenced on its own track instead, so their words stay. The same
 * rule a delete in the text follows, applied without asking. With
 * `leaveUnder`, a word someone talks under is left as it is: tightening a
 * cut takes out an "um" only where it can take it cleanly.
 */
export function removeWithoutCuttingOvertalk(words: TimelineWord[], edit: Timeline, ids: Set<string>, leaveUnder = false): Timeline {
  // Overtalk is someone ELSE's words in the cut where it plays, as deleteWords
  // counts it: a word in the source that nobody cut in (a person who is not in
  // the clip) is not in the way. Counting the whole source made a bite string
  // out silence lines it should have cut, and was quadratic in the words.
  const placed = placeWords(words, edit), bySegment = new Map<number, PlacedWord[]>();
  for (const item of placed) {
    if (ids.has(item.word.id) || item.word.heardOn) continue;
    const list = bySegment.get(item.segment);
    if (list) list.push(item); else bySegment.set(item.segment, [item]);
  }
  const under = new Set<string>();
  for (const item of placed) {
    if (!ids.has(item.word.id)) continue;
    if ((bySegment.get(item.segment) ?? []).some((other) => other.word.track !== item.word.track && other.programStart < item.programEnd && other.programEnd > item.programStart)) under.add(item.word.id);
  }
  const cut = deleteWords(words, edit, new Set(placed.filter((item) => ids.has(item.word.id) && !under.has(item.word.id)).map(placementKey)));
  return under.size && !leaveUnder ? muteWords(words, cut.edit, under) : cut.edit;
}

/**
 * The parts of a segment a track actually plays: the segment's source range
 * with that track's silenced ranges taken out. The timeline draws each part
 * as its own clip, so a lifted range reads as a hole in the clip, the way the
 * exported AAF writes it (filler on that track between two source clips).
 */
export function clipPieces(segment: { srcIn: number; srcOut: number }, silenced: [number, number][]): { srcIn: number; srcOut: number }[] {
  let pieces = [{ srcIn: segment.srcIn, srcOut: segment.srcOut }];
  for (const [from, to] of silenced) {
    pieces = pieces.flatMap((piece) => to <= piece.srcIn || from >= piece.srcOut ? [piece]
      : [{ srcIn: piece.srcIn, srcOut: Math.max(piece.srcIn, from) }, { srcIn: Math.min(piece.srcOut, to), srcOut: piece.srcOut }]);
  }
  return pieces.filter((piece) => piece.srcOut - piece.srcIn > 1e-6);
}
