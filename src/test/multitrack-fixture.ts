import type { AafDocument } from "../bindings/AafDocument";
import type { AafTrackTranscript } from "../bindings/AafTrackTranscript";

export function multitrackFixture(): AafDocument {
  return {
    schema_version: 1, id: "sequence-test", source_path: "/fixtures/Interview.aaf", source_size: 1000, source_modified_ms: 1,
    manifest: { schema_version: 1, name: "Interview", source_fingerprint: "a".repeat(64), edit_rate: { numerator: 24000, denominator: 1001 }, start_frame: 86400, duration_frames: 24000, timecode_fps: 24, drop_frame: false,
      recording_dates: [], tracks: ["Alex mic", "Sam mic", "Room"].map((name, index) => ({ id: `track-${index + 1}`, name, warnings: [], clips: [{ start_frame: 0, duration_frames: 24000, kind: "audio", master_id: null, source_id: null, source_start_sample: 0, sample_rate: 48000, warnings: [] }] })), warnings: [] },
    labels: [{ track_id: "track-1", owner_name: "Alex", cast_member_id: null, color: null }], transcripts: [],
  };
}

export function multitrackTranscript(trackId = "track-1"): AafTrackTranscript {
  return { track_id: trackId, engine: "parakeet", model_id: "parakeet-tdt-0.6b-v3", start_frame: 0, duration_frames: 2878, status: "completed", sample_rate: 16000, cues: [{ id: "cue-1", start_sample: 160000, end_sample: 208000, text: "This is the first answer.", boundary_review: false }], timing_issues: [], warnings: [] };
}

export function multitrackGroupFixture(): AafDocument {
  const doc = multitrackFixture();
  doc.manifest.graph = { sequence_id: "top", sources: [], positions: [], markers: [], picture_tracks: [], path_mappings: [],
    lanes: doc.manifest.tracks.map((track, index) => ({ track_id: track.id, parent_track_id: index ? "track-1" : null, branch_id: index ? `branch-${index}` : null, group_name: "Group fixture", availability: "ready" })) };
  doc.manifest.tracks.forEach((track, index) => { track.physical_track_number = 1; track.clips[0].source_id = `source-${index}`; });
  return doc;
}

export function multitrackLinkedFixture(ready = false): AafDocument {
  const doc = multitrackGroupFixture();
  doc.manifest.graph!.sources = doc.manifest.tracks.map((_, index) => ({
    id: `source-${index}`, mob_id: `mob-${index}`, slot_id: index + 1, locators: [`/fixtures/mic-${index}.mxf`], ancestors: [],
    channel: 0, channels: 1, sample_rate: 48000, sample_width: 3, sample_count: 48048000, descriptor: "PCMDescriptor",
    status: ready ? "ready" : "offline",
    ...(ready ? { resolved: { path: `/fixtures/mic-${index}.mxf`, fingerprint: String(index).repeat(64), stream_index: 0, size: 144144000, modified_ms: 1 } } : {}),
  }));
  doc.manifest.graph!.lanes.forEach(lane => { lane.availability = ready ? "ready" : "offline"; });
  return doc;
}
