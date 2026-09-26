import { describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import type { VideoSceneProxy } from "../../bindings/VideoSceneProxy";
import type { SceneAnalysisResult } from "./mediabunny-scene-analysis";
import { createAudioEvidence, createSceneEvidence, sceneCutMarkers, shotBatches, sourceTime, validateShotAnswers } from "./evidence";
import type { VideoAudioAnalysis } from "../../bindings/VideoAudioAnalysis";
import type { VideoMusicAnalysis } from "../../bindings/VideoMusicAnalysis";
import { DEFAULT_DETECTOR_CONFIG } from "./detector-core";

Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
export function fixtures(cuts = 11) {
  const proxy: VideoSceneProxy = {
    schema_version: "sauce.scene-proxy.v1", proxy_version: "h264-vt-540p-display-frames-v2", time_map_version: "relative-pts-us-v1",
    source: { path: "/source.mp4", sha256: "a".repeat(64), duration_us: (cuts + 1) * 1e6, origin_us: 7e6 },
    path: "/proxy.mp4", sha256: "b".repeat(64), pts_sha256: "c".repeat(64), frame_count: (cuts + 1) * 30,
    time_map: [{ analysis_start_us: 0, analysis_end_us: (cuts + 1) * 1e6, source_start_us: 0, source_end_us: (cuts + 1) * 1e6 }],
  };
  const detection: SceneAnalysisResult = {
    schemaVersion: "ella.scene-analysis.v1", profile: "mediabunny-full-frame", durationUs: proxy.source.duration_us,
    source: { fileName: "proxy.mp4", codec: "avc1", width: 960, height: 540, frameCount: proxy.frame_count, ptsSha256: proxy.pts_sha256 },
    boundaries: Array.from({ length: cuts }, (_, i) => ({ id: `cut-${i}`, type: "cut" as const,
      beforePtsUs: (i + 1) * 1e6 - 33333, afterPtsUs: (i + 1) * 1e6, beforeFrameIndex: (i + 1) * 30 - 1,
      afterFrameIndex: (i + 1) * 30, score: 1, components: { histogram: 1, content: 1, lumaJump: 1,
        localBaseline: 0, localThreshold: .5, flashReturn: null, activeNeighborRatio: 0, contextDrift: 1 }, flags: [], origin: "machine" as const })),
    timelineScores: [], analysis: { library: "mediabunny", libraryVersion: "1.52.3", width: 160, height: 90,
      config: DEFAULT_DETECTOR_CONFIG, peakRetainedFeatureFrames: 31 },
    performance: { elapsedMs: 100, framesPerSecond: 100, realtimeMultiple: 2 },
  };
  return { proxy, detection };
}

describe("source-bound shot evidence", () => {
  it("maps only shot changes to cut markers without adding container origin or a marker at zero", async () => {
    const { proxy, detection } = fixtures(1);
    proxy.source.duration_us = 3_000_003;
    proxy.time_map[0].source_end_us = 3_000_003;
    const evidence = await createSceneEvidence(proxy, detection, []);
    const cuts = sceneCutMarkers(evidence);
    expect(cuts).toEqual([{ time: 1.500002 }]);
    cuts[0].time = 2;
    expect(sceneCutMarkers(evidence)[0].time).toBe(1.500002);
    expect(evidence.shots[1].start_us).toBe(1_500_002);
    expect(evidence.proxy.time_map_version).toBe("relative-pts-us-v1");
  });
  it("freezes the music vocabulary and full score vectors independently of worker output", async () => {
    const { proxy, detection } = fixtures();
    const scene = await createSceneEvidence(proxy, detection, []);
    const audio: VideoMusicAnalysis = { analysis_id: scene.id, source: proxy.source, audio_track_index: 0,
      classifier: "ast-audioset@pinned", os: "test", preprocessing_version: "test", status: "decoded",
      labels: ["Music", "Speech"],
      windows: [{ start_us: 0, end_us: 10e6, rms: .1, peak: .2, status: "classified", scores: [.8, .1] }] };
    const result = createAudioEvidence(scene, audio);
    const window = result.windows[0];
    if (!("labels" in result) || !("scores" in window)) throw new Error("Expected music evidence");
    audio.labels[0] = "Changed"; audio.windows[0].scores[0] = .2;
    expect(result.labels).toEqual(["Music", "Speech"]);
    expect(window.scores).toEqual([.8, .1]);
    expect(Object.isFrozen(result.labels)).toBe(true);
    expect(Object.isFrozen(window.scores)).toBe(true);
    expect(() => createAudioEvidence(scene, { ...audio, analysis_id: "different" })).toThrow(/unrelated source/);
  });
  it("binds actual audio to the exact detection and freezes a separate snapshot", async () => {
    const { proxy, detection } = fixtures();
    const scene = await createSceneEvidence(proxy, detection, []);
    const audio: VideoAudioAnalysis = { analysis_id: scene.id, source: proxy.source, audio_track_index: 0,
      classifier: "apple-soundanalysis-version1", os: "test", preprocessing_version: "pcm48k-mono-3s-nonoverlap-v1", status: "decoded",
      windows: [{ start_us: 0, end_us: 3e6, rms: .1, peak: .2, status: "classified", classifications: [{ identifier: "music", score: .8 }] }] };
    const result = createAudioEvidence(scene, audio);
    audio.windows[0].classifications[0].score = .1;
    const window = result.windows[0];
    if (!("classifications" in window)) throw new Error("Expected native audio evidence");
    expect(window.classifications[0].score).toBe(.8);
    expect(Object.isFrozen(window.classifications[0])).toBe(true);
    for (const wrong of [{ ...audio, analysis_id: "x" }, { ...audio, audio_track_index: 1 },
      ...[{ path: "/other.mp4" }, { sha256: "c".repeat(64) }, { origin_us: 0 }, { duration_us: 10 }]
        .map(change => ({ ...audio, source: { ...audio.source, ...change } }))]) {
      expect(() => createAudioEvidence(scene, wrong)).toThrow(/unrelated source/);
    }
  });
  it("11 cuts create exactly 12 immutable shots, with overlapping speech kept verbatim", async () => {
    const { proxy, detection } = fixtures();
    const evidence = await createSceneEvidence(proxy, detection, [{ index: 1, start: .8, end: 1.2, speaker: "Alex", text: "Across the cut." }]);
    expect(evidence.shots).toHaveLength(12);
    expect(evidence.shots.slice(0, 2).map(shot => shot.transcript)).toEqual(["Alex: Across the cut.", "Alex: Across the cut."]);
    expect(evidence.shots[2].transcript).toBe("");
    expect(evidence.shots.at(-1)!.end_us).toBe(proxy.source.duration_us);
    expect(evidence.id).toMatch(/^[a-f0-9]{64}$/);
    detection.boundaries.length = 0;
    expect(evidence.detection.boundaries).toHaveLength(11);
    expect(Object.isFrozen(evidence.shots[0])).toBe(true);
  });
  it("a continuous clip remains one shot; cue at its end is not borrowed", async () => {
    const { proxy, detection } = fixtures(0);
    const evidence = await createSceneEvidence(proxy, detection, [{ index: 1, start: 1, end: 2, speaker: null, text: "Next clip" }]);
    expect(evidence.shots).toHaveLength(1); expect(evidence.shots[0].transcript).toBe("");
  });
  it("refuses mismatched frame count, PTS proof, malformed cuts, or a missing map", async () => {
    const { proxy, detection } = fixtures();
    for (const broken of [{ ...proxy, frame_count: 1 }, { ...proxy, pts_sha256: "d".repeat(64) }, { ...proxy, time_map: [] }]) {
      await expect(createSceneEvidence(broken, detection, [])).rejects.toThrow();
    }
    await expect(createSceneEvidence(proxy, { ...detection, boundaries: [...detection.boundaries].reverse() }, [])).rejects.toThrow();
  });
  it("refuses cached proxies made before display orientation was preserved", async () => {
    const { proxy, detection } = fixtures();
    await expect(createSceneEvidence({ ...proxy, proxy_version: "h264-vt-540p-all-frames-v1" }, detection, [])).rejects.toThrow();
  });
  it("maps integer proxy PTS through a continuous rational map without FPS", () => {
    const { proxy } = fixtures(0);
    proxy.time_map = [{ analysis_start_us: 0, analysis_end_us: 333333, source_start_us: 0, source_end_us: 1e6 }];
    expect(sourceTime(111111, proxy)).toBe(333333);
    expect(sourceTime(333333, proxy)).toBe(1e6);
    expect(() => sourceTime(333334, proxy)).toThrow();
  });
  it("bounds model context and serialized requests, never the displayed transcript or shot count", async () => {
    const { proxy, detection } = fixtures(129);
    const transcript = "\"🔊\n".repeat(4000);
    const evidence = await createSceneEvidence(proxy, detection, [{ index: 1, start: 0, end: 130, speaker: null, text: transcript }]);
    expect(evidence.shots.every(shot => shot.transcript === transcript && shot.contextLimited)).toBe(true);
    const batches = shotBatches(evidence);
    expect(batches.flat()).toHaveLength(130);
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(64);
      expect(new TextEncoder().encode(JSON.stringify(batch)).length).toBeLessThan(192 * 1024 + 2);
      expect(batch.every(shot => new TextEncoder().encode(shot.transcript).length <= 12000)).toBe(true);
    }
  });
  it("model answers cannot invent shots, move boundaries, change source, or claim audio analysis", async () => {
    const { proxy, detection } = fixtures(0);
    const evidence = await createSceneEvidence(proxy, detection, []);
    const requested = shotBatches(evidence)[0];
    const answer = { analysis_id: evidence.id, source: proxy.source, model_id: "qwen", model_revision: "pinned",
      sampling_version: "shot-spread-8frames-384-display-v2", audio_analyzed: false,
      shots: requested.map(shot => ({ ...shot, text: "Visible scene", frame_pts_us: [0, 33333] })) };
    expect(() => validateShotAnswers(evidence, requested, answer)).not.toThrow();
    for (const wrong of [{ ...answer, audio_analyzed: true }, { ...answer, analysis_id: "x" },
      { ...answer, source: { ...answer.source, path: "/another-source.mp4" } },
      { ...answer, source: { ...answer.source, origin_us: answer.source.origin_us + 1 } },
      { ...answer, shots: [{ ...answer.shots[0], end_us: 99 }] }, { ...answer, shots: [...answer.shots, ...answer.shots] },
      { ...answer, shots: [{ ...answer.shots[0], frame_pts_us: [1000000] }] }]) {
      expect(() => validateShotAnswers(evidence, requested, wrong)).toThrow();
    }
  });
});
