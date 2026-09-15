import { describe, expect, it } from "vitest";
import { multitrackFixture, multitrackTranscript } from "../test/multitrack-fixture";
import { clampFrame, exportMultitrack, mergeTrackTranscript, sampleFrame, sequenceTimecode, transcriptRows, waveformPath } from "./multitrack";

describe("multitrack sequence timing and export", () => {
  it("keeps sequence sample time independent of source timecode at fractional rates", () => {
    const doc = multitrackFixture();
    expect(sequenceTimecode(doc.manifest, 0)).toBe("01:00:00:00");
    expect(sampleFrame(16_016_000, doc.manifest)).toBe(24000);
    const next = mergeTrackTranscript(doc, multitrackTranscript());
    expect(transcriptRows(next)[0].startFrame).toBe(239);
    expect(sequenceTimecode(doc.manifest, 239)).toBe("01:00:09:23");
    expect(clampFrame(NaN, 100)).toBe(0);
    expect(clampFrame(101, 100)).toBe(99);
  });
  it("replaces a prior track range without duplicating old cues", () => {
    let doc = mergeTrackTranscript(multitrackFixture(), multitrackTranscript());
    doc = mergeTrackTranscript(doc, { ...multitrackTranscript(), start_frame: 12000, cues: [] });
    expect(doc.transcripts).toHaveLength(1);
    expect(doc.transcripts[0].start_frame).toBe(12000);
    expect(transcriptRows(doc)).toEqual([]);
  });
  it("exports attribution and timing caveats and guards spreadsheet formulas", () => {
    const doc = multitrackFixture();
    doc.labels[0].owner_name = " =HYPERLINK(\"bad\")";
    doc.transcripts = [{ ...multitrackTranscript(), cues: [{ ...multitrackTranscript().cues[0], text: "@danger\nA second line, quoted" }] }];
    const csv = exportMultitrack(doc, "csv");
    expect(csv).toContain('"sequence","track","speaker","start_tc","end_tc","text","source_file"');
    expect(csv).toContain("' =HYPERLINK"); expect(csv).toContain("'@danger");
    expect(csv).toContain('"Interview.aaf"'); expect(csv).not.toContain("/fixtures/");
    expect(csv).toContain("ASR timing unverified");
    expect(exportMultitrack(doc, "txt")).toContain("not verified speakers");
  });
  it("creates bounded waveform paths from the visible peak range", () => {
    const peaks = [[-0.1, 0.1], [-1, 0.8], [-0.4, 0.5], [0, 0]];
    expect(waveformPath([], 0, 1)).toBe("");
    expect(waveformPath(peaks, 0.5, 1)).toContain("M250.00,17.50V40.00");
    expect(waveformPath(peaks, 0, 1, 2).match(/M/g)).toHaveLength(2);
  });
});
