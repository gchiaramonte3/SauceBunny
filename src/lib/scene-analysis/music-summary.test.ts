import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { VideoMusicAnalysis } from "../../bindings/VideoMusicAnalysis";
import { MUSIC_SUMMARY_POLICY, summarizeMusic } from "./music-summary";

const labels = ["Music", "Speech", "Electronic music", "Electronic dance music", "House music", "Classical music", "Jazz",
  "Rock music", "Heavy metal", "Punk rock", "Grunge", "Progressive rock", "Rock and roll", "Psychedelic rock",
  "Piano", "Happy music", "Background music"];
function musicFixture(rows: { start?: number; duration?: number; scores?: Partial<Record<string, number>>; status?: "classified" | "digital-silence" | "insufficient-context" }[] = []) {
  const evidence: VideoMusicAnalysis = { analysis_id: "test", source: { path: "/clip.mp4", sha256: "test", origin_us: 3e6, duration_us: 60e6 },
    audio_track_index: 0, classifier: "ast-audioset@f826b80d28226b62986cc218e5cec390b1096902",
    preprocessing_version: "pyav-swr16k-mono-10s-kaldi-ast-v1", os: "test", status: "decoded", labels: [...labels],
    windows: rows.map((row, index) => ({ start_us: row.start ?? index * 10e6, end_us: (row.start ?? index * 10e6) + (row.duration ?? 10e6),
      rms: row.status === "digital-silence" ? 0 : .2, peak: row.status === "digital-silence" ? 0 : .4,
      status: row.status ?? "classified", scores: row.status ? [] : labels.map(label => row.scores?.[label] ?? 0) })) };
  return evidence;
}

describe("experimental AudioSet music summary", () => {
  it("binds the policy to the supported checkpoint and preprocessing, not an arbitrary classifier", () => {
    const evidence = musicFixture([{ scores: { Music: .9, Jazz: .5 } }]);
    expect(summarizeMusic(evidence)?.policyVersion).toBe("audioset-music-summary.v1");
    expect(summarizeMusic({ ...evidence, classifier: "unreviewed" })).toBeNull();
    expect(summarizeMusic({ ...evidence, preprocessing_version: "changed" })).toBeNull();
    expect(summarizeMusic({ ...evidence, status: "no-audio" })).toBeNull();
    expect(summarizeMusic({ ...evidence, windows: [] })).toBeNull();
    expect(Object.isFrozen(MUSIC_SUMMARY_POLICY)).toBe(true);
  });
  it("preserves actual ranges, gaps and short-tail uncertainty without mutating raw scores", () => {
    const evidence = musicFixture([
      { scores: { Music: .8, "Electronic music": .03 } },
      { start: 12e6, scores: { Music: .8, "Electronic music": .19, "Electronic dance music": .18, "House music": .08 } },
      { start: 22e6, duration: 3.5e6, scores: { Music: .9, Jazz: .8 } },
    ]);
    const before = structuredClone(evidence);
    expect(summarizeMusic(evidence)).toMatchObject({ styles: ["Electronic music"], windows: [
      { startUs: 0, endUs: 10e6, kind: "music", style: null },
      { startUs: 12e6, endUs: 22e6, kind: "music", style: "Electronic music" },
      { startUs: 22e6, endUs: 25.5e6, kind: "short", style: null },
    ] });
    expect(evidence).toEqual(before);
  });
  it.each([
    { Music: .02, Speech: .99, Jazz: .8 },
    { Music: .49, "Electronic music": .8 },
  ])("never forces a style when music itself is uncertain: %j", scores => {
    expect(summarizeMusic(musicFixture([{ scores }]))).toMatchObject({ styles: [], windows: [{ kind: "unclear", style: null }] });
  });
  it.each([
    { Music: .8, "Classical music": .03 },
    { Music: .8, "Rock music": .2, Jazz: .19 },
    { Music: .8, Piano: .9, "Happy music": .9, "Background music": .9 },
    { Music: .8, "Rock music": .04, "Heavy metal": .04, "Punk rock": .04, Grunge: .04,
      "Progressive rock": .04, "Rock and roll": .04, "Psychedelic rock": .04 },
  ])("abstains on weak/conflicting styles, non-genres and correlated votes: %j", scores => {
    expect(summarizeMusic(musicFixture([{ scores }]))).toMatchObject({ styles: [], windows: [{ kind: "music", style: null }] });
  });
  it("uses parent/child families once and orders file suggestions by supporting duration", () => {
    const evidence = musicFixture([
      { scores: { Music: .9, "Electronic music": .3, "Electronic dance music": .29 } },
      { scores: { Music: .8, Jazz: .4 } },
      { scores: { Music: .8, Jazz: .3 } },
    ]);
    expect(summarizeMusic(evidence)?.styles).toEqual(["Jazz", "Electronic music"]);
  });
  it("keeps digital silence and insufficient context out of suggestions", () => {
    expect(summarizeMusic(musicFixture([{ status: "digital-silence" }, { status: "insufficient-context", duration: 20_000 }]))).toMatchObject({
      styles: [], windows: [{ kind: "silence", style: null }, { kind: "short", style: null }],
    });
  });
  it("cannot derive a positive summary from malformed or energy-free classified vectors", () => {
    for (const change of ["nan", "short", "zero-energy"] as const) {
      const evidence = musicFixture([{ scores: { Music: .9, Jazz: .8 } }]);
      if (change === "nan") evidence.windows[0].scores[0] = Number.NaN;
      if (change === "short") evidence.windows[0].scores.pop();
      if (change === "zero-energy") evidence.windows[0].rms = 0;
      expect(summarizeMusic(evidence)?.styles).toEqual([]);
    }
  });
  it.skipIf(!process.env.MUSIC_POLICY_REPORT)("summarizes the real reviewed-fixture worker output without inventing boundaries", () => {
    const report = JSON.parse(readFileSync(process.env.MUSIC_POLICY_REPORT!, "utf8"));
    expect(report.schema).toBe("sauce.music-worker-smoke.v1");
    expect(report.network).toBe("sandbox-denied");
    expect(report.request.source_sha256).toBe("c2b9b3ea9727c598674e7044967d68476cee5772ba7de7458c2951f90cb727e8");
    expect(report.completed.exit_code).toBe(0);
    const packets: { type: string; start_us: number; end_us: number; peak: number; rms: number;
      status: "classified"; scores_f32le: string; labels: string[]; classifier: string; preprocessing_version: string }[] = report.completed.packets;
    const terminal = packets.at(-1)!;
    expect(terminal.type).toBe("complete"); expect(terminal.labels).toHaveLength(527);
    const evidence = { ...musicFixture(), labels: terminal.labels, classifier: terminal.classifier,
      preprocessing_version: terminal.preprocessing_version,
      windows: packets.filter(packet => packet.type === "window").map(packet => {
        const bytes = Buffer.from(packet.scores_f32le, "base64"); expect(bytes.length).toBe(527 * 4);
        return { start_us: packet.start_us, end_us: packet.end_us, peak: packet.peak, rms: packet.rms, status: packet.status,
          scores: Array.from({ length: 527 }, (_, index) => bytes.readFloatLE(index * 4)) };
      }) };
    expect(summarizeMusic(evidence)).toMatchObject({ styles: ["Electronic music"], windows: [
      { startUs: 0, endUs: 10e6, kind: "music", style: null },
      { startUs: 10e6, endUs: 20e6, kind: "music", style: "Electronic music" },
      { startUs: 20e6, endUs: 23.5e6, kind: "short", style: null },
    ] });
  });
});
