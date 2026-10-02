import type { AudioEvidence } from "./evidence";
import { AUDIOSET_CLASSIFIER, AUDIOSET_PREPROCESSING } from "./music-summary";
import { secondsToFrames } from "../timecode";

/** A versioned display policy, not calibrated probabilities or an event detector.
 * Independent labels can coexist. Never infer SFX from the absence of speech/music.
 * Reference and validation limits: docs/AUDIO-CONTENT-RESEARCH.md. */
export const AUDIO_CONTENT_POLICY = Object.freeze({ version: "audio-content.v1", minimumScore: 0.5,
  astContextUs: 5_000_000, appleContextUs: 3_000_000 });
export type AudioContentKind = "speech" | "music" | "mixed" | "sfx" | "silence" | "unclear" | "gap";
export type AudioContentRange = { startFrame: number; endFrame: number; kind: AudioContentKind; sounds: string[] };
export const AUDIO_CONTENT_NAMES: Record<AudioContentKind, string> = {
  speech: "Speech", music: "Music", mixed: "Speech + Music", sfx: "SFX", silence: "Silence", unclear: "Unclassified", gap: "Not analyzed",
};

// Broad, source-independent classes only. Do not expose inferred gender/age or
// turn a musical instrument, mood, room/noise label into a production sound effect.
const SPEECH = new Set(["speech", "conversation", "narration, monologue", "whispering", "shout", "yell", "speech synthesizer"]);
const SOUNDS: Record<string, string> = {
  applause: "Applause", clapping: "Clapping", laughter: "Laughter", cheering: "Cheering",
  footsteps: "Footsteps", walk: "Footsteps", knock: "Knocking", knocking: "Knocking", door: "Door", doorbell: "Doorbell",
  slam: "Slam", glass: "Glass", shatter: "Glass breaking", "glass breaking": "Glass breaking",
  explosion: "Explosion", "gunshot, gunfire": "Gunfire", gunshot: "Gunfire", fireworks: "Fireworks",
  dog: "Dog", bark: "Barking", barking: "Barking", cat: "Cat", meow: "Meowing", bird: "Bird", "bird vocalization, bird call, bird song": "Bird call",
  engine: "Engine", vehicle: "Vehicle", car: "Car", train: "Train", aircraft: "Aircraft", helicopter: "Helicopter",
  siren: "Siren", alarm: "Alarm", "car alarm": "Car alarm", "car horn, honking": "Car horn", "telephone bell ringing": "Telephone",
  rain: "Rain", thunder: "Thunder", wind: "Wind", water: "Water", waves: "Waves", "waves, surf": "Waves", fire: "Fire",
};

/** Retain source order/values; consumers can rank a copy for diagnostics. */
export function audioScores(evidence: AudioEvidence, index: number): { identifier: string; score: number }[] {
  const window = evidence.windows[index];
  if ("labels" in evidence && "scores" in window) {
    if (new Set(evidence.labels).size !== evidence.labels.length || window.scores.length !== evidence.labels.length) return [];
    return window.scores.map((score, i) => ({ identifier: evidence.labels[i], score }));
  }
  return "classifications" in window ? [...window.classifications] : [];
}

function content(evidence: AudioEvidence, index: number): Pick<AudioContentRange, "kind" | "sounds"> {
  const window = evidence.windows[index];
  const unclear: Pick<AudioContentRange, "kind" | "sounds"> = { kind: "unclear", sounds: [] };
  if (window.status === "digital-silence" && window.rms === 0 && window.peak === 0) return { kind: "silence", sounds: [] };
  const ast = evidence.classifier === AUDIOSET_CLASSIFIER && evidence.preprocessing_version === AUDIOSET_PREPROCESSING && "labels" in evidence;
  const apple = evidence.classifier === "apple-soundanalysis-version1" && evidence.preprocessing_version === "pcm48k-mono-3s-nonoverlap-v1" && !("labels" in evidence);
  if ((!ast && !apple) || window.status !== "classified"
    || window.end_us - window.start_us < (ast ? AUDIO_CONTENT_POLICY.astContextUs : AUDIO_CONTENT_POLICY.appleContextUs)
    || !Number.isFinite(window.rms) || !Number.isFinite(window.peak) || window.rms <= 0 || window.peak <= 0) return unclear;
  const scores = audioScores(evidence, index);
  if (!scores.length || scores.some(item => !Number.isFinite(item.score) || item.score < 0 || item.score > 1)) return unclear;
  const strong = scores.filter(item => item.score >= AUDIO_CONTENT_POLICY.minimumScore)
    .map(item => ({ ...item, identifier: item.identifier.replaceAll("_", " ").toLowerCase() })).sort((a, b) => b.score - a.score);
  const speech = strong.some(item => SPEECH.has(item.identifier)), music = strong.some(item => item.identifier === "music");
  const sounds = [...new Set(strong.flatMap(item => Object.hasOwn(SOUNDS, item.identifier) ? [SOUNDS[item.identifier]] : []))].slice(0, 2);
  return { kind: speech && music ? "mixed" : speech ? "speech" : music ? "music" : sounds.length ? "sfx" : "unclear", sounds };
}

/** Floor shared endpoints to the source frame grid, as Clip does. Sub-frame
 * fragments stay in diagnostics, not as zero-length or invented one-frame rows.
 * Gaps never become silence; native PCM timing and evidence remain untouched. */
export function summarizeAudio(evidence: AudioEvidence, fps: number) {
  const ranges: AudioContentRange[] = [];
  let subframeWindows = 0, cursor = 0;
  if (!Number.isFinite(fps) || fps <= 0 || evidence.status !== "decoded") return { ranges, subframeWindows };
  const total = secondsToFrames(evidence.source.duration_us / 1e6, fps);
  const append = (row: AudioContentRange) => {
    if (row.endFrame > row.startFrame) ranges.push(row);
  };
  for (const [index, window] of evidence.windows.entries()) {
    if (!Number.isSafeInteger(window.start_us) || !Number.isSafeInteger(window.end_us)
      || window.start_us < 0 || window.end_us <= window.start_us || window.end_us > evidence.source.duration_us) continue;
    const startFrame = secondsToFrames(window.start_us / 1e6, fps), endFrame = secondsToFrames(window.end_us / 1e6, fps);
    if (startFrame > cursor) append({ startFrame: cursor, endFrame: startFrame, kind: "gap", sounds: [] });
    if (endFrame === startFrame) subframeWindows++;
    else append({ startFrame, endFrame, ...content(evidence, index) });
    cursor = Math.max(cursor, endFrame);
  }
  if (cursor < total) append({ startFrame: cursor, endFrame: total, kind: "gap", sounds: [] });
  return { ranges, subframeWindows };
}
