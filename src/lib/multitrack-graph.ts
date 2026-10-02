import type { AafDocument } from "../bindings/AafDocument";

export const laneMetadata = (document: AafDocument, id: string) => document.manifest.graph?.lanes.find(lane => lane.track_id === id);
export const laneReady = (document: AafDocument, id: string) => !document.manifest.graph || laneMetadata(document, id)?.availability === "ready";
// Offline media prevents generation, not selection/export of a saved result.
export const laneSelectable = (document: AafDocument, id: string) => laneReady(document, id) || document.transcripts.some(track => track.track_id === id);
export const alternativeLane = (document: AafDocument, id: string) => !!laneMetadata(document, id)?.parent_track_id;
export function laneStatus(document: AafDocument, id: string) {
  switch (laneMetadata(document, id)?.availability) {
    case "offline": return "Offline";
    case "needs_relink": return "Needs relink";
    case "unsupported": return "Unsupported processing";
    default: return "";
  }
}
export function visibleLanes(document: AafDocument, expanded: Set<string>) {
  return document.manifest.tracks.filter(track => !alternativeLane(document, track.id)).flatMap(track => [track,
    ...(expanded.has(track.id) ? document.manifest.tracks.filter(child => laneMetadata(document, child.id)?.parent_track_id === track.id) : [])]);
}
/** Changes when decoded audio can change, never when a person's name changes. */
export function mediaRevision(document: AafDocument, trackId?: string) {
  const clips = trackId ? document.manifest.tracks.find(track => track.id === trackId)?.clips : undefined;
  return JSON.stringify([document.id, document.manifest.source_fingerprint, clips,
    document.manifest.graph?.sources.filter(source => !trackId || clips?.some(clip => clip.source_id === source.id))
      .map(source => [source.id, source.channel, source.status, source.resolved])]);
}
export function trackProvenance(document: AafDocument, id: string) {
  const lane = laneMetadata(document, id);
  if (!lane?.parent_track_id) return "";
  const sources = document.manifest.tracks.find(track => track.id === id)?.clips.filter(clip => clip.source_id).map(clip => {
    const source = document.manifest.graph?.sources.find(item => item.id === clip.source_id);
    return source ? `${source.mob_id} / slot ${source.slot_id} / channel ${source.channel + 1}` : clip.source_id;
  }) ?? [];
  return `Group alternative · ${lane.group_name || "Group audio"} · ${[...new Set(sources)].join("; ")}`;
}

/** Different microphones may be mixed deliberately. Only identical source
 * mappings are deduplicated; names never participate in routing. */
export function auditionLanes(document: AafDocument, solo: Set<string>, muted: Set<string>) {
  const candidates = document.manifest.tracks.filter(track => laneReady(document, track.id)
    && (!solo.size || solo.has(track.id)) && !muted.has(track.id));
  const seen = new Set<string>();
  return candidates.filter(track => {
    const audio = track.clips.filter(clip => clip.kind !== "gap");
    const mapping = JSON.stringify(audio.map(clip => [clip.kind, clip.source_id, clip.source_start_sample, clip.sample_rate, clip.start_frame, clip.duration_frames]));
    // Do not de-duplicate empty legacy fixtures or truly separate sequence lanes.
    const parent = laneMetadata(document, track.id)?.parent_track_id;
    if (!audio.length) return true;
    const key = `${parent ?? track.id}:${mapping}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).map(track => track.id);
}
