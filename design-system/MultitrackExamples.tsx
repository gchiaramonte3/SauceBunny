import { useState } from "react";
import { MultitrackTimeline } from "../src/components/MultitrackTimeline";
import type { AafDocument } from "../src/bindings/AafDocument";
import "../src/styles/multitrack.css";

const names = ["Alex", "Brianna", "Camille", "Diego"];
const example: AafDocument = {
  schema_version: 1, id: "catalog-multitrack", source_path: "Example.aaf", source_size: 0, source_modified_ms: 0,
  manifest: {
    schema_version: 1, name: "Interview microphones", source_fingerprint: "catalog-only",
    edit_rate: { numerator: 24000, denominator: 1001 }, start_frame: 86400,
    duration_frames: 2400, timecode_fps: 24, drop_frame: false, warnings: [],
    tracks: names.map((name, index) => ({ id: String(index + 1), name, warnings: [], clips: [
      { kind: "audio", start_frame: 0, duration_frames: 900, master_id: null, source_id: null, source_start_sample: 0, sample_rate: 48000, warnings: [] },
      { kind: "gap", start_frame: 900, duration_frames: 300, master_id: null, source_id: null, source_start_sample: null, sample_rate: null, warnings: [] },
      { kind: "audio", start_frame: 1200, duration_frames: 1200, master_id: null, source_id: null, source_start_sample: 0, sample_rate: 48000, warnings: [] },
    ] })),
  }, labels: [], transcripts: [],
};
const waveforms = Object.fromEntries(names.map((_, track) => [String(track + 1), Array.from({ length: 320 }, (_, index) => {
  const value = index >= 120 && index < 160 ? 0 : Math.abs(Math.sin(index * 0.7 + track) * Math.sin(index * 0.091 + track)) * 0.8;
  return [-value, value];
})]));

/** The real controlled timeline, with generated geometry and no audio or IPC. */
export function MultitrackExamples() {
  const [document, setDocument] = useState(example);
  const [frame, setFrame] = useState(420);
  const [solo, setSolo] = useState(new Set(["1"]));
  const [levels, setLevels] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState(new Set(["1", "2", "3", "4"]));
  return <div className="cp-ds-stack">
    <p className="cp-ds-fixture-caption">Multitrack · Generated waveforms, not a recording. Solo and seek update this fixture only.</p>
    <MultitrackTimeline document={document} waveforms={waveforms} waveformErrors={{}} selected={selected} solo={solo} frame={frame} levels={levels} onLevel={(id, value) => setLevels((prior) => ({ ...prior, [id]: value }))}
      onSelect={(id) => setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; })}
      onRename={(trackId, owner) => setDocument((current) => ({ ...current, labels: [...current.labels.filter((label) => label.track_id !== trackId), { track_id: trackId, owner_name: owner, cast_member_id: null, color: null }] }))}
      onSolo={(id) => setSolo((prior) => { const next = new Set(prior); if (next.has(id)) next.delete(id); else next.add(id); return next; })}
      onScrub={setFrame} onSeek={setFrame} />
  </div>;
}
