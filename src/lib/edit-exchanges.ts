import type { EditDocument } from "../bindings/EditDocument";
import type { EditMarker } from "../bindings/EditMarker";
import type { EditSegment } from "../bindings/EditSegment";
import type { TimelineWord } from "./edit-model";

/**
 * Conversations, bundled (owner request, 2026-10-07). A back-and-forth used
 * to be laid out one mic per bite: Donny's line on his track with Gilio's
 * silent under it, a second of filler, then Gilio's reply on his. Measured on
 * "Twins Rivalry Before The Fall": 53 of 72 one-second gaps sat inside
 * continuous exchanges, 325 words said into the silenced mic were heard only
 * as bleed or not at all, and 215 words were cut mid-word at a bite's edge.
 *
 * So a run of stretches from one source, each starting within `join` seconds
 * of the last (or inside it), is ONE exchange: one segment over the whole run
 * with every participant's mic open, and overlap and reactions play as they
 * happened. The mics are tracks of the same sequence, so one in and out frame
 * serves all of them and they cannot drift. Filler goes between exchanges
 * only, and an exchange's edges move out of any word on an open mic rather
 * than cutting it.
 */

/** A stretch of one source that plays on some people's tracks, in source seconds. `alone` never joins an exchange. */
export type Stretch = { source: string; lanes: string[]; from: number; to: number; alone?: boolean };
/** Stretches of one conversation: the source range they cover, who speaks in it, and which stretches they were. */
export type Exchange = { source: string; from: number; to: number; lanes: string[]; members: number[]; alone: boolean };
/** Where an exchange lands in its source, in frames, and every mic that plays it. */
export type Placement = { inFrame: number; outFrame: number; lanes: string[] };

/** How far an edge may move to get out of a word, in seconds. */
const SNAP_LIMIT = 1.5;
/** A word on a listener's mic this close to the same word on a speaker's is one utterance heard on two mics. */
const ECHO = 0.4;
/** Frame rounding slack: a position read back from frames must floor and ceil to the frame it came from. */
const SLACK = 1e-6;

export const plainWord = (text: string) => text.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

/** Stretches in the order given, merged into exchanges: same source, and each within `join` seconds of the run so far. */
export function exchangesOf(stretches: Stretch[], join: number): Exchange[] {
  const exchanges: Exchange[] = [];
  stretches.forEach((stretch, index) => {
    const last = exchanges[exchanges.length - 1];
    if (last && !last.alone && !stretch.alone && last.source === stretch.source && stretch.from <= last.to + join && stretch.to >= last.from - join) {
      last.from = Math.min(last.from, stretch.from);
      last.to = Math.max(last.to, stretch.to);
      for (const lane of stretch.lanes) if (!last.lanes.includes(lane)) last.lanes.push(lane);
      last.members.push(index);
      return;
    }
    exchanges.push({ source: stretch.source, from: stretch.from, to: stretch.to, lanes: [...stretch.lanes], members: [index], alone: !!stretch.alone });
  });
  return exchanges;
}

/**
 * Who else talks in a stretch on their own mic: a word of theirs in it that
 * the bleed resolver has not marked as someone else's, and that no speaker's
 * mic has at the same moment (without bleed labels, that is the speaker
 * heard on the listener's mic, not the listener).
 */
export function listenersOf(source: string, from: number, to: number, speakers: string[], candidates: string[], words: TimelineWord[]): string[] {
  const inside = words.filter((word) => word.source === source && word.end > from && word.start < to);
  const spoken = inside.filter((word) => speakers.includes(word.track));
  return candidates.filter((lane) => !speakers.includes(lane) && inside.some((word) => word.track === lane && !word.heardOn
    && !spoken.some((said) => Math.abs(said.start - word.start) < ECHO && plainWord(said.text) === plainWord(word.text))));
}

/** A range moved out of any word it would cut on the given mics, by at most SNAP_LIMIT seconds a side. */
export function clearOfWords(from: number, to: number, mics: TimelineWord[]): [number, number] {
  let start = from, end = to;
  for (let pass = 0; pass < 8; pass++) {
    const head = mics.find((word) => word.start < start && word.end > start);
    const tail = mics.find((word) => word.start < end && word.end > end);
    if (!head && !tail) break;
    if (head) start = Math.max(from - SNAP_LIMIT, head.start);
    if (tail) end = Math.min(to + SNAP_LIMIT, tail.end);
  }
  return [start, end];
}

type PlaceOptions = {
  fps: number; head: number; tail: number;
  /** The source's last frame, or Infinity when its length is unknown. */
  end: number;
  words: TimelineWord[];
  /** People who may join as listeners: those the string out is about. */
  candidates: string[];
  /** The last exchange of this source: going forward, a head never replays its tail. */
  previous?: { inFrame: number; outFrame: number };
};

/** One exchange in frames: handles, listeners, edges clear of words on every open mic. Null when nothing is left. */
export function placeExchange(exchange: Exchange, options: PlaceOptions): Placement | null {
  const { fps, head, tail, end, words, previous } = options;
  const from = exchange.from - head, to = exchange.to + tail;
  const lanes = [...exchange.lanes, ...listenersOf(exchange.source, from, to, exchange.lanes, options.candidates, words)];
  const mics = words.filter((word) => word.source === exchange.source && lanes.includes(word.track));
  const [start, stop] = clearOfWords(from, to, mics);
  const wanted = Math.max(0, Math.floor(start * fps + SLACK));
  const inFrame = previous && wanted >= previous.inFrame ? Math.max(wanted, previous.outFrame) : wanted;
  const outFrame = Math.min(end, Math.ceil(stop * fps - SLACK));
  return outFrame > inFrame ? { inFrame, outFrame, lanes } : null;
}

const frames = (segment: EditSegment) => segment.kind === "gap" ? segment.frames : segment.out_frame - segment.in_frame;

/**
 * An existing string out with its conversations stacked: every run of clips
 * from one source that runs on from the last becomes one clip with everyone
 * in it on their own track, the filler between them goes, and the filler
 * between exchanges stays as it was. A clip with a track of its own changed
 * (an override) or one that already plays every track is left exactly as it
 * is. Markers move with the source frame they sit on. `stacked` counts the
 * exchanges that changed; zero means the document came back untouched.
 */
export function stackConversations(document: EditDocument, words: TimelineWord[], lengths: Record<string, number>, join: number): { document: EditDocument; stacked: number } {
  const rate = document.edit_rate, fps = rate.numerator / rate.denominator;
  const where: { segment: EditSegment; at: number }[] = [];
  let at = 0;
  for (const segment of document.segments) { where.push({ segment, at }); at += frames(segment); }
  const clips = where.flatMap((item, index) => item.segment.kind === "source" ? [{ ...item, index }] : []);
  const stretches: Stretch[] = clips.map(({ segment }) => segment.kind === "source"
    ? { source: segment.source, lanes: segment.tracks ?? [], from: segment.in_frame / fps, to: segment.out_frame / fps, alone: !segment.tracks || !!segment.overrides }
    : { source: "", lanes: [], from: 0, to: 0, alone: true });
  const candidates = [...new Set(clips.flatMap(({ segment }) => segment.kind === "source" ? segment.tracks ?? [] : []))];
  const exchanges = exchangesOf(stretches, join);

  const segments: EditSegment[] = [];
  // Old segment index to [new record start, source frame at that start, length], for markers.
  const moved = new Map<number, { at: number; inFrame: number; length: number }>();
  const last = new Map<string, { inFrame: number; outFrame: number }>();
  let stacked = 0, cursor = 0, next = 0;
  const keepGaps = (until: number) => {
    for (; next < until; next++) {
      const segment = document.segments[next];
      if (segment.kind === "gap") { segments.push(segment); cursor += segment.frames; }
    }
  };
  for (const exchange of exchanges) {
    const members = exchange.members.map((member) => clips[member]);
    keepGaps(members[0].index);
    const first = members[0].segment;
    const placed = exchange.alone || first.kind !== "source" ? null : placeExchange(exchange, {
      fps, head: 0, tail: 0, end: lengths[exchange.source] != null ? Math.floor(lengths[exchange.source] * fps) : Infinity,
      words, candidates, previous: last.get(exchange.source),
    });
    const changed = placed !== null && (members.length > 1 || placed.lanes.length > exchange.lanes.length
      || (first.kind === "source" && (placed.inFrame !== first.in_frame || placed.outFrame !== first.out_frame)));
    if (!changed || first.kind !== "source" || !placed) {
      for (const member of members) {
        const segment = member.segment;
        if (segment.kind !== "source") continue;
        moved.set(member.index, { at: cursor, inFrame: segment.in_frame, length: frames(segment) });
        segments.push(segment); cursor += frames(segment);
        last.set(segment.source, { inFrame: segment.in_frame, outFrame: segment.out_frame });
      }
      next = members[members.length - 1].index + 1;
      continue;
    }
    stacked++;
    // Each person keeps the record track they were on; a through edit inside the run has nothing left to divide.
    const layers: { [lane: string]: number } = {};
    for (const { segment } of members) if (segment.kind === "source") Object.assign(layers, segment.layers ?? {});
    const segment: EditSegment = { kind: "source", id: first.id, source: first.source, in_frame: placed.inFrame, out_frame: placed.outFrame,
      tracks: placed.lanes, ...(Object.keys(layers).length ? { layers } : {}) };
    for (const member of members) moved.set(member.index, { at: cursor, inFrame: placed.inFrame, length: placed.outFrame - placed.inFrame });
    segments.push(segment); cursor += placed.outFrame - placed.inFrame;
    last.set(exchange.source, placed);
    // The filler that sat between this exchange's clips is gone with them.
    next = members[members.length - 1].index + 1;
  }
  keepGaps(document.segments.length);
  if (!stacked) return { document, stacked: 0 };

  const markers: EditMarker[] = document.markers.map((marker) => {
    // The clip it sits on, or the next one when it sits on filler.
    const home = where.findIndex((item, index) => item.segment.kind === "source" && moved.has(index) && marker.frame < item.at + frames(item.segment));
    if (home < 0) return { ...marker, frame: Math.min(marker.frame, Math.max(0, cursor - 1)) };
    const old = where[home], landed = moved.get(home)!;
    const source = old.segment.kind === "source" ? old.segment.in_frame + Math.max(0, marker.frame - old.at) : landed.inFrame;
    return { ...marker, frame: landed.at + Math.min(landed.length - 1, Math.max(0, source - landed.inFrame)) };
  }).sort((a, b) => a.frame - b.frame);
  return { document: { ...document, segments, markers }, stacked };
}
