import type { AafDocument } from "../bindings/AafDocument";
import type { AafMarkerColor } from "../bindings/AafMarkerColor";
import { audioTrackLabel, trackOwner, transcriptRows, sequenceTimecode } from "./multitrack";
import { avidMarkerRowsToTxt } from "./markers";
import { alternativeLane, laneMetadata } from "./multitrack-graph";

export type MultitrackPerson = { id: string; name: string; trackIds: string[]; color: string | null };

/** Explicit cast identity wins. Otherwise, equal user-entered owner labels group mics. */
export function multitrackPeople(document: AafDocument): MultitrackPerson[] {
  const people = new Map<string, MultitrackPerson>();
  for (const track of document.manifest.tracks) {
    const label = document.labels.find((item) => item.track_id === track.id), name = trackOwner(document, track.id);
    const id = label?.cast_member_id ? `cast:${label.cast_member_id}` : label?.owner_name.trim() ? `owner:${name.normalize("NFC").trim().toLocaleLowerCase()}` : `track:${track.id}`;
    const person = people.get(id) ?? { id, name, trackIds: [], color: label?.color ?? null };
    person.trackIds.push(track.id); people.set(id, person);
  }
  return [...people.values()];
}

export function multitrackScope(document: AafDocument, trackIds?: string[]): AafDocument {
  return trackIds ? { ...document, transcripts: document.transcripts.filter((item) => trackIds.includes(item.track_id)) } : document;
}

export function multitrackExportName(name: string): string {
  const clean = name.replace(/[\x00-\x1f\\/:*?"<>|]/g, "-").replace(/^\.+|[. ]+$/g, "").trim();
  let result = "", bytes = 0;
  for (const character of clean) {
    const length = new TextEncoder().encode(character).length;
    if (bytes + length > 80) break;
    result += character; bytes += length;
  }
  return result || "Transcript";
}

/** Alternatives are sequence-aligned renditions, not additional Avid tracks.
 * Follow graph identity back to the original sequence lane, never its name or
 * the alternative's displayed ordinal. This does not address a source group. */
export function multitrackAvidTrack(document: AafDocument, trackId: string): string {
  const visited = new Set<string>();
  let id = trackId;
  while (true) {
    if (visited.has(id) || !document.manifest.tracks.some(track => track.id === id)) {
      throw new Error("The microphone's original sequence track cannot be resolved. Re-import the AAF before exporting markers.");
    }
    visited.add(id);
    const parent = laneMetadata(document, id)?.parent_track_id;
    if (!parent) return audioTrackLabel(document, id);
    id = parent;
  }
}

/** One point per cue start, in original sequence timecode, without floating seconds.
 * AAF slot IDs are NOT Avid track numbers. Keep the original audio-lane mapping.
 * Same-frame passages merge only on the same track, never across microphones.
 * Untimed text remains in plain-text exports; it never becomes a fabricated marker.
 */
export function multitrackAvidMarkers(document: AafDocument): string {
  const lanes = new Set<string>();
  for (const source of document.manifest.tracks) {
    if (alternativeLane(document, source.id)) continue;
    const lane = audioTrackLabel(document, source.id);
    if (lanes.has(lane)) throw new Error(`More than one source track maps to ${lane}. Re-import an AAF with distinct audio-track numbers before exporting markers.`);
    lanes.add(lane);
  }
  const markers = new Map<string, { speaker: string; timecode: string; track: string; text: string; color?: AafMarkerColor }>();
  const microphoneByTrack = new Map<string, string>();
  for (const cue of transcriptRows(document)) {
    if (!Number.isFinite(cue.startFrame) || cue.startFrame < 0 || cue.startFrame >= document.manifest.duration_frames || !cue.text.trim()) continue;
    const timecode = sequenceTimecode(document.manifest, cue.startFrame);
    if (!/^\d{2}:\d{2}:\d{2}[:;]\d{2}$/.test(timecode)) throw new Error("This sequence's frame rate cannot be exported as Avid timecode.");
    const track = multitrackAvidTrack(document, cue.trackId);
    const microphone = microphoneByTrack.get(track);
    if (microphone && microphone !== cue.trackId) throw new Error(`These microphones share ${track}. Export them as separate Avid marker files.`);
    microphoneByTrack.set(track, cue.trackId);
    const group = laneMetadata(document, cue.trackId)?.group_name || "Group audio";
    const text = alternativeLane(document, cue.trackId) ? `[Group alternative: ${group} / ${cue.owner}] ${cue.text}` : cue.text;
    const key = `${cue.startFrame}:${track}`, previous = markers.get(key);
    if (previous) previous.text += ` | ${text}`;
    else markers.set(key, { speaker: cue.owner, timecode, track, text, color: document.labels.find((label) => label.track_id === cue.trackId)?.marker_color ?? undefined });
  }
  return markers.size ? avidMarkerRowsToTxt([...markers.values()]) : "";
}
