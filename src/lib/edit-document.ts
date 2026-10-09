import type { AafSpeech } from "../bindings/AafSpeech";
import type { EditDocument } from "../bindings/EditDocument";
import type { EditMarker } from "../bindings/EditMarker";
import type { EditOverride } from "../bindings/EditOverride";
import type { EditRate } from "../bindings/EditRate";
import type { EditSegment } from "../bindings/EditSegment";
import { GAP, isGap, lanePlay, programToSource, segmentLength, segmentStarts, type LaneOverride, type SourceSpan, type Timeline, type TimelineSegment, type TimelineWord } from "./edit-model";
import { framesToTc, secondsToFrames } from "./timecode";

/**
 * The boundary between the edit model (seconds, as the approved prototype
 * works) and the saved document (whole frames, as Avid works). Every boundary
 * is snapped to a frame on the way out, so a saved edit can never hold a
 * subframe cut, and whatever plays is exactly what Avid will get.
 */

/**
 * The document format edit_doc.rs reads. The undo log refuses a newer one on
 * open (edit_log.rs), which is where the downgrade guard for this format lives.
 * A string out is stamped with the oldest version that can hold it: 1, unless
 * a track was edited alone or a clip names its record tracks, which needs 2
 * (edit_doc.rs `OVERRIDES_SCHEMA_VERSION`).
 * So every string out that does not use it still opens in an older build,
 * and one that does is refused there rather than opened without its overrides.
 */
export const EDIT_SCHEMA_VERSION = 1;
export const OVERRIDES_SCHEMA_VERSION = 2;

export const fps = (rate: EditRate) => rate.numerator / rate.denominator;

/** Timecode of a program position, counted in frames from the record start. */
export const editTc = (seconds: number, framesPerSecond: number, recordStart: number) =>
  framesToTc(recordStart + secondsToFrames(seconds, framesPerSecond), framesPerSecond);
export const toFrames = (seconds: number, rate: EditRate) => Math.round((seconds * rate.numerator) / rate.denominator);
export const toSeconds = (frames: number, rate: EditRate) => (frames * rate.denominator) / rate.numerator;

/** A marker in program seconds, as the editor holds it. */
export type TimelineMarker = { id: string; at: number; track: string | null; name: string; comment: string; color: string };

/**
 * Markers ride on the material under them, as Avid's do: a change that moves
 * that material moves the marker, and one that removes it removes the marker.
 * A source range that plays twice keeps the marker on the appearance nearest
 * where it was. A marker on someone's track rides on what THEY play there,
 * which an overwrite on their track alone can make other than the clip's own.
 */
export function rippleMarkers(before: Timeline, after: Timeline, markers: TimelineMarker[]): TimelineMarker[] {
  if (before.segments === after.segments || !markers.length) return markers;
  const was = segmentStarts(before), now = segmentStarts(after);
  const material = (segment: TimelineSegment, lane: string | null): SourceSpan | null =>
    isGap(segment) ? null : (lane ? lanePlay(segment, lane) : null) ?? { source: segment.source, srcIn: segment.srcIn, srcOut: segment.srcOut };
  return markers.flatMap((marker) => {
    const under = programToSource(before, marker.at);
    if (!under) return [];
    const segment = before.segments[under.segment], offset = marker.at - was[under.segment];
    const mine = material(segment, marker.track), at = mine ? mine.srcIn + offset : 0;
    let best: number | null = null;
    after.segments.forEach((next, index) => {
      const there = material(next, marker.track);
      const position = !mine
        ? next.id === segment.id && offset <= segmentLength(next) + 1e-6 ? now[index] + offset : null
        : there && there.source === mine.source && at >= there.srcIn - 1e-6 && at <= there.srcOut + 1e-6 ? now[index] + at - there.srcIn : null;
      if (position != null && (best == null || Math.abs(position - marker.at) < Math.abs(best - marker.at))) best = position;
    });
    return best == null ? [] : [{ ...marker, at: best }];
  });
}

/** The document as the editor works on it: the model plus what rides along. */
export type OpenEdit = { document: EditDocument; timeline: Timeline; markers: TimelineMarker[] };

export function fromDocument(document: EditDocument): OpenEdit {
  const rate = document.edit_rate;
  const segments = document.segments.map((segment) => segment.kind === "gap"
    ? { id: segment.id, source: GAP, srcIn: 0, srcOut: toSeconds(segment.frames, rate) }
    : { id: segment.id, source: segment.source, srcIn: toSeconds(segment.in_frame, rate), srcOut: toSeconds(segment.out_frame, rate), ...(segment.tracks ? { tracks: segment.tracks } : {}),
      ...(segment.overrides ? { overrides: Object.fromEntries(Object.entries(segment.overrides).flatMap(([lane, over]) => !over ? []
        : [[lane, over.source == null ? { source: null } : { source: over.source, srcIn: toSeconds(over.in_frame, rate) }] as [string, LaneOverride]])) } : {}),
      ...(segment.layers ? { layers: Object.fromEntries(Object.entries(segment.layers).flatMap(([lane, layer]) => layer == null ? [] : [[lane, layer]])) } : {}),
      ...(segment.cuts?.length ? { cuts: segment.cuts } : {}) });
  const mutes = document.mutes.map((mute) => ({ source: mute.source, track: mute.track, srcIn: toSeconds(mute.in_frame, rate), srcOut: toSeconds(mute.out_frame, rate) }));
  const markers = document.markers.map((marker) => ({ id: marker.id, at: toSeconds(marker.frame, rate), track: marker.track, name: marker.name, comment: marker.comment, color: marker.color }));
  return { document, timeline: { segments, mutes }, markers };
}

/**
 * The saved form of a model state. Segments snap to the nearest frame and any
 * that round to nothing are dropped; a silenced range snaps OUTWARD, so it
 * still covers every word it was made to silence.
 */
export function toDocument(base: EditDocument, timeline: Timeline, markers: TimelineMarker[]): EditDocument {
  const rate = base.edit_rate;
  const segments: EditSegment[] = [];
  const lanes = new Set(base.tracks.map((track) => track.id));
  for (const segment of timeline.segments) {
    if (segment.source === GAP) {
      const frames = toFrames(segment.srcOut - segment.srcIn, rate);
      if (frames > 0) segments.push({ kind: "gap", id: segment.id, frames });
    } else {
      const inFrame = toFrames(segment.srcIn, rate), outFrame = toFrames(segment.srcOut, rate);
      // A clip's own track list, minus any lane the string out no longer has.
      const tracks = segment.tracks?.filter((lane) => lanes.has(lane));
      const kept = Object.entries(segment.overrides ?? {}).filter(([lane]) => lanes.has(lane));
      const overrides: Record<string, EditOverride> = Object.fromEntries(kept.map(([lane, over]) =>
        [lane, over.source == null ? { source: null, in_frame: 0 } : { source: over.source, in_frame: Math.max(0, toFrames(over.srcIn, rate)) }]));
      const layers = Object.fromEntries(Object.entries(segment.layers ?? {}).filter(([lane]) => lanes.has(lane)));
      const cuts = (segment.cuts ?? []).filter((lane) => lanes.has(lane));
      if (outFrame > inFrame) segments.push({ kind: "source", id: segment.id, source: segment.source, in_frame: Math.max(0, inFrame), out_frame: outFrame,
        ...(tracks ? { tracks } : {}), ...(kept.length ? { overrides } : {}), ...(Object.keys(layers).length ? { layers } : {}), ...(cuts.length ? { cuts } : {}) });
    }
  }
  const total = segments.reduce((sum, segment) => sum + (segment.kind === "gap" ? segment.frames : segment.out_frame - segment.in_frame), 0);
  const mutes = timeline.mutes.map((mute) => ({
    source: mute.source, track: mute.track,
    in_frame: Math.max(0, Math.floor((mute.srcIn * rate.numerator) / rate.denominator)),
    out_frame: Math.ceil((mute.srcOut * rate.numerator) / rate.denominator),
  })).filter((mute) => mute.out_frame > mute.in_frame);
  const saved: EditMarker[] = markers.map((marker) => ({ id: marker.id, frame: Math.min(total, Math.max(0, toFrames(marker.at, rate))), track: marker.track, name: marker.name, comment: marker.comment, color: marker.color }));
  const schema = segments.some((segment) => segment.kind === "source" && (segment.overrides || segment.layers || segment.cuts)) ? OVERRIDES_SCHEMA_VERSION : EDIT_SCHEMA_VERSION;
  return { ...base, schema_version: schema, segments, mutes, markers: saved };
}

/**
 * An AAF Audio track's analysed words as model words: `source` and `track`
 * are the EDIT's ids. Cue positions are 16 kHz samples from the sequence
 * start, so seconds are samples / 16000.
 */
/**
 * A mic's analysed words as String Outs words. `heardOn` answers, for a word's
 * cue and its place in that cue, which mic the bleed resolver says it was
 * really spoken into (accuracy spec, phase 3); the resolver indexes words
 * within their cue the same way.
 */
export function wordsFromSpeech(speech: AafSpeech, source: string, track: string, heardOn?: (cue: string, index: number) => string | undefined): TimelineWord[] {
  const inCue = new Map<string, number>();
  return speech.words.map((word, index) => {
    const at = inCue.get(word.cue_id) ?? 0;
    inCue.set(word.cue_id, at + 1);
    const heard = heardOn?.(word.cue_id, at);
    return {
      id: `${source}:${track}:${word.cue_id}:${index}`, source, track, text: word.text,
      start: word.start_sample / 16_000, end: word.end_sample / 16_000, cue: word.cue_id,
      ...(heard ? { heardOn: heard } : {}),
    };
  });
}

/** Where a mic is audible, in source seconds, for dead-space detection. */
export function audibleSpans(speech: AafSpeech): [number, number][] {
  return [...speech.activity, ...speech.reactions].map(([from, to]) => [from / 16_000, to / 16_000]);
}
