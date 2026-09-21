import type { AafDocument } from "../bindings/AafDocument";
import type { AafManifest } from "../bindings/AafManifest";
import type { AafTrackTranscript } from "../bindings/AafTrackTranscript";
import { fpsToRateKey, framesToTc, RATE_TABLE } from "./marker-time";

export const sequenceFps = (manifest: AafManifest) => manifest.edit_rate.numerator / manifest.edit_rate.denominator;
export const clampFrame = (frame: number, duration: number) => Math.max(0, Math.min(duration - 1, Math.floor(Number.isFinite(frame) ? frame : 0)));
export const sampleFrame = (sample: number, manifest: AafManifest, sampleRate = 16_000) =>
  Math.floor(sample * manifest.edit_rate.numerator / (sampleRate * manifest.edit_rate.denominator));

export function sequenceTimecode(manifest: AafManifest, relativeFrame: number): string {
  const frame = Math.max(0, manifest.start_frame + Math.floor(relativeFrame));
  const rate = fpsToRateKey(sequenceFps(manifest));
  if (!rate || Math.abs(RATE_TABLE[rate].fpsExact.num / RATE_TABLE[rate].fpsExact.den - sequenceFps(manifest)) > 0.002) return `Frame ${frame}`;
  return framesToTc(frame, rate, manifest.drop_frame);
}

export function trackOwner(document: AafDocument, trackId: string): string {
  return document.labels.find((label) => label.track_id === trackId)?.owner_name
    || document.manifest.tracks.find((track) => track.id === trackId)?.name || trackId;
}

/** Physical AAF audio lane when present; legacy documents retain their displayed
 * lane order. Never derive an Avid track from a MobSlot ID or a filtered list. */
export function audioTrackLabel(document: AafDocument, trackId: string): string {
  const index = document.manifest.tracks.findIndex((track) => track.id === trackId);
  if (index < 0) throw new Error("The transcript's source audio track is missing from this sequence.");
  const number = document.manifest.tracks[index].physical_track_number;
  if (number != null && (!Number.isSafeInteger(number) || number < 1)) throw new Error("The source audio track number is invalid.");
  return `A${number ?? index + 1}`;
}

export function transcriptRows(document: AafDocument) {
  return document.transcripts.flatMap((transcript) => transcript.cues.map((cue) => ({
    ...cue, trackId: transcript.track_id, owner: trackOwner(document, transcript.track_id),
    engine: transcript.engine, model: transcript.model_id,
    startFrame: sampleFrame(cue.start_sample, document.manifest, transcript.sample_rate),
    endFrame: sampleFrame(cue.end_sample, document.manifest, transcript.sample_rate),
    startSeconds: cue.start_sample / transcript.sample_rate,
    endSeconds: cue.end_sample / transcript.sample_rate,
  }))).sort((a, b) => a.startSeconds - b.startSeconds || a.trackId.localeCompare(b.trackId));
}

export function untimedTranscriptRows(document: AafDocument) {
  return document.transcripts.flatMap((transcript) => (transcript.timing_issues ?? []).map((issue) => ({
    ...issue, trackId: transcript.track_id, owner: trackOwner(document, transcript.track_id), engine: transcript.engine, model: transcript.model_id,
  })));
}

export function mergeTrackTranscript(document: AafDocument, transcript: AafTrackTranscript): AafDocument {
  return { ...document, transcripts: [...document.transcripts.filter((item) => item.track_id !== transcript.track_id), transcript] };
}

/** One min/max vertical stroke per pixel bin, retaining quiet detail when zoomed. */
export function waveformPath(peaks: number[][], from = 0, to = 1, bins = 800): string {
  if (!peaks.length || to <= from) return "";
  const first = Math.max(0, Math.floor(from * peaks.length));
  const last = Math.min(peaks.length, Math.ceil(to * peaks.length));
  const count = Math.min(bins, last - first);
  const result: string[] = [];
  for (let index = 0; index < count; index++) {
    const begin = first + Math.floor(index * (last - first) / count);
    const end = first + Math.ceil((index + 1) * (last - first) / count);
    let low = 0, high = 0;
    for (let point = begin; point < end; point++) {
      low = Math.min(low, peaks[point][0]); high = Math.max(high, peaks[point][1]);
    }
    const x = ((index + 0.5) / count * 1000).toFixed(2);
    result.push(`M${x},${(30 - Math.min(1, high) * 25).toFixed(2)}V${(30 - Math.max(-1, low) * 25).toFixed(2)}`);
  }
  return result.join("");
}

function csvCell(value: string | number): string {
  const text = String(value);
  const safe = typeof value === "string" && /^[\s]*[=+@-]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

import { transcriptMetadata } from "./multitrack-metadata";

export function exportMultitrack(document: AafDocument, format: "csv" | "txt"): string {
  const rows = transcriptRows(document);
  const untimed = untimedTranscriptRows(document);
  if (format === "csv") return [
    ["sequence", "track", "speaker", "start_tc", "end_tc", "text", "source_file", "start_seconds", "end_seconds", "engine", "model", "attribution", "timing"],
    ...rows.map((cue) => [document.manifest.name, audioTrackLabel(document, cue.trackId), cue.owner, sequenceTimecode(document.manifest, cue.startFrame), sequenceTimecode(document.manifest, cue.endFrame), cue.text, document.source_path.split(/[\\/]/).pop() ?? "", cue.startSeconds, cue.endSeconds, cue.engine, cue.model, "Mic owner label, not verified speaker", "ASR timing unverified"]),
    ...untimed.map((cue) => [document.manifest.name, audioTrackLabel(document, cue.trackId), cue.owner, "", "", cue.text, document.source_path.split(/[\\/]/).pop() ?? "", "", "", cue.engine, cue.model, "Mic owner label, not verified speaker", `Timing needs review: ${cue.reason} Reported: ${cue.reported_timing}`]),
  ].map((row) => row.map(csvCell).join(",")).join("\r\n");
  return [transcriptMetadata(document), "Mic owners are labels, not verified speakers. ASR timing is unverified.", "", ...rows.map((cue) =>
    `${sequenceTimecode(document.manifest, cue.startFrame)} - ${sequenceTimecode(document.manifest, cue.endFrame)}  ${cue.owner} (${audioTrackLabel(document, cue.trackId)})\n${cue.text}\n`), ...(untimed.length ? ["Untimed text (timing needs review)", ""] : []), ...untimed.map((cue) =>
    `Timing needs review  ${cue.owner} (${audioTrackLabel(document, cue.trackId)})\n${cue.text}\n${cue.reason} Reported: ${cue.reported_timing}\n`)].join("\n");
}
