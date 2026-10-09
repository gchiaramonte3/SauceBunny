import type { AafDocument } from "../bindings/AafDocument";
import type { EditDocument } from "../bindings/EditDocument";
import type { EditMarker } from "../bindings/EditMarker";
import type { EditSegment } from "../bindings/EditSegment";
import { addSource, editFromSequence, giveTracks } from "./edit-new";
import { exchangesOf, placeExchange } from "./edit-exchanges";
import type { TimelineWord } from "./edit-model";
import { focusOnMarkers } from "./edit-focus";

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
export const MARKER_COLORS = ["red", "green", "blue", "cyan", "magenta", "yellow", "white", "black"];

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

export const snippet = (text: string) => text.length <= 120 ? text : `${text.slice(0, 117).trimEnd()}…`;

/** A bite with the edit lane (person) it belongs to. */
export type LaneBite = StringoutBite & { lane: string };

/** Every person's bites, each tagged with their edit lane, in scene order. */
export function laneBites(document: AafDocument, rules: StringoutRules = stringoutDefaults): LaneBite[] {
  const frame = editFromSequence(document, "");
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
  const frame = editFromSequence(document, title);
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
    // A bite is that person's mic, on their track; the other tracks are filler under it.
    segments.push({ kind: "source", id: `bite-${index}`, source, in_frame: start, out_frame: outFrame, tracks: [person.id] });
    markers.push({ id: `bite-${index}`, frame: at, track: person.id, name: person.name, comment: snippet(bite.text), color: MARKER_COLORS[frame.tracks.indexOf(person) % MARKER_COLORS.length] });
    at += outFrame - start; last = outFrame; lastIn = inFrame;
  });
  // Whoever has a bite is patched, top-down in the order they first speak, a group angle included.
  return segments.length ? { ...giveTracks(frame, bites.map((bite) => bite.lane)), segments, markers } : null;
}

/** A string-out for one person (an edit lane, by name), or null when they say nothing that qualifies. */
export function stringoutFor(document: AafDocument, lane: string, rules: StringoutRules = stringoutDefaults): EditDocument | null {
  const person = editFromSequence(document, "").tracks.find((track) => track.name === lane);
  if (!person) return null;
  return layoutBites(document, `SO_${document.manifest.name}_${lane}`, laneBites(document, rules).filter((bite) => bite.lane === person.id), rules);
}

/** Every person in the sequence who has transcribed words, as a string-out each. */
export function stringoutsFor(document: AafDocument, rules: StringoutRules = stringoutDefaults): EditDocument[] {
  const lanes = editFromSequence(document, "").tracks.map((track) => track.name);
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
 * exports exactly as the one it came from. `lengths` bounds each source in
 * seconds, so a tail handle never runs past the end of the media.
 *
 * Lines that run on from each other in one source are one exchange
 * (edit-exchanges.ts): one clip over the whole back-and-forth with every
 * participant's mic open, a marker on each line, and filler only between
 * exchanges. `words` (every mic's, as String Outs reads them) let a listener
 * who reacts on their own mic join the exchange and keep its edges out of
 * any word; without them each exchange plays only its speakers.
 *
 * It is a new sequence of chunks, patched from nothing: only the people it
 * cites get record tracks, top-down in the order they first speak (Harry on
 * A1, Jane on A2, nobody else). Each clip is then focused on the people its
 * markers name (edit-focus): a listener's mic stays on its track, silenced,
 * so a crowd of open mics does not bury the line Ask chose.
 */
export function layoutEditBites(base: EditDocument, bites: EditBite[], title: string, lengths: Record<string, number>, words: TimelineWord[] = [],
  rules: StringoutRules = stringoutDefaults): EditDocument {
  const rate = base.edit_rate, fps = rate.numerator / rate.denominator;
  const lanes = new Set(base.tracks.map((track) => track.id));
  const lines = bites.filter((bite) => base.sources.some((source) => source.id === bite.source));
  const exchanges = exchangesOf(lines.map((line) => ({ source: line.source, lanes: lanes.has(line.track) ? [line.track] : [], from: line.from, to: line.to })), rules.join);
  const candidates = [...new Set(lines.map((line) => line.track).filter((lane) => lanes.has(lane)))];
  const segments: EditSegment[] = [], markers: EditMarker[] = [];
  const last = new Map<string, { inFrame: number; outFrame: number }>();
  let at = 0;
  for (const exchange of exchanges) {
    const end = lengths[exchange.source] != null ? Math.floor(lengths[exchange.source] * fps) : Infinity;
    const placed = placeExchange(exchange, { fps, head: rules.head, tail: rules.tail, end, words, candidates, previous: last.get(exchange.source) });
    if (!placed) continue;
    const first = exchange.members[0], length = placed.outFrame - placed.inFrame;
    if (segments.length && rules.gapFrames > 0) { segments.push({ kind: "gap", id: `gap-${first}`, frames: rules.gapFrames }); at += rules.gapFrames; }
    segments.push({ kind: "source", id: `bite-${first}`, source: exchange.source, in_frame: placed.inFrame, out_frame: placed.outFrame,
      ...(placed.lanes.length ? { tracks: placed.lanes } : {}) });
    for (const index of exchange.members) {
      const line = lines[index], person = base.tracks.findIndex((track) => track.id === line.track), lane = base.tracks[person];
      // Where the line's own handle would have started it, inside the exchange.
      const offset = Math.min(length - 1, Math.max(0, Math.floor((line.from - rules.head) * fps) - placed.inFrame));
      markers.push({ id: `bite-${index}`, frame: at + offset, track: lane?.id ?? null, name: lane?.name ?? "Bite", comment: snippet(line.text),
        color: MARKER_COLORS[Math.max(0, person) % MARKER_COLORS.length] });
    }
    at += length;
    last.set(exchange.source, placed);
  }
  markers.sort((a, b) => a.frame - b.frame);
  const unpatched = { ...base, tracks: base.tracks.map((lane) => ({ ...lane, featured: false })) };
  return focusOnMarkers({ ...giveTracks(unpatched, segments.flatMap((segment) => segment.kind === "source" ? segment.tracks ?? [] : [])),
    title: title.trim() || base.title, segments, mutes: [], markers }).document;
}
