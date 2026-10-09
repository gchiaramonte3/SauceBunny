import type { EditDocument } from "../bindings/EditDocument";
import type { EditMarker } from "../bindings/EditMarker";
import type { EditSegment } from "../bindings/EditSegment";
import { fromDocument, rippleMarkers, toDocument } from "./edit-document";
import { exchangesOf, placeExchange, plainWord } from "./edit-exchanges";
import { focusOnMarkers } from "./edit-focus";
import { placeWords, removeWithoutCuttingOvertalk, type TimelineWord } from "./edit-model";
import { giveTracks } from "./edit-new";
import { MARKER_COLORS, snippet, type EditBite } from "./edit-stringout";

/**
 * A story cut: an idea turned into beats, each a run of lines in play order
 * (docs/STORY-CUT-SPEC-2026-10-08.md). A string out is selects, every bite
 * a second apart with long handles; a cut plays. Its lines butt together
 * within a beat with short handles, a beat ends on a short pause, and the
 * fillers inside its lines come out.
 *
 * The model chooses the lines and their order and never writes a timecode;
 * this lays them out. The rules below are the ones `measure_cut` times a cut
 * with (src-tauri/src/context/cuts.rs), so the running time the model fitted
 * is the one laid out, give or take the edges moving out of words.
 */
export const CUT_HEAD_SECONDS = 0.25;
export const CUT_TAIL_SECONDS = 0.5;
export const CUT_JOIN_SECONDS = 2;
export const CUT_BEAT_PAUSE_SECONDS = 1;

/** One line of a cut: where it was said, and its words when it was cited from the transcript. */
export type StoryLine = EditBite & { wordIds?: string[] };
export type StoryBeat = { title: string; purpose?: string; lines: StoryLine[] };
export type StoryCut = { title: string; target: number | null; beats: StoryBeat[] };

/**
 * The cut as a new sequence: per beat, its lines joined into stretches where
 * they follow each other in one source (a conversation stays one clip with
 * everyone in it on their own track, as Ask's string outs do), stretches
 * butted together, a pause between beats, and a marker on every line, the
 * first of each beat naming the beat. Patched from nothing, focused on the
 * people the markers name, then tightened (`tightenCut`). `trimmed` counts
 * the fillers taken out.
 */
export function layoutStoryCut(base: EditDocument, cut: StoryCut, lengths: Record<string, number>, words: TimelineWord[] = []): { document: EditDocument; trimmed: number } {
  const rate = base.edit_rate, fps = rate.numerator / rate.denominator;
  const lanes = new Set(base.tracks.map((track) => track.id));
  const beats = cut.beats.map((beat) => ({ ...beat, lines: beat.lines.filter((line) => base.sources.some((source) => source.id === line.source)) }));
  const candidates = [...new Set(beats.flatMap((beat) => beat.lines.map((line) => line.track)).filter((lane) => lanes.has(lane)))];
  const pause = Math.round(CUT_BEAT_PAUSE_SECONDS * fps);
  const segments: EditSegment[] = [], markers: EditMarker[] = [];
  const last = new Map<string, { inFrame: number; outFrame: number }>();
  let at = 0;
  beats.forEach((beat, index) => {
    const exchanges = exchangesOf(beat.lines.map((line) => ({ source: line.source, lanes: lanes.has(line.track) ? [line.track] : [], from: line.from, to: line.to })), CUT_JOIN_SECONDS);
    let named = false;
    for (const exchange of exchanges) {
      const end = lengths[exchange.source] != null ? Math.floor(lengths[exchange.source] * fps) : Infinity;
      const placed = placeExchange(exchange, { fps, head: CUT_HEAD_SECONDS, tail: CUT_TAIL_SECONDS, end, words, candidates, previous: last.get(exchange.source) });
      if (!placed) continue;
      // A beat ends on a pause; within one, the stretches butt together.
      if (!named && segments.length) { segments.push({ kind: "gap", id: `pause-${index}`, frames: pause }); at += pause; }
      const length = placed.outFrame - placed.inFrame;
      segments.push({ kind: "source", id: `cut-${index}-${exchange.members[0]}`, source: exchange.source, in_frame: placed.inFrame, out_frame: placed.outFrame,
        ...(placed.lanes.length ? { tracks: placed.lanes } : {}) });
      for (const member of exchange.members) {
        const line = beat.lines[member], person = base.tracks.findIndex((track) => track.id === line.track), lane = base.tracks[person];
        const offset = Math.min(length - 1, Math.max(0, Math.floor((line.from - CUT_HEAD_SECONDS) * fps) - placed.inFrame));
        // One marker a line; the beat's first line also names the beat, so a beat change reads in Avid's marker list.
        const comment = named ? snippet(line.text) : snippet(`Beat ${index + 1} · ${beat.title.trim() || "Untitled"}: ${line.text}`);
        markers.push({ id: `cut-${index}-${member}`, frame: at + offset, track: lane?.id ?? null, name: lane?.name ?? "Bite", comment,
          color: MARKER_COLORS[Math.max(0, person) % MARKER_COLORS.length] });
        named = true;
      }
      at += length;
      last.set(exchange.source, placed);
    }
  });
  markers.sort((a, b) => a.frame - b.frame);
  const unpatched = { ...base, tracks: base.tracks.map((lane) => ({ ...lane, featured: false })) };
  const laid = focusOnMarkers({ ...giveTracks(unpatched, segments.flatMap((segment) => segment.kind === "source" ? segment.tracks ?? [] : [])),
    title: cut.title.trim() || base.title, segments, mutes: [], markers }).document;
  const cited = new Set(beats.flatMap((beat) => beat.lines.flatMap((line) => line.wordIds ?? [])));
  return tightenCut(laid, words, cited);
}

/** Words that only fill: taken out of a cut's lines wherever they are said alone. */
export const FILLERS: ReadonlySet<string> = new Set(["um", "umm", "uh", "uhh", "uhm", "erm", "er"]);
/**
 * Small words a stammer repeats ("I I went", "the the bet"): the first of
 * two in a row comes out. Only these: "go go go" in a crowd and "no, no" in
 * an argument are said on purpose.
 */
export const STAMMERS: ReadonlySet<string> = new Set(["i", "i'm", "a", "an", "the", "and", "but", "so", "to", "of", "in", "it", "it's", "we", "you", "he", "she", "they", "my", "that", "is", "was"]);
/** Two words closer than this, in seconds, are one stammer. */
const STAMMER_GAP = 0.5;

/**
 * Which of the cited words are fillers or a stammer's first word, line by
 * line: only within one line of one person, and only between words that
 * follow each other there, so nothing is ever joined across a line or from
 * two moments.
 */
export function fillersIn(words: TimelineWord[], cited: Set<string>): Set<string> {
  const lines = new Map<string, TimelineWord[]>();
  for (const word of words) {
    if (!cited.has(word.id)) continue;
    const key = `${word.source}\n${word.track}\n${word.cue ?? word.id}`, line = lines.get(key);
    if (line) line.push(word); else lines.set(key, [word]);
  }
  const out = new Set<string>();
  for (const line of lines.values()) {
    line.sort((a, b) => a.start - b.start);
    line.forEach((word, index) => {
      const plain = plainWord(word.text), next = line[index + 1];
      if (FILLERS.has(plain)) out.add(word.id);
      else if (next && STAMMERS.has(plain) && plainWord(next.text) === plain && next.start - word.end < STAMMER_GAP) out.add(word.id);
    });
  }
  return out;
}

/**
 * The cut with its lines' fillers taken out where nobody talks under them,
 * each cut closing up like a delete and showing as a removed line that
 * Restore puts back. A filler someone talks over stays.
 */
export function tightenCut(document: EditDocument, words: TimelineWord[], cited: Set<string>): { document: EditDocument; trimmed: number } {
  const ids = fillersIn(words, cited);
  if (!ids.size) return { document, trimmed: 0 };
  const playing = new Set(document.tracks.filter((track) => track.featured !== false).map((track) => track.id));
  const heard = words.filter((word) => playing.has(word.track));
  const opened = fromDocument(document);
  const timeline = removeWithoutCuttingOvertalk(heard, opened.timeline, ids, true);
  const still = new Set(placeWords(heard, timeline).map((item) => item.word.id));
  const trimmed = [...ids].filter((id) => !still.has(id)).length;
  if (!trimmed) return { document, trimmed: 0 };
  return { document: toDocument(document, timeline, rippleMarkers(opened.timeline, timeline, opened.markers)), trimmed };
}

/** A cut's running time in seconds as laid out. */
export function cutSeconds(document: EditDocument): number {
  const rate = document.edit_rate;
  const frames = document.segments.reduce((sum, segment) => sum + (segment.kind === "gap" ? segment.frames : segment.out_frame - segment.in_frame), 0);
  return frames * rate.denominator / rate.numerator;
}

/**
 * How long a cut of these beats runs, by the rules `measure_cut` times it with
 * (lines in one source close together play as one stretch, a handle each
 * side, a pause between beats): what the model was fitting to, shown on the
 * proposal before anything is built.
 */
export function estimateCut(beats: { lines: { source: string; from: number; to: number }[] }[]): { seconds: number; beats: number[] } {
  const each = beats.map((beat) => {
    const stretches: { source: string; from: number; to: number }[] = [];
    for (const line of beat.lines) {
      const last = stretches[stretches.length - 1];
      if (last && last.source === line.source && line.from <= last.to + CUT_JOIN_SECONDS && line.to >= last.from - CUT_JOIN_SECONDS) {
        last.from = Math.min(last.from, line.from); last.to = Math.max(last.to, line.to);
      } else stretches.push({ ...line });
    }
    return stretches.reduce((sum, stretch) => sum + stretch.to - stretch.from + CUT_HEAD_SECONDS + CUT_TAIL_SECONDS, 0);
  });
  const playing = beats.filter((beat) => beat.lines.length).length;
  return { seconds: each.reduce((sum, seconds) => sum + seconds, 0) + CUT_BEAT_PAUSE_SECONDS * Math.max(0, playing - 1), beats: each };
}
