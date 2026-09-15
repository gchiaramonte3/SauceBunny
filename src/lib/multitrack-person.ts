import type { AafDocument } from "../bindings/AafDocument";
import { trackOwner, transcriptRows, sequenceTimecode } from "./multitrack";
import { avidMarkerRowsToTxt } from "./markers";

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

/** One point per cue start, in original sequence timecode, without floating seconds.
 * V1 matches the existing transcript exporter: AAF slot IDs are NOT Avid track numbers.
 * Same-frame passages from this person merge rather than being moved to invented frames.
 * Untimed text remains in plain-text exports; it never becomes a fabricated marker.
 */
export function multitrackAvidMarkers(document: AafDocument): string {
  const markers = new Map<string, { speaker: string; timecode: string; track: string; text: string }>();
  for (const cue of transcriptRows(document)) {
    if (!Number.isFinite(cue.startFrame) || cue.startFrame < 0 || cue.startFrame >= document.manifest.duration_frames || !cue.text.trim()) continue;
    const timecode = sequenceTimecode(document.manifest, cue.startFrame);
    if (!/^\d{2}:\d{2}:\d{2}[:;]\d{2}$/.test(timecode)) throw new Error("This sequence's frame rate cannot be exported as Avid timecode.");
    const key = `${cue.startFrame}:${cue.owner}`, previous = markers.get(key);
    if (previous) previous.text += ` | ${cue.text}`;
    else markers.set(key, { speaker: cue.owner, timecode, track: "V1", text: cue.text });
  }
  return markers.size ? avidMarkerRowsToTxt([...markers.values()]) : "";
}
