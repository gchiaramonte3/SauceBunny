import { describe, expect, it } from "vitest";
import { multitrackFixture, multitrackTranscript } from "../test/multitrack-fixture";
import { exportMultitrack, transcriptRows, untimedTranscriptRows } from "./multitrack";
import { multitrackPrintDoc, multitrackSrt } from "./multitrack-export";
import { multitrackAvidMarkers, multitrackScope } from "./multitrack-person";
import type { AafDocument } from "../bindings/AafDocument";

const emptyOutput = [
  "", " \t\n", ".", "...", "…", "!?", "。！？", "— --", "[ . ]", "\u200b\ufeff",
  "blank audio", "BLANK_AUDIO", "[BLANK_AUDIO]", "(Blank Audio)", "[blank-audio].",
  "  Blank   audio.\n", "[BLANK_AUDIO] [BLANK_AUDIO]", "［ＢＬＡＮＫ＿ＡＵＤＩＯ］",
];
const meaningfulOutput = [
  "[inaudible]", "(unintelligible)", "He said [inaudible] before leaving.",
  "[crosstalk]", "[music]", "♪", "[door slams]", "There's blank audio after this take.",
  "[BLANK_AUDIO] Keep these words.", "Blank audio is not dialogue.", "A.", "7", "你好。", "نعم.", "Oui…",
];

function withText(text: string) {
  const document = multitrackFixture(), track = multitrackTranscript();
  track.cues[0].text = text;
  track.timing_issues = [{ id: "untimed", text, reason: "Invalid timing", reported_timing: "invalid", chunk_start_frame: 0 }];
  document.transcripts = [track];
  return document;
}

describe("multitrack transcript content", () => {
  it.each(emptyOutput)("omits empty output %j from timed and untimed rows without changing saved results", (text) => {
    const document = withText(text), saved = structuredClone(document);
    expect(transcriptRows(document)).toEqual([]);
    expect(untimedTranscriptRows(document)).toEqual([]);
    expect(document).toEqual(saved);
    expect(document.transcripts[0].status).toBe("completed");
  });
  it.each(meaningfulOutput)("preserves meaningful text %j verbatim, including uncertain speech", (text) => {
    const document = withText(text);
    expect(transcriptRows(document).map((row) => row.text)).toEqual([text]);
    expect(untimedTranscriptRows(document).map((row) => row.text)).toEqual([text]);
  });
});

const exporters: [string, (document: AafDocument) => string][] = [
  ["TXT", (document) => exportMultitrack(document, "txt")],
  ["CSV", (document) => exportMultitrack(document, "csv")],
  ["PDF / Print", (document) => multitrackPrintDoc(document, "All voices")],
  ["SRT", multitrackSrt],
  ["Avid markers", multitrackAvidMarkers],
];

describe("consistent multitrack export cleanup", () => {
  it.each(exporters)("filters %s before formatting, preserving dialogue, timing, lanes and colors", (_name, exportDocument) => {
    const document = multitrackFixture(), track = multitrackTranscript(), second = multitrackTranscript("track-2");
    const cue = track.cues[0];
    track.cues = emptyOutput.map((text, index) => ({ ...cue, id: `empty-${index}`, text, start_sample: index * 1000, end_sample: (index + 1) * 1000 }));
    track.timing_issues = emptyOutput.map((text, index) => ({ id: `empty-untimed-${index}`, text, reason: "Invalid timing", reported_timing: "invalid", chunk_start_frame: 0 }));
    track.timing_issues.push({ id: "untimed-words", text: "Keep [inaudible] here.", reason: "Invalid timing", reported_timing: "invalid", chunk_start_frame: 0 });
    second.cues = meaningfulOutput.map((text, index) => ({ ...cue, id: `words-${index}`, text, start_sample: (index + 1) * 16000, end_sample: (index + 2) * 16000 }));
    document.manifest.tracks[1].physical_track_number = 50;
    document.labels.push({ track_id: "track-2", owner_name: "Sam", cast_member_id: null, color: null, marker_color: "pink" });
    document.transcripts = [track, second];
    const saved = structuredClone(document), clean = structuredClone(document);
    clean.transcripts[0].cues = [];
    clean.transcripts[0].timing_issues = [track.timing_issues.at(-1)!];
    const output = exportDocument(document);
    expect(output).toBe(exportDocument(clean));
    expect(output).toContain("[inaudible]");
    expect(output).toContain("blank audio after this take.");
    expect(output).toContain("A50");
    expect(exportDocument(multitrackScope(document, ["track-1"]))).toBe(exportDocument(multitrackScope(clean, ["track-1"])));
    expect(document).toEqual(saved);
  });
  it.each(exporters)("produces the existing empty-result format for %s when every row is blank", (_name, exportDocument) => {
    const document = withText("[BLANK_AUDIO]"), clean = structuredClone(document);
    clean.transcripts[0].cues = [];
    clean.transcripts[0].timing_issues = [];
    expect(exportDocument(document)).toBe(exportDocument(clean));
  });
  it("keeps SRT numbering contiguous after removing empty cues", () => {
    const document = withText(".");
    const cue = document.transcripts[0].cues[0];
    document.transcripts[0].cues.push(
      { ...cue, id: "speech", text: "Hello.", start_sample: 16000, end_sample: 32000 },
      { ...cue, id: "unclear", text: "[inaudible]", start_sample: 64000, end_sample: 80000 },
    );
    expect(multitrackSrt(document)).toBe("1\n00:00:01,000 --> 00:00:02,000\nAlex (A1): Hello.\n\n2\n00:00:04,000 --> 00:00:05,000\nAlex (A1): [inaudible]\n");
  });
});
