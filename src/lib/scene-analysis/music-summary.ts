import type { AudioEvidence } from "./evidence";

/** Presentation policy for the pinned AST output, not calibrated probabilities.
 * Conservative abstention and broad AudioSet genre families avoid turning the
 * highest of 527 scores into an asserted sound. Keep raw evidence unchanged.
 * Taxonomy: https://research.google.com/audioset/ontology/music_genre_1.html
 */
export const MUSIC_SUMMARY_POLICY = Object.freeze({
  version: "audioset-music-summary.v1",
  minimumWindowUs: 5_000_000,
  minimumMusicScore: 0.5,
  minimumStyleScore: 0.1,
  minimumStyleRatio: 1.5,
});
const CLASSIFIER = "ast-audioset@f826b80d28226b62986cc218e5cec390b1096902";
const PREPROCESSING = "pyav-swr16k-mono-10s-kaldi-ast-v1";

// Parent/child labels are correlated, not independent votes. Use each family's
// maximum, never their sum. Instrument, mood and usage labels are not genres.
const FAMILIES: readonly (readonly string[])[] = [
  ["Pop music"], ["Hip hop music", "Beatboxing"],
  ["Rock music", "Heavy metal", "Punk rock", "Grunge", "Progressive rock", "Rock and roll", "Psychedelic rock"],
  ["Rhythm and blues"], ["Soul music"], ["Reggae"], ["Country", "Bluegrass"],
  ["Funk"], ["Folk music"], ["Middle Eastern music"], ["Jazz", "Swing music"], ["Disco"],
  ["Classical music", "Opera"],
  ["Electronic music", "House music", "Techno", "Dubstep", "Drum and bass", "Electronica", "Electronic dance music", "Ambient music", "Trance music"],
  ["Music of Latin America", "Salsa music", "Flamenco"], ["Blues"], ["Music for children"],
  ["New-age music"], ["Vocal music", "A capella"], ["Music of Africa", "Afrobeat"],
  ["Christian music", "Gospel music"], ["Music of Asia", "Carnatic music", "Music of Bollywood"],
  ["Ska"], ["Traditional music"], ["Independent music"],
];

export type MusicWindowSummary = {
  startUs: number; endUs: number;
  kind: "silence" | "short" | "unclear" | "music";
  style: string | null;
};
export type MusicSummary = {
  policyVersion: string;
  styles: string[];
  windows: MusicWindowSummary[];
};

/** This is only a view over completed native evidence. No extra inference,
 * timestamps, threshold-derived song boundaries, or negative "no music" claim.
 */
export function summarizeMusic(evidence: AudioEvidence): MusicSummary | null {
  if (!("labels" in evidence) || evidence.classifier !== CLASSIFIER
    || evidence.preprocessing_version !== PREPROCESSING || evidence.status !== "decoded"
    || !evidence.windows.length) return null;
  const indices = new Map(evidence.labels.map((label, index) => [label, index]));
  if (indices.size !== evidence.labels.length || !indices.has("Music")) return null;
  const groups = FAMILIES.map(labels => ({ name: labels[0], indices: labels.flatMap(label => {
    const index = indices.get(label); return index === undefined ? [] : [index];
  }) }));
  const styles = new Map<string, number>();
  const policy = MUSIC_SUMMARY_POLICY;
  const windows = evidence.windows.map(window => {
    const row: MusicWindowSummary = { startUs: window.start_us, endUs: window.end_us, kind: "unclear", style: null };
    if (window.status === "digital-silence") return { ...row, kind: "silence" as const };
    if (window.status !== "classified" || window.end_us - window.start_us < policy.minimumWindowUs) {
      return { ...row, kind: "short" as const };
    }
    if (!Number.isFinite(window.peak) || !Number.isFinite(window.rms) || window.peak <= 0 || window.rms <= 0
      || window.scores.length !== evidence.labels.length
      || window.scores.some(score => !Number.isFinite(score) || score < 0 || score > 1)
      || window.scores[indices.get("Music")!] < policy.minimumMusicScore) return row;
    row.kind = "music";
    const ranked = groups.map(group => ({ name: group.name,
      score: group.indices.reduce((maximum, index) => Math.max(maximum, window.scores[index]), 0) }))
      .sort((a, b) => b.score - a.score);
    const [best, next] = ranked;
    if (best.score >= policy.minimumStyleScore && best.score >= next.score * policy.minimumStyleRatio) {
      row.style = best.name;
      styles.set(best.name, (styles.get(best.name) ?? 0) + window.end_us - window.start_us);
    }
    return row;
  });
  return { policyVersion: policy.version, windows,
    styles: [...styles.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name) };
}
