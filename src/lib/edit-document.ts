import type { AafSpeech } from "../bindings/AafSpeech";
import type { EditDocument } from "../bindings/EditDocument";
import type { EditMarker } from "../bindings/EditMarker";
import type { EditRate } from "../bindings/EditRate";
import type { EditSegment } from "../bindings/EditSegment";
import { GAP, isGap, programToSource, segmentLength, segmentStarts, type Timeline, type TimelineWord } from "./edit-model";
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
 */
export const EDIT_SCHEMA_VERSION = 1;

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
 * where it was.
 */
export function rippleMarkers(before: Timeline, after: Timeline, markers: TimelineMarker[]): TimelineMarker[] {
  if (before.segments === after.segments || !markers.length) return markers;
  const was = segmentStarts(before), now = segmentStarts(after);
  return markers.flatMap((marker) => {
    const under = programToSource(before, marker.at);
    if (!under) return [];
    const segment = before.segments[under.segment], offset = marker.at - was[under.segment];
    let best: number | null = null;
    after.segments.forEach((next, index) => {
      const position = isGap(segment)
        ? next.id === segment.id && offset <= segmentLength(next) + 1e-6 ? now[index] + offset : null
        : next.source === segment.source && under.source >= next.srcIn - 1e-6 && under.source <= next.srcOut + 1e-6 ? now[index] + under.source - next.srcIn : null;
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
    : { id: segment.id, source: segment.source, srcIn: toSeconds(segment.in_frame, rate), srcOut: toSeconds(segment.out_frame, rate) });
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
  for (const segment of timeline.segments) {
    if (segment.source === GAP) {
      const frames = toFrames(segment.srcOut - segment.srcIn, rate);
      if (frames > 0) segments.push({ kind: "gap", id: segment.id, frames });
    } else {
      const inFrame = toFrames(segment.srcIn, rate), outFrame = toFrames(segment.srcOut, rate);
      if (outFrame > inFrame) segments.push({ kind: "source", id: segment.id, source: segment.source, in_frame: Math.max(0, inFrame), out_frame: outFrame });
    }
  }
  const total = segments.reduce((sum, segment) => sum + (segment.kind === "gap" ? segment.frames : segment.out_frame - segment.in_frame), 0);
  const mutes = timeline.mutes.map((mute) => ({
    source: mute.source, track: mute.track,
    in_frame: Math.max(0, Math.floor((mute.srcIn * rate.numerator) / rate.denominator)),
    out_frame: Math.ceil((mute.srcOut * rate.numerator) / rate.denominator),
  })).filter((mute) => mute.out_frame > mute.in_frame);
  const saved: EditMarker[] = markers.map((marker) => ({ id: marker.id, frame: Math.min(total, Math.max(0, toFrames(marker.at, rate))), track: marker.track, name: marker.name, comment: marker.comment, color: marker.color }));
  return { ...base, segments, mutes, markers: saved };
}

/**
 * An AAF Audio track's analysed words as model words: `source` and `track`
 * are the EDIT's ids. Cue positions are 16 kHz samples from the sequence
 * start, so seconds are samples / 16000.
 */
export function wordsFromSpeech(speech: AafSpeech, source: string, track: string): TimelineWord[] {
  return speech.words.map((word, index) => ({
    id: `${source}:${track}:${word.cue_id}:${index}`, source, track, text: word.text,
    start: word.start_sample / 16_000, end: word.end_sample / 16_000,
  }));
}

/** Where a mic is audible, in source seconds, for dead-space detection. */
export function audibleSpans(speech: AafSpeech): [number, number][] {
  return [...speech.activity, ...speech.reactions].map(([from, to]) => [from / 16_000, to / 16_000]);
}
