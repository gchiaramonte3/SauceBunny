import type { AafDocument } from "../bindings/AafDocument";
import type { EditDocument } from "../bindings/EditDocument";
import type { EditTrack } from "../bindings/EditTrack";
import { EDIT_SCHEMA_VERSION } from "./edit-document";
import { alternativeLane } from "./multitrack-graph";
import { trackOwner } from "./multitrack";

/**
 * Building an edit's frame from AAF Audio sequences: one edit track per person
 * (the sequence's main lanes, named by mic owner), each mapped to that
 * source's mic. A second source joins by matching owners, so Rosa's lane
 * draws on Rosa's mic in every sequence; a person new to the edit gets a lane.
 * Alternative mics in a group stay out: they are a choice inside the source,
 * not another person.
 */

const slug = (name: string) => name.toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "track";

function sourceId(edit: EditDocument | null): string {
  const taken = new Set(edit?.sources.map((source) => source.id) ?? []);
  let index = taken.size + 1;
  while (taken.has(`s${index}`)) index++;
  return `s${index}`;
}

/** Record timecode starts where Avid starts a new sequence: 01:00:00:00. */
const hourOne = (numerator: number, denominator: number) => Math.round((3600 * numerator) / denominator);

export function editFromSequence(document: AafDocument, title: string, whole: boolean): EditDocument {
  const rate = document.manifest.edit_rate;
  const empty: EditDocument = {
    schema_version: EDIT_SCHEMA_VERSION, title: title.trim() || document.manifest.name, edit_rate: { numerator: rate.numerator, denominator: rate.denominator },
    start_timecode_frames: hourOne(rate.numerator, rate.denominator), sources: [], tracks: [], segments: [], mutes: [], markers: [],
  };
  const edit = addSource(empty, document);
  const source = edit.sources[0].id;
  return whole && document.manifest.duration_frames > 0
    ? { ...edit, segments: [{ kind: "source", id: `whole-${source}`, source, in_frame: 0, out_frame: document.manifest.duration_frames }] }
    : edit;
}

/** Add a sequence as a source, matching its people to the edit's lanes by name. */
export function addSource(edit: EditDocument, document: AafDocument): EditDocument {
  const rate = document.manifest.edit_rate;
  if (edit.sources.length && (rate.numerator * edit.edit_rate.denominator !== edit.edit_rate.numerator * rate.denominator)) {
    throw new Error(`${document.manifest.name} runs at a different frame rate from this edit, so it cannot be cut into it.`);
  }
  if (edit.sources.some((source) => source.document_id === document.id)) return edit;
  const id = sourceId(edit);
  const tracks: EditTrack[] = edit.tracks.map((track) => ({ ...track, source_tracks: { ...track.source_tracks } }));
  const byName = new Map(tracks.map((track) => [track.name.normalize("NFC"), track]));
  const used = new Set(tracks.map((track) => track.id));
  for (const track of document.manifest.tracks) {
    if (alternativeLane(document, track.id)) continue;
    const name = trackOwner(document, track.id).normalize("NFC");
    const existing = byName.get(name);
    if (existing) {
      if (!existing.source_tracks[id]) existing.source_tracks[id] = track.id;
      continue;
    }
    let laneId = slug(name), suffix = 2;
    while (used.has(laneId)) laneId = `${slug(name)}-${suffix++}`;
    used.add(laneId);
    const lane: EditTrack = { id: laneId, name, kind: "sound", source_tracks: { [id]: track.id } };
    tracks.push(lane);
    byName.set(name, lane);
  }
  return { ...edit, sources: [...edit.sources, { id, name: document.manifest.name, document_id: document.id }], tracks };
}
