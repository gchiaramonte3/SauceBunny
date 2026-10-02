import type { AafDocument } from "../bindings/AafDocument";
import { trackOwner, transcriptRows } from "./multitrack";
import { alternativeLane, laneMetadata } from "./multitrack-graph";
import { multitrackAvidMarkers, multitrackAvidTrack, multitrackExportName, multitrackPeople, multitrackScope } from "./multitrack-person";

export function hasGroupMicrophones(document: AafDocument): boolean {
  return !!document.manifest.graph?.lanes.some(lane => lane.parent_track_id);
}

/** Capture IDs before the native dialog. A newly committed result is included
 * only if its microphone belonged to the clicked export scope. */
export function needsMicrophoneFiles(document: AafDocument, trackIds: string[]): boolean {
  return trackIds.length > 1 && trackIds.some(id => alternativeLane(document, id));
}

export type MultitrackAvidFile = { name: string; text: string; trackIds: string[] };
export function multitrackAvidFiles(document: AafDocument, trackIds: string[], byMicrophone: boolean): MultitrackAvidFile[] {
  const timedIds = new Set(transcriptRows(document).filter(cue => Number.isFinite(cue.startFrame) && cue.startFrame >= 0 && cue.startFrame < document.manifest.duration_frames).map(cue => cue.trackId));
  const scopes = byMicrophone
    ? document.manifest.tracks.flatMap((track, index) => !trackIds.includes(track.id) || !timedIds.has(track.id) ? [] : [{
      // The ordinal disambiguates identical labels; it NEVER determines routing.
      name: `${multitrackAvidTrack(document, track.id)} ${alternativeLane(document, track.id) ? "alternative" : "sequence"} ${index + 1} - ${trackOwner(document, track.id)}`,
      trackIds: [track.id],
    }])
    : multitrackPeople(document).map(person => ({ ...person, trackIds: person.trackIds.filter(id => trackIds.includes(id)) }));
  return scopes.flatMap(scope => {
    const text = multitrackAvidMarkers(multitrackScope(document, scope.trackIds));
    return text ? [{ name: `${multitrackExportName(document.manifest.name)} - ${multitrackExportName(scope.name)} - Avid markers.txt`, text, trackIds: scope.trackIds }] : [];
  });
}

/** Separate from the importable five-column files. Use the paths returned by
 * native unique writes so the guide is accurate after filename collisions. */
export function multitrackAvidGuide(document: AafDocument, files: { path: string; trackIds: string[] }[]): string {
  return [
    "Sauce Bunny: Avid markers by microphone", "",
    `Sequence: ${document.manifest.name}`,
    "Destination: the original sequence, not the source group clip.",
    "Load that sequence in Avid's Record Monitor. In the Markers window, choose Import Markers and select the microphone's .txt file.",
    "Each file uses sequence timecode and the original parent audio track. No additional sequence tracks are created.",
    "Alternatives sharing a parent track are separate choices. Import one microphone file per parent track at a time; importing them together can collide at the same frame. Use separate copies of the sequence to retain separate microphone marker sets.",
    "This export does not switch the group's audible microphone or attach markers inside its source branches.", "",
    ...files.flatMap(file => [file.path.split(/[\\/]/).pop() ?? file.path, ...file.trackIds.map(id => {
      const lane = laneMetadata(document, id);
      return `  ${trackOwner(document, id)} -> ${multitrackAvidTrack(document, id)} | Lane: ${id}${lane?.parent_track_id ? ` | Parent: ${lane.parent_track_id} | Group: ${lane.group_name ?? ""} | Branch: ${lane.branch_id ?? ""}` : ""}`;
    }), ""]),
  ].join("\n");
}
