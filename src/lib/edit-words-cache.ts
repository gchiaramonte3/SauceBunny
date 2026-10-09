import { listen } from "@tauri-apps/api/event";
import type { AafDocument } from "../bindings/AafDocument";
import type { AafSpeech } from "../bindings/AafSpeech";
import type { TimelineWord } from "./edit-model";
import type { OwnershipIndex } from "./multitrack-ownership";

/**
 * What String Outs has read from each AAF Audio sequence, kept for the app
 * session: the sequence (without its transcripts), its bleed labels and each
 * mic's speech. Every string-out tab read all of it again whenever it opened,
 * because a tab switch mounts the editor afresh: on HEAT 1 that was 98 mics
 * and 901,138 words, about 25 s of reading on every switch, with the page
 * frozen for up to 400 ms each time a batch of words arrived. A tab over a
 * sequence already read now opens without asking the app for anything.
 *
 * A sequence is forgotten when it is saved: every write to an AAF Audio
 * document sends `saucebunny:multitrack-changed`, so a transcript finished in
 * AAF Audio reaches a string out, which reads that sequence again behind the
 * words it shows. Two sequences are kept, the oldest dropped first, since each
 * holds every word of every mic. Without the event (no app to hear from, as
 * in a test) nothing is kept at all, so a stale word is never served.
 */
export type SequenceWords = {
  document: AafDocument | null;
  /** The bleed labels; undefined until read, null when there are none. */
  ownership: OwnershipIndex | null | undefined;
  /** Per AAF track id: its speech, measured once a waveform pass built it. */
  speech: Map<string, AafSpeech>;
};

const KEPT = 2;
const kept = new Map<string, SequenceWords>();
const listeners = new Set<(documentId: string) => void>();
let following: "no" | "starting" | "yes" = "no";

function follow() {
  if (following !== "no") return;
  following = "starting";
  const onSaucebunnyMultitrackChanged = (event: { payload: string }) => forgetSequence(event.payload);
  listen<string>("saucebunny:multitrack-changed", onSaucebunnyMultitrackChanged)
    .then(() => { following = "yes"; })
    .catch(() => { following = "no"; kept.clear(); });
}

/**
 * The sequence's entry: what is kept, or an empty one that what is read next
 * goes into. An entry forgotten while a read is still filling it is no longer
 * kept, so a read that started before a save can never be served after it.
 */
export function sequenceWords(documentId: string): SequenceWords {
  follow();
  const known = kept.get(documentId);
  if (known) {
    kept.delete(documentId);
    kept.set(documentId, known);
    return known;
  }
  const made: SequenceWords = { document: null, ownership: undefined, speech: new Map() };
  if (following === "no") return made;
  kept.set(documentId, made);
  while (kept.size > KEPT) kept.delete(kept.keys().next().value ?? "");
  return made;
}

export function forgetSequence(documentId: string) {
  kept.delete(documentId);
  for (const listener of listeners) listener(documentId);
}

/** Told the id of each sequence forgotten because it was saved. */
export function onSequenceForgotten(listener: (documentId: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * One mic's words, the same array while its speech, its place in the edit and
 * its bleed labels are the same objects. Building them was 100 ms for 92 mics,
 * and reusing them lets `mergedWords` hand back the very array it did before.
 */
const micWordsKept = new WeakMap<AafSpeech, Map<string, { labels: OwnershipIndex | undefined; words: TimelineWord[] }>>();
export function micWords(speech: AafSpeech, source: string, lane: string, labels: OwnershipIndex | undefined, make: () => TimelineWord[]): TimelineWord[] {
  const key = `${source}\n${lane}`;
  const forSpeech = micWordsKept.get(speech) ?? new Map();
  micWordsKept.set(speech, forSpeech);
  const known = forSpeech.get(key);
  if (known && known.labels === labels) return known.words;
  const words = make();
  forSpeech.set(key, { labels, words });
  return words;
}

/**
 * Every mic's words in one list, the same array as before when every part
 * is: what is placed from it is then reused too, which is the 400 ms a
 * reopened tab would otherwise spend laying out the same words again. A few
 * are kept, so switching between two string outs reuses both; an empty list
 * is never kept, since every tab renders one before its words arrive.
 */
const MERGES_KEPT = 4;
const merges: { parts: TimelineWord[][]; words: TimelineWord[] }[] = [];
export function mergedWords(parts: TimelineWord[][]): TimelineWord[] {
  if (!parts.length) return [];
  const at = merges.findIndex((merge) => merge.parts.length === parts.length && merge.parts.every((part, index) => part === parts[index]));
  if (at >= 0) {
    const [merge] = merges.splice(at, 1);
    merges.push(merge);
    return merge.words;
  }
  // A loop, not push(...part): a mic of 100,000 words is past what a spread
  // may pass as arguments.
  const words: TimelineWord[] = [];
  for (const part of parts) for (const word of part) words.push(word);
  merges.push({ parts, words });
  if (merges.length > MERGES_KEPT) merges.shift();
  return words;
}

/**
 * Something made from a merged word list, kept with that list: placing a
 * source's words was 100 to 400 ms each time a tab opened, for the same words.
 */
const madeFromWords = new WeakMap<TimelineWord[], Map<string, unknown>>();
export function fromWords<T>(words: TimelineWord[], key: string, make: () => T): T {
  const made = madeFromWords.get(words) ?? new Map<string, unknown>();
  madeFromWords.set(words, made);
  if (made.has(key)) return made.get(key) as T;
  const value = make();
  made.set(key, value);
  return value;
}
