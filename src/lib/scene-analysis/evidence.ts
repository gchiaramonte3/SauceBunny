import type { VideoSceneProxy } from "../../bindings/VideoSceneProxy";
import type { VideoShot } from "../../bindings/VideoShot";
import type { VideoShotAnalysis } from "../../bindings/VideoShotAnalysis";
import type { Cue } from "../srt";
import type { SceneAnalysisResult } from "./mediabunny-scene-analysis";

type Immutable<T> = T extends readonly (infer U)[] ? readonly Immutable<U>[]
  : T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
export type DetectedShot = VideoShot & { contextLimited: boolean; modelTranscript: string };
export type SceneEvidence = Immutable<{
  schemaVersion: "sauce.scene-evidence.v1";
  id: string;
  proxy: VideoSceneProxy;
  detection: SceneAnalysisResult;
  shots: DetectedShot[];
}>;

function freeze<T>(value: T): Immutable<T> {
  if (value && typeof value === "object") {
    Object.values(value).forEach(child => freeze(child));
    Object.freeze(value);
  }
  return value as Immutable<T>;
}
function integer(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid source timestamp");
}
function utf8Prefix(text: string, maximumBytes: number) {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maximumBytes) return text;
  let result = "", size = 0;
  for (const character of text) {
    size += encoder.encode(character).length;
    if (size > maximumBytes) break;
    result += character;
  }
  return result;
}

/** Versioned proxy times map to source-relative times, never inferred FPS. */
export function sourceTime(pts: number, proxy: Immutable<VideoSceneProxy>): number {
  integer(pts);
  let previousAnalysis = 0, previousSource = 0;
  for (const span of proxy.time_map) {
    Object.values(span).forEach(integer);
    if (span.analysis_start_us !== previousAnalysis || span.source_start_us !== previousSource
      || span.analysis_end_us <= previousAnalysis || span.source_end_us <= previousSource) {
      throw new Error("Analysis time map must be continuous and increasing");
    }
    previousAnalysis = span.analysis_end_us;
    previousSource = span.source_end_us;
  }
  if (!proxy.time_map.length || previousSource !== proxy.source.duration_us) throw new Error("Incomplete analysis time map");
  const span = proxy.time_map.find(s => pts >= s.analysis_start_us && pts < s.analysis_end_us)
    ?? (pts === previousAnalysis ? proxy.time_map.at(-1) : undefined);
  if (!span) throw new Error("Detected frame is outside its analysis time map");
  const numerator = BigInt(pts - span.analysis_start_us) * BigInt(span.source_end_us - span.source_start_us);
  const denominator = BigInt(span.analysis_end_us - span.analysis_start_us);
  return span.source_start_us + Number((numerator + denominator / 2n) / denominator);
}

export async function createSceneEvidence(proxy: VideoSceneProxy, detection: SceneAnalysisResult, cues: Cue[]): Promise<SceneEvidence> {
  if (proxy.schema_version !== "sauce.scene-proxy.v1" || proxy.time_map_version !== "relative-pts-us-v1"
    || proxy.proxy_version !== "h264-vt-540p-all-frames-v1"
    || detection.profile !== "mediabunny-full-frame" || detection.schemaVersion !== "ella.scene-analysis.v1"
    || !/^[a-f0-9]{64}$/.test(proxy.source.sha256) || !/^[a-f0-9]{64}$/.test(proxy.sha256)
    || !/^[a-f0-9]{64}$/.test(proxy.pts_sha256)
    || detection.source.frameCount !== proxy.frame_count || detection.source.ptsSha256 !== proxy.pts_sha256) {
    throw new Error("Decoded analysis frames do not match the verified source proxy");
  }
  integer(proxy.frame_count); integer(proxy.source.duration_us);
  if (!proxy.frame_count || !proxy.source.duration_us) throw new Error("Empty source analysis");
  sourceTime(0, proxy); // Validate the entire map even when no cuts were found.
  const starts = [0];
  let previousFrame = 0;
  for (const cut of detection.boundaries) {
    integer(cut.beforeFrameIndex); integer(cut.afterFrameIndex);
    if (cut.afterFrameIndex !== cut.beforeFrameIndex + 1 || cut.afterFrameIndex <= previousFrame
      || cut.afterFrameIndex >= proxy.frame_count || cut.beforePtsUs >= cut.afterPtsUs) throw new Error("Invalid detected cut order");
    const start = sourceTime(cut.afterPtsUs, proxy);
    sourceTime(cut.beforePtsUs, proxy);
    if (start <= starts.at(-1)! || start >= proxy.source.duration_us) throw new Error("Invalid detected shot range");
    starts.push(start); previousFrame = cut.afterFrameIndex;
  }
  const orderedCues = cues.filter(cue => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start)
    .slice().sort((a, b) => a.start - b.start);
  let cueStart = 0;
  const shots = starts.map((start_us, index) => {
    const end_us = starts[index + 1] ?? proxy.source.duration_us;
    while (cueStart < orderedCues.length && Math.round(orderedCues[cueStart].end * 1e6) <= start_us) cueStart++;
    const lines = [];
    for (let i = cueStart; i < orderedCues.length && Math.round(orderedCues[i].start * 1e6) < end_us; i++) {
      const cue = orderedCues[i];
      if (Math.round(cue.end * 1e6) > start_us) lines.push(`${cue.speaker ? `${cue.speaker}: ` : ""}${cue.text}`);
    }
    // A cue crossing a cut belongs to both shots. Do not invent word timing.
    const transcript = lines.join("\n");
    const modelTranscript = utf8Prefix(transcript, 12_000);
    return { id: index + 1, start_us, end_us, transcript, modelTranscript, contextLimited: modelTranscript !== transcript };
  });
  const content = structuredClone({ schemaVersion: "sauce.scene-evidence.v1" as const, proxy, detection, shots });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(content)));
  let id = "";
  for (const byte of new Uint8Array(digest)) id += byte.toString(16).padStart(2, "0");
  return freeze({ ...content, id });
}

/** Leave request overhead below the native 256 KiB limit, including JSON escaping. */
export function shotBatches(evidence: SceneEvidence): VideoShot[][] {
  const batches: VideoShot[][] = [];
  let batch: VideoShot[] = [], bytes = 0;
  for (const shot of evidence.shots) {
    const request = { id: shot.id, start_us: shot.start_us, end_us: shot.end_us, transcript: shot.modelTranscript };
    const size = new TextEncoder().encode(JSON.stringify(request)).length + 1;
    if (batch.length && (batch.length === 64 || bytes + size > 192 * 1024)) {
      batches.push(batch); batch = []; bytes = 0;
    }
    batch.push(request); bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function validateShotAnswers(evidence: SceneEvidence, requested: VideoShot[], answer: VideoShotAnalysis) {
  if (answer.analysis_id !== evidence.id || answer.source.sha256 !== evidence.proxy.source.sha256
    || answer.source.duration_us !== evidence.proxy.source.duration_us || answer.audio_analyzed
    || answer.shots.length !== requested.length) throw new Error("Video analysis returned unrelated source evidence");
  answer.shots.forEach((shot, index) => {
    const expected = requested[index];
    if (shot.id !== expected.id || shot.start_us !== expected.start_us || shot.end_us !== expected.end_us
      || shot.transcript !== expected.transcript || !shot.text.trim() || !shot.frame_pts_us.length
      || shot.frame_pts_us.some((pts, i) => !Number.isSafeInteger(pts) || pts < shot.start_us || pts >= shot.end_us
        || (i > 0 && pts <= shot.frame_pts_us[i - 1]))) throw new Error("Video analysis changed a detected shot");
  });
}

/** Append-only machine evidence; user text and model descriptions cannot edit it. */
export async function saveSceneEvidence(evidence: SceneEvidence): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("sauce-scene-evidence", 1);
    let settled = false;
    request.onupgradeneeded = () => { request.result.createObjectStore("detections", { keyPath: "id" }); };
    request.onsuccess = () => { if (settled) request.result.close(); else { settled = true; resolve(request.result); } };
    request.onerror = () => { settled = true; reject(request.error); };
    request.onblocked = () => { settled = true; reject(new Error("Close the other analysis panel to update its evidence store")); };
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("detections", "readwrite");
      transaction.objectStore("detections").add(evidence);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error("Could not save shot evidence"));
      transaction.onerror = () => reject(transaction.error);
    });
  } finally { db.close(); }
}
