import type { AafDocument } from "../bindings/AafDocument";
import type { EditDocument } from "../bindings/EditDocument";
import type { EditTrack } from "../bindings/EditTrack";
import { EDIT_SCHEMA_VERSION } from "./edit-document";
import type { TimelineLane } from "./edit-model";
import { alternativeLane } from "./multitrack-graph";
import { documentName, trackOwner } from "./multitrack";

/**
 * Building an edit's frame from AAF Audio sequences: one lane per person
 * (named by mic owner), each mapped to that source's mic. A second source
 * joins by matching owners, so Rosa's lane draws on Rosa's mic in every
 * sequence; a person new to the edit gets a lane.
 *
 * A lane is not a record track. Record tracks are PATCHED, as in Avid: a new
 * string out has none, and each person goes on the next track down when
 * their words are first cut in (`giveTracks`), so a string out of Harry and
 * Jane has Harry on A1, Jane on A2 and nothing else. Everyone is listed
 * (`featured: false` until patched), so Ask and the source pane can find
 * anyone's words, a group angle's included. On the Media Composer 64-track
 * ceiling this matters: HEAT 2 has 21 tracks and 99 people.
 */

const slug = (name: string) => name.toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "track";

function sourceId(edit: EditDocument | null): string {
  const taken = new Set(edit?.sources.map((source) => source.id) ?? []);
  let index = taken.size + 1;
  while (taken.has(`s${index}`)) index++;
  return `s${index}`;
}

/**
 * Record timecode starts where Avid starts a new sequence: 01:00:00:00, as a
 * frame count in the sequence's own timecode (24 per second at 23.976, and at
 * 29.97 drop-frame the hour is 107,892 frames because 108 labels are skipped).
 */
export function hourOne(timecodeFps: number, dropFrame: boolean): number {
  const fps = Math.max(1, Math.round(timecodeFps));
  if (!dropFrame) return 3600 * fps;
  const skipped = Math.round(fps / 15);
  return 3600 * fps - skipped * (60 - 6);
}

const hourOf = (document: AafDocument) => hourOne(document.manifest.timecode_fps || Math.ceil(document.manifest.edit_rate.numerator / document.manifest.edit_rate.denominator), document.manifest.drop_frame);

export function editFromSequence(document: AafDocument, title: string, whole: boolean): EditDocument {
  const rate = document.manifest.edit_rate;
  const empty: EditDocument = {
    schema_version: EDIT_SCHEMA_VERSION, title: title.trim() || documentName(document), edit_rate: { numerator: rate.numerator, denominator: rate.denominator },
    start_timecode_frames: hourOf(document), sources: [], tracks: [], segments: [], mutes: [], markers: [],
  };
  const edit = addSource(empty, document);
  const source = edit.sources[0].id;
  if (!whole || document.manifest.duration_frames <= 0) return edit;
  // The whole sequence, as the sequence has it: everyone with a track of
  // their own in it is patched, top-down in its order; group angles are not.
  const own = document.manifest.tracks.filter((track) => !alternativeLane(document, track.id))
    .flatMap((track) => edit.tracks.filter((lane) => lane.source_tracks[source] === track.id).map((lane) => lane.id));
  return { ...giveTracks(edit, own), segments: [{ kind: "source", id: `whole-${source}`, source, in_frame: 0, out_frame: document.manifest.duration_frames }] };
}

/**
 * Add a sequence as a source, matching its people to the edit's lanes by name.
 * An edit with no sources yet takes the first one's frame rate and timecode:
 * an empty string out is only a placeholder until something is cut into it.
 */
export function addSource(target: EditDocument, document: AafDocument): EditDocument {
  const rate = document.manifest.edit_rate;
  const edit = target.sources.length || target.segments.length ? target
    : { ...target, edit_rate: { numerator: rate.numerator, denominator: rate.denominator }, start_timecode_frames: hourOf(document) };
  if (edit.sources.length && (rate.numerator * edit.edit_rate.denominator !== edit.edit_rate.numerator * rate.denominator)) {
    throw new Error(`${documentName(document)} runs at a different frame rate from this edit, so it cannot be cut into it.`);
  }
  if (edit.sources.some((source) => source.document_id === document.id)) return target;
  const id = sourceId(edit);
  const tracks: EditTrack[] = edit.tracks.map((track) => ({ ...track, source_tracks: { ...track.source_tracks } }));
  const byName = new Map(tracks.map((track) => [track.name.normalize("NFC"), track]));
  const used = new Set(tracks.map((track) => track.id));
  for (const track of document.manifest.tracks) {
    const angle = alternativeLane(document, track.id);
    const name = trackOwner(document, track.id).normalize("NFC");
    const existing = byName.get(name);
    if (existing) {
      const had = existing.source_tracks[id];
      // One mic per person per sequence: their own track over an angle of theirs in a group.
      if (had && !(angle === false && alternativeLane(document, had))) continue;
      existing.source_tracks[id] = track.id;
      continue;
    }
    let laneId = slug(name), suffix = 2;
    while (used.has(laneId)) laneId = `${slug(name)}-${suffix++}`;
    used.add(laneId);
    // Listed, not patched: a person gets a record track when their words are cut in.
    const lane: EditTrack = { id: laneId, name, kind: "sound", source_tracks: { [id]: track.id }, featured: false };
    tracks.push(lane);
    byName.set(name, lane);
  }
  return { ...edit, sources: [...edit.sources, { id, name: documentName(document), document_id: document.id }], tracks };
}

/** Whether a lane is patched to a record track (absent: patched, as every lane was before patching). */
export const onTrack = (lane: EditTrack) => lane.featured !== false;

/**
 * Everyone who speaks, with the record track each is patched to (0 for
 * none). Tracks are numbered top-down in lane order, and patching keeps the
 * patched lanes first, so the numbers are A1, A2… with no holes.
 */
export function peopleOf(tracks: EditTrack[]): TimelineLane[] {
  let number = 0;
  return tracks.filter((track) => track.kind === "sound").map((track) => ({ id: track.id, name: track.name, track: onTrack(track) ? ++number : 0, angle: track.featured === true }));
}

/** Patched lanes first, in track order, then everyone else in the order they were listed. */
const arrange = (tracks: EditTrack[]) => [...tracks.filter(onTrack), ...tracks.filter((lane) => !onTrack(lane))];

/**
 * Patch these people onto record tracks, top-down in the order given: each
 * one not on a track yet goes on the next track below the last one in use,
 * so asking for Harry and then Jane puts Harry on A1 and Jane on A2. Nobody
 * already patched moves. The same document when everyone given has a track.
 */
export function giveTracks(edit: EditDocument, laneIds: Iterable<string>): EditDocument {
  const joining = [...new Set(laneIds)].filter((id) => edit.tracks.some((lane) => lane.id === id && !onTrack(lane)));
  if (!joining.length) return edit;
  const patched = edit.tracks.filter(onTrack);
  const added = joining.map((id) => ({ ...edit.tracks.find((lane) => lane.id === id)!, featured: true }));
  return { ...edit, tracks: [...patched, ...added, ...edit.tracks.filter((lane) => !onTrack(lane) && !joining.includes(lane.id))] };
}

/**
 * The patch panel: put this person on record track `position` (0 for A1).
 * Whoever was there, and everyone below, moves down one; the person leaves
 * the track they were on. Clips keep playing their own people, so a clip of
 * Jane follows Jane to her new track.
 */
export function patchAt(edit: EditDocument, laneId: string, position: number): EditDocument {
  const lane = edit.tracks.find((item) => item.id === laneId);
  if (!lane) return edit;
  const patched = edit.tracks.filter((item) => onTrack(item) && item.id !== laneId);
  if (onTrack(lane) && edit.tracks.filter(onTrack).indexOf(lane) === position) return edit;
  patched.splice(Math.max(0, Math.min(position, patched.length)), 0, { ...lane, featured: true });
  return { ...edit, tracks: [...patched, ...edit.tracks.filter((item) => !onTrack(item) && item.id !== laneId)] };
}

/** Take a person off their record track; the tracks below move up. Their clips stay, silent on no track. */
export function unpatch(edit: EditDocument, laneId: string): EditDocument {
  if (!edit.tracks.some((lane) => lane.id === laneId && onTrack(lane))) return edit;
  return { ...edit, tracks: arrange(edit.tracks.map((lane) => lane.id === laneId ? { ...lane, featured: false } : lane)) };
}
