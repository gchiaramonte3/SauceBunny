import { describe, expect, it } from "vitest";
import type { VideoMusicAnalysis } from "../../bindings/VideoMusicAnalysis";
import type { VideoAudioAnalysis } from "../../bindings/VideoAudioAnalysis";
import { AUDIOSET_CLASSIFIER, AUDIOSET_PREPROCESSING } from "./music-summary";
import { AUDIO_CONTENT_POLICY, audioScores, summarizeAudio } from "./audio-summary";

function fixture(scores = [.6, .7, .32, .1]): VideoMusicAnalysis {
  return { analysis_id: "test", source: { path: "/clip.mp4", sha256: "test", origin_us: 5e6, duration_us: 10e6 },
    audio_track_index: 0, classifier: AUDIOSET_CLASSIFIER, preprocessing_version: AUDIOSET_PREPROCESSING, os: "Test",
    status: "decoded", labels: ["Speech", "Music", "Throbbing", "Explosion"],
    windows: [{ start_us: 0, end_us: 10e6, rms: .2, peak: .5, status: "classified", scores }] };
}
describe("audio content suggestions and source-frame presentation", () => {
  it.each([
    { scores: [.9, .1, .1, .1], kind: "speech" }, { scores: [.1, .9, .1, .1], kind: "music" },
    { scores: [.6, .7, .32, .1], kind: "mixed" }, { scores: [.1, .1, .1, .8], kind: "sfx" },
    { scores: [.1, .1, .99, .1], kind: "unclear" }, { scores: [.1, .1, .1, .1], kind: "unclear" },
  ])("maps independent scores to $kind without exposing the top-score noise", ({ scores, kind }) => {
    const evidence = fixture(scores), before = structuredClone(evidence);
    expect(summarizeAudio(evidence, 24).ranges[0].kind).toBe(kind);
    expect(evidence).toEqual(before);
    expect(Object.isFrozen(AUDIO_CONTENT_POLICY)).toBe(true);
  });
  it("keeps strong SFX alongside speech/music and ignores unknown instruments/moods as SFX", () => {
    expect(summarizeAudio(fixture([.8, .9, .3, .7]), 24).ranges[0]).toMatchObject({ kind: "mixed", sounds: ["Explosion"] });
    const evidence = fixture([.1, .1, .95, .95]); evidence.labels = ["Speech", "Music", "Piano", "Happy music"];
    expect(summarizeAudio(evidence, 24).ranges[0]).toMatchObject({ kind: "unclear", sounds: [] });
  });
  it("requires the pinned preprocessing and classifier; unsupported evidence remains unclassified", () => {
    for (const evidence of [{ ...fixture(), classifier: "changed" }, { ...fixture(), preprocessing_version: "changed" }]) {
      expect(summarizeAudio(evidence, 24).ranges[0].kind).toBe("unclear");
    }
  });
  it("rejects malformed vectors, duplicate labels and zero energy without inferring silence", () => {
    const evidence = fixture(); evidence.windows[0].rms = 0;
    const duplicate = fixture(); duplicate.labels = ["Speech", "Speech", "Music", "Explosion"];
    for (const item of [evidence, duplicate, fixture([NaN, .9, 0, 0]), fixture([2, .9, 0, 0]), fixture([.9])]) {
      expect(summarizeAudio(item, 24).ranges[0].kind).toBe("unclear");
    }
  });
  it("keeps silence, gaps, short tails and unclassified audio distinct", () => {
    const evidence = fixture(); evidence.source.duration_us = 25e6;
    evidence.windows.push(
      { start_us: 10e6, end_us: 15e6, rms: 0, peak: 0, status: "digital-silence", scores: [] },
      { start_us: 17e6, end_us: 18e6, rms: .2, peak: .5, status: "classified", scores: [.99, .99, 0, 0] },
      { start_us: 18e6, end_us: 19e6, rms: .2, peak: .5, status: "insufficient-context", scores: [] },
    );
    expect(summarizeAudio(evidence, 24).ranges.map(row => row.kind)).toEqual(["mixed", "silence", "gap", "unclear", "unclear", "gap"]);
  });
  it.each([24000 / 1001, 24, 25, 30000 / 1001, 60000 / 1001])("uses shared, positive, non-overlapping frame boundaries at %s fps", fps => {
    const evidence = fixture(); evidence.source.duration_us = 20e6;
    evidence.windows[0].start_us = 13;
    evidence.windows.unshift({ start_us: 0, end_us: 13, rms: .1, peak: .2, status: "insufficient-context", scores: [] });
    evidence.windows.push({ ...evidence.windows[1], start_us: 10e6, end_us: 20e6 });
    const before = structuredClone(evidence), summary = summarizeAudio(evidence, fps);
    expect(summary.subframeWindows).toBe(1);
    expect(summary.ranges).toHaveLength(2);
    expect(summary.ranges[0]).toMatchObject({ startFrame: 0, endFrame: Math.floor(10 * fps) });
    expect(summary.ranges[1]).toMatchObject({ startFrame: Math.floor(10 * fps), endFrame: Math.floor(20 * fps) });
    expect(evidence).toEqual(before);
  });
  it("retains the Apple classifier fallback without reinterpreting its scores as AST", () => {
    const ast = fixture();
    const evidence: VideoAudioAnalysis = { ...ast, classifier: "apple-soundanalysis-version1", preprocessing_version: "pcm48k-mono-3s-nonoverlap-v1",
      windows: [{ start_us: 0, end_us: 10e6, rms: .2, peak: .5, status: "classified", classifications: [
        { identifier: "speech", score: .8 }, { identifier: "music", score: .8 }, { identifier: "glass_breaking", score: .9 },
      ] }] };
    // Strip the AST-only vocabulary, as the native fallback actually does.
    const { labels: _, ...apple } = evidence as VideoAudioAnalysis & { labels?: string[] };
    expect(summarizeAudio(apple, 24).ranges[0]).toMatchObject({ kind: "mixed", sounds: ["Glass breaking"] });
    expect(audioScores(apple, 0)[0]).toEqual({ identifier: "speech", score: .8 });
  });
  it.each([0, -1, NaN, Infinity])("does not invent a rate when fps is %s", fps => {
    expect(summarizeAudio(fixture(), fps).ranges).toEqual([]);
  });
});
