import { describe, it, expect } from "vitest";
import { analysisSidecarPath, analysisIsStale, type TranscriptAnalysis } from "./transcript-analysis";

describe("analysisSidecarPath", () => {
  it("swaps any transcript extension for .analysis.json", () => {
    expect(analysisSidecarPath("/tx/2026-07/My Clip.srt")).toBe("/tx/2026-07/My Clip.analysis.json");
    expect(analysisSidecarPath("/tx/My Clip.vtt")).toBe("/tx/My Clip.analysis.json");
    // Dotted basename keeps everything before the final extension.
    expect(analysisSidecarPath("/tx/a.b.c.srt")).toBe("/tx/a.b.c.analysis.json");
  });
});

describe("analysisIsStale", () => {
  const doc: TranscriptAnalysis = {
    schemaVersion: 1, model: "m", generatedAt: 5000,
    style: { format: "bullets", length: "standard" },
    markdown: "x", srtSizeBytes: 1000, srtModifiedMs: 4000,
  };
  it("is fresh when the SRT is unchanged since the analysis ran", () => {
    expect(analysisIsStale(doc, 1000, 4000)).toBe(false);
  });
  it("is stale when the SRT size changed (an edit)", () => {
    expect(analysisIsStale(doc, 1200, 4000)).toBe(true);
  });
  it("is stale when the SRT was rewritten after the analysis ran", () => {
    expect(analysisIsStale(doc, 1000, 6000)).toBe(true); // mtime past generatedAt
  });
});
