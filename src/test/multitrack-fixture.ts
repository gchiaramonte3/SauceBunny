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
