import type { AafDocument } from "../bindings/AafDocument";
import type { EditDocument } from "../bindings/EditDocument";
import type { EditMarker } from "../bindings/EditMarker";
import type { EditSegment } from "../bindings/EditSegment";
import { addSource, editFromSequence } from "./edit-new";

/**
 * Rules-based string-outs (plan Phase 7, step 2): one edit per person, their
 * bites in scene order, each with handles, filler between, and a marker on
 * the bite naming who and what, so the string-out reads in Media Composer's
 * Markers window the way an assistant editor would have logged it.
 *
 * Bites come from the sequence's saved transcripts (cue positions are 16 kHz
 * samples from the sequence start), grouped by the mic's owner, so a person
 * with two mics across a scene is one string-out.
 */
export type StringoutRules = {
  /** Seconds kept before a bite and after it. */
  head: number; tail: number;
  /** Frames of filler between bites. */
  gapFrames: number;
  /** Cues closer than this (seconds) are one bite. */
  join: number;
  /** Bites shorter than this (seconds of speech) are left out. */
  minimum: number;
};

export const stringoutDefaults: StringoutRules = { head: 0.5, tail: 1, gapFrames: 24, join: 2, minimum: 1 };

/** Media Composer's marker colours, one per person in lane order. */
const COLORS = ["red", "green", "blue", "cyan", "magenta", "yellow", "white", "black"];

export type StringoutBite = { track: string; from: number; to: number; text: string };

/** One person's bites: their cues in time order, joined across short pauses. */
export function bitesFor(document: AafDocument, trackIds: string[], rules: StringoutRules = stringoutDefaults): StringoutBite[] {
  const cues = document.transcripts.filter((transcript) => trackIds.includes(transcript.track_id))
    .flatMap((transcript) => transcript.cues.map((cue) => ({ track: transcript.track_id, from: cue.start_sample / 16_000, to: cue.end_sample / 16_000, text: cue.text.trim() })))
    .filter((cue) => cue.to > cue.from && cue.text)
    .sort((a, b) => a.from - b.from);
  const bites: StringoutBite[] = [];
  for (const cue of cues) {
    const last = bites[bites.length - 1];
    if (last && cue.from - last.to < rules.join) { last.to = Math.max(last.to, cue.to); last.text += ` ${cue.text}`; }
    else bites.push({ ...cue });
  }
  return bites.filter((bite) => bite.to - bite.from >= rules.minimum);
}

const snippet = (text: string) => text.length <= 120 ? text : `${text.slice(0, 117).trimEnd()}…`;

/** A bite with the edit lane (person) it belongs to. */
export type LaneBite = StringoutBite & { lane: string };

/** Every person's bites, each tagged with their edit lane, in scene order. */
export function laneBites(document: AafDocument, rules: StringoutRules = stringoutDefaults): LaneBite[] {
  const frame = editFromSequence(document, "", false);
  const source = frame.sources[0]?.id;
  if (!source) return [];
  return frame.tracks.flatMap((person) => {
    // Every mic this person owns: an owner can wear more than one across a scene.
    const mic = person.source_tracks[source], mics = mic ? [mic] : [];
    const owned = document.labels.filter((label) => label.owner_name.normalize("NFC") === person.name.normalize("NFC")).map((label) => label.track_id);
    return bitesFor(document, [...new Set([...mics, ...owned])], rules).map((bite) => ({ ...bite, lane: person.id }));
  }).sort((a, b) => a.from - b.from);
}

/**
 * Lay bites end to end in the order given: handles, filler between, and a
 * marker on each naming who and what, coloured per person. Going forward in
 * the scene, a bite's head never replays the previous bite's tail.
 */
export function layoutBites(document: AafDocument, title: string, bites: LaneBite[], rules: StringoutRules = stringoutDefaults): EditDocument | null {
  const frame = editFromSequence(document, title, false);
  const source = frame.sources[0]?.id;
  if (!source || !bites.length) return null;
  const rate = frame.edit_rate, fps = rate.numerator / rate.denominator, length = document.manifest.duration_frames;
  const segments: EditSegment[] = [], markers: EditMarker[] = [];
  let at = 0, last = -1, lastIn = -1;
  bites.forEach((bite, index) => {
    const person = frame.tracks.find((track) => track.id === bite.lane);
    if (!person) return;
    const inFrame = Math.max(0, Math.floor((bite.from - rules.head) * fps)), outFrame = Math.min(length, Math.ceil((bite.to + rules.tail) * fps));
    const start = inFrame >= lastIn ? Math.max(inFrame, last) : inFrame;
    if (outFrame <= start) return;
    if (segments.length && rules.gapFrames > 0) { segments.push({ kind: "gap", id: `gap-${index}`, frames: rules.gapFrames }); at += rules.gapFrames; }
    segments.push({ kind: "source", id: `bite-${index}`, source, in_frame: start, out_frame: outFrame });
    markers.push({ id: `bite-${index}`, frame: at, track: person.id, name: person.name, comment: snippet(bite.text), color: COLORS[frame.tracks.indexOf(person) % COLORS.length] });
    at += outFrame - start; last = outFrame; lastIn = inFrame;
  });
  return segments.length ? { ...frame, segments, markers } : null;
}

/** A string-out for one person (an edit lane, by name), or null when they say nothing that qualifies. */
export function stringoutFor(document: AafDocument, lane: string, rules: StringoutRules = stringoutDefaults): EditDocument | null {
  const person = editFromSequence(document, "", false).tracks.find((track) => track.name === lane);
  if (!person) return null;
  return layoutBites(document, `SO_${document.manifest.name}_${lane}`, laneBites(document, rules).filter((bite) => bite.lane === person.id), rules);
}

/** Every person in the sequence who has transcribed words, as a string-out each. */
export function stringoutsFor(document: AafDocument, rules: StringoutRules = stringoutDefaults): EditDocument[] {
  const lanes = editFromSequence(document, "", false).tracks.map((track) => track.name);
  return lanes.map((lane) => stringoutFor(document, lane, rules)).filter((edit): edit is EditDocument => edit !== null);
}

/**
 * Manual string-outs (Phase 7, step 1): append a bite of an AAF Audio
 * sequence to another edit, joining that sequence as a source if it is new
 * there. Seconds are sequence time; the bite snaps outward to whole frames so
 * it never starts inside its first word or ends inside its last.
 */
export function appendBite(target: EditDocument, sequence: AafDocument, from: number, to: number, gapFrames = stringoutDefaults.gapFrames): EditDocument {
  const withSource = addSource(target, sequence);
  const source = withSource.sources.find((item) => item.document_id === sequence.id)!.id;
  const rate = withSource.edit_rate, fps = rate.numerator / rate.denominator;
  const inFrame = Math.max(0, Math.floor(from * fps)), outFrame = Math.min(sequence.manifest.duration_frames, Math.ceil(to * fps));
  if (outFrame <= inFrame) return target;
  const stamp = `${Date.now().toString(36)}-${withSource.segments.length}`;
  const segments: EditSegment[] = [...withSource.segments];
  if (segments.length && gapFrames > 0) segments.push({ kind: "gap", id: `gap-${stamp}`, frames: gapFrames });
  segments.push({ kind: "source", id: `bite-${stamp}`, source, in_frame: inFrame, out_frame: outFrame });
  return { ...withSource, segments };
}

/** A line from any source of an edit, in that edit's source and lane ids and source seconds. */
export type EditBite = { source: string; track: string; from: number; to: number; text: string };

/**
 * A new string out from lines of an existing one's sources, in the order
 * given: same sources, lanes, rate and start timecode, so it relinks and
 * exports exactly as the one it came from. Handles, filler and a marker per
 * bite as the per-person string outs have. `lengths` bounds each source in
 * seconds, so a tail handle never runs past the end of the media.
 */
export function layoutEditBites(base: EditDocument, bites: EditBite[], title: string, lengths: Record<string, number>, rules: StringoutRules = stringoutDefaults): EditDocument {
  const rate = base.edit_rate, fps = rate.numerator / rate.denominator;
  const segments: EditSegment[] = [], markers: EditMarker[] = [];
  let at = 0;
  const last = new Map<string, { inFrame: number; outFrame: number }>();
  bites.forEach((bite, index) => {
    const person = base.tracks.findIndex((track) => track.id === bite.track);
    if (!base.sources.some((source) => source.id === bite.source)) return;
    const end = lengths[bite.source] != null ? Math.floor(lengths[bite.source] * fps) : Infinity;
    const inFrame = Math.max(0, Math.floor((bite.from - rules.head) * fps)), outFrame = Math.min(end, Math.ceil((bite.to + rules.tail) * fps));
    // Going forward in the same source, a head never replays the previous tail.
    const previous = last.get(bite.source);
    const start = previous && inFrame >= previous.inFrame ? Math.max(inFrame, previous.outFrame) : inFrame;
    if (outFrame <= start) return;
    if (segments.length && rules.gapFrames > 0) { segments.push({ kind: "gap", id: `gap-${index}`, frames: rules.gapFrames }); at += rules.gapFrames; }
    segments.push({ kind: "source", id: `bite-${index}`, source: bite.source, in_frame: start, out_frame: outFrame });
    const lane = base.tracks[person];
    markers.push({ id: `bite-${index}`, frame: at, track: lane?.id ?? null, name: lane?.name ?? "Bite", comment: snippet(bite.text), color: COLORS[Math.max(0, person) % COLORS.length] });
    at += outFrame - start;
    last.set(bite.source, { inFrame, outFrame });
  });
  return { ...base, title: title.trim() || base.title, segments, mutes: [], markers };
}
