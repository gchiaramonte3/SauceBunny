import { expect, it } from "vitest";
import { multitrackFixture, multitrackTranscript } from "../test/multitrack-fixture";
import { multitrackPrintDoc, multitrackSrt } from "./multitrack-export";
import { multitrackScope } from "./multitrack-person";
import { audioTrackLabel, exportMultitrack } from "./multitrack";

it("exports captions from sequence zero, not record timecode or the first spoken word", () => {
  const doc = multitrackFixture(); doc.transcripts = [multitrackTranscript()];
  expect(multitrackSrt(doc)).toBe("1\n00:00:10,000 --> 00:00:13,000\nAlex (A1): This is the first answer.\n");
  doc.manifest.start_frame = 1_600_000;
  expect(multitrackSrt(doc)).toContain("00:00:10,000");
  doc.transcripts[0].cues[0].start_sample = 16_016;
  expect(multitrackSrt(doc)).toContain("00:00:01,001");
});
it("keeps simultaneous voices in non-overlapping captions and retains source lanes in filtered exports", () => {
  const doc = multitrackFixture(); doc.transcripts = [multitrackTranscript(), multitrackTranscript("track-2")];
  const second = doc.transcripts[1].cues[0]; second.start_sample = 12 * 16000; second.end_sample = 15 * 16000; second.text = "Réponse, yes.";
  expect(multitrackSrt(doc)).toBe([
    "1\n00:00:10,000 --> 00:00:12,000\nAlex (A1): This is the first answer.",
    "2\n00:00:12,000 --> 00:00:13,000\nAlex (A1): This is the first answer.\nSam mic (A2): Réponse, yes.",
    "3\n00:00:13,000 --> 00:00:15,000\nSam mic (A2): Réponse, yes.\n",
  ].join("\n\n"));
  expect(multitrackSrt(multitrackScope(doc, ["track-2"]))).toContain("Sam mic (A2)");
  second.start_sample = 10 * 16000; second.end_sample = 13 * 16000;
  expect(multitrackSrt(doc).match(/-->/g)).toHaveLength(1);
  second.start_sample = 13 * 16000; second.end_sample = 15 * 16000;
  expect(multitrackSrt(doc).match(/-->/g)).toHaveLength(2);
});
it("does not invent timing for quarantined, empty, invalid or out-of-sequence passages", () => {
  const doc = multitrackFixture(), track = multitrackTranscript(); doc.transcripts = [track];
  const cue = track.cues[0];
  track.cues = [
    { ...cue, start_sample: -1_000 }, { ...cue, end_sample: cue.start_sample },
    { ...cue, start_sample: NaN }, { ...cue, end_sample: 1e12 }, { ...cue, text: " \n " },
  ];
  track.timing_issues = [{ id: "unplaced", text: "Keep this text", reason: "Invalid timestamp", reported_timing: "invalid", chunk_start_frame: 0 }];
  expect(multitrackSrt(doc)).toBe("");
  expect(multitrackPrintDoc(doc, "All voices")).toContain("Keep this text");
});
it("prints original sequence timecode and escapes transcript content in every HTML context", () => {
  const doc = multitrackFixture(); doc.transcripts = [multitrackTranscript(), multitrackTranscript("track-2")];
  doc.manifest.name = "<script>bad()</script> & Sequence";
  doc.labels[0].owner_name = 'Owner <img src="https://invalid.test" onerror="bad()">';
  doc.transcripts[0].cues[0].text = "<script>bad()</script> & 'hello'";
  const html = multitrackPrintDoc(doc, "All voices");
  expect(html).toContain("01:00:09:23"); expect(html).toContain("Sam mic (A2)");
  expect(html).toContain("&lt;script&gt;bad()&lt;/script&gt;");
  expect(html).not.toContain("<script>"); expect(html).not.toContain("<img");
  expect(html).toContain("Mic owners are labels, not verified speakers");
});
it("uses physical lanes across formats without deriving them from opaque IDs", () => {
  const doc = multitrackFixture(); doc.transcripts = [multitrackTranscript("track-2")];
  doc.manifest.tracks[1].physical_track_number = 12;
  expect(audioTrackLabel(doc, "track-2")).toBe("A12");
  expect(exportMultitrack(doc, "csv")).toContain('"A12","Sam mic"');
  expect(exportMultitrack(doc, "txt")).toContain("Sam mic (A12)");
  expect(multitrackSrt(doc)).toContain("Sam mic (A12)");
  expect(multitrackPrintDoc(doc, "Sam")).toContain("Sam mic (A12)");
  expect(() => audioTrackLabel(doc, "missing")).toThrow(/missing/);
});
