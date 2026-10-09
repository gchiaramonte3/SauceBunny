import type { AafDocument } from "../bindings/AafDocument";
import type { EditTrack } from "../bindings/EditTrack";
import type { PlacedWord } from "./edit-model";
import { micOrder, micTrack, type MultitrackPerson } from "./multitrack-person";
import { BLEED_SHARE } from "./multitrack-ownership";

/**
 * How the SOURCE side of String Outs reads one sequence: a tab per person,
 * the way AAF Audio's transcript reads it, and an All voices view that keeps
 * each thing a person said whole.
 *
 * Twenty lavs all hear the room. Ordered word by word, their transcripts
 * interleave into a salad ("AVERY Cool. ALECIA Like AVERY Okay."), because
 * the speaker changes almost every word. AAF Audio orders by cue instead, and
 * so does this: a cue is what one mic heard as one sentence, and it stays in
 * one piece.
 */

/** The All voices tab's id, as MultitrackTranscriptTabs names it. */
export const ALL_VOICES = "all";

/**
 * The people with a mic in one source, as AAF Audio's transcript tabs take
 * them: in track order when the sequence is known (micOrder), so the tabs do
 * not shuffle when someone is patched to a record track.
 */
export function sourcePeople(tracks: EditTrack[], source: string, colors: Record<string, string>, aaf?: AafDocument): MultitrackPerson[] {
  const people = tracks.flatMap((track) => {
    const mic = track.kind === "sound" ? track.source_tracks[source] : undefined;
    return mic ? [{ id: track.id, name: track.name, trackIds: [mic], color: colors[track.id] ?? null, track: aaf ? micTrack(aaf, mic) ?? undefined : undefined }] : [];
  });
  if (!aaf) return people;
  // AAF Audio's order: by track number, each group's alternates after its own track.
  const order = micOrder(aaf), at = (mic: string) => { const index = order.indexOf(mic); return index < 0 ? Infinity : index; };
  return people.sort((a, b) => at(a.trackIds[0]) - at(b.trackIds[0]));
}

/**
 * Each person's colour, fixed by where their mic sits in the sequences (the
 * first source they are in, then that mic's position) rather than by lane
 * order: patching moves lanes to the top, and a person's colour must not
 * change because someone else was put on a track.
 */
export function laneColors(tracks: EditTrack[], sources: { id: string }[], documents: Map<string, AafDocument>, paint: (index: number) => string): Record<string, string> {
  const rank = (track: EditTrack) => {
    for (const [order, source] of sources.entries()) {
      const mic = track.source_tracks[source.id];
      if (!mic) continue;
      const at = documents.get(source.id)?.manifest.tracks.findIndex((item) => item.id === mic) ?? -1;
      return order * 100_000 + (at < 0 ? 99_999 : at);
    }
    return Infinity;
  };
  const listed = tracks.map((track, index) => ({ track, index }));
  listed.sort((a, b) => rank(a.track) - rank(b.track) || a.index - b.index);
  return Object.fromEntries(listed.map(({ track }, index) => [track.id, paint(index)]));
}

/** The cue a placed word belongs to; a word with no cue is a cue of its own. */
const cueOf = (item: PlacedWord) => `${item.word.track}\n${item.word.cue ?? item.word.id}`;

/**
 * A source's placed words as the pane shows them: one person's words in time
 * order, or everyone's with each cue kept whole, cues ordered by when they
 * start (then by lane, so a tie reads the same way every time).
 */
export function sourceOrder(placed: PlacedWord[], tab: string): PlacedWord[] {
  if (tab !== ALL_VOICES) return placed.filter((item) => item.word.track === tab);
  const cues = new Map<string, PlacedWord[]>();
  for (const item of placed) {
    const key = cueOf(item), cue = cues.get(key);
    if (cue) cue.push(item); else cues.set(key, [item]);
  }
  // A line that is mostly bleed is the same speech as its owner's copy on
  // another mic: All voices reads it once, from the mic it was said into.
  // The person's own tab still shows it.
  return [...cues.values()]
    .filter((cue) => cue.filter((item) => item.word.heardOn).length / cue.length < BLEED_SHARE)
    .sort((a, b) => a[0].programStart - b[0].programStart || a[0].word.track.localeCompare(b[0].word.track))
    .flat();
}

/** The tab a source opens on: the first person who says anything in it, as AAF Audio opens on its first person with text. */
export function firstSpeaker(people: MultitrackPerson[], placed: PlacedWord[]): string {
  const speaking = new Set(placed.map((item) => item.word.track));
  return people.find((person) => speaking.has(person.id))?.id ?? ALL_VOICES;
}

