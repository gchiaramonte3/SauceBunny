import { expect, it } from "vitest";
import { multitrackFixture, multitrackTranscript } from "../test/multitrack-fixture";
import { multitrackAvidMarkers, multitrackExportName, multitrackPeople, multitrackScope } from "./multitrack-person";
import { multitrackTextLayout } from "./multitrack-text-layout";

it("groups assigned owners without collapsing unassigned mics or different cast identities", () => {
  const doc = multitrackFixture();
  doc.labels.push({ track_id: "track-2", owner_name: "ALEX", cast_member_id: null, color: null });
  expect(multitrackPeople(doc).map((person) => person.trackIds)).toEqual([["track-1", "track-2"], ["track-3"]]);
  doc.labels[0].cast_member_id = "cast-1";
  expect(multitrackPeople(doc)).toHaveLength(3);
  doc.labels[1].cast_member_id = "cast-1";
  expect(multitrackPeople(doc)).toHaveLength(2);
  doc.transcripts = [multitrackTranscript(), multitrackTranscript("track-2")];
  expect(multitrackScope(doc, ["track-2"]).transcripts.map((track) => track.track_id)).toEqual(["track-2"]);
  expect(doc.transcripts).toHaveLength(2);
});
it("exports Isabella's passage at its source frame in a fractional-rate sequence", () => {
  const doc = multitrackFixture();
  doc.manifest.start_frame = (18 * 3600 + 40 * 60 + 18) * 24 + 23;
  doc.labels[0].owner_name = "Isabella";
  const track = multitrackTranscript();
  track.cues[0] = { ...track.cues[0], start_sample: Math.ceil(13273 * 16000 * 1001 / 24000), end_sample: Math.ceil(13273 * 16000 * 1001 / 24000) + 16000, text: "I try my best" };
  doc.transcripts = [track];
  expect(multitrackAvidMarkers(doc)).toBe("Isabella\t18:49:32:00\tA1\tred\tI try my best\n");
});
it("uses drop-frame labels and rejects unsupported rates instead of inventing timecode", () => {
  const doc = multitrackFixture(), track = multitrackTranscript(); doc.transcripts = [track];
  doc.manifest = { ...doc.manifest, start_frame: 0, edit_rate: { numerator: 30000, denominator: 1001 }, drop_frame: true };
  track.cues[0].start_sample = 960960; track.cues[0].end_sample = 976960;
  expect(multitrackAvidMarkers(doc)).toContain("00:01:00;02\tA1");
  doc.manifest.edit_rate = { numerator: 27, denominator: 1 };
  expect(() => multitrackAvidMarkers(doc)).toThrow(/frame rate/);
});
it("merges same-frame passages, sanitizes fields, and never marks untimed or out-of-range text", () => {
  const doc = multitrackFixture(), track = multitrackTranscript(); doc.transcripts = [track];
  doc.labels[0].owner_name = "Alex\t\n\0Name";
  track.cues[0].text = "First\tline\nnext";
  track.cues.push({ ...track.cues[0], id: "other", text: "Second" }, { ...track.cues[0], id: "outside", start_sample: 1e12 });
  track.timing_issues = [{ id: "untimed", text: "Unplaced", reason: "Invalid", reported_timing: "invalid", chunk_start_frame: 0 }];
  const text = multitrackAvidMarkers(doc);
  expect(text.split("\n").filter(Boolean)).toHaveLength(1);
  expect(text.trim().split("\t")).toEqual(["Alex Name", "01:00:09:23", "A1", "red", "First line next | Second"]);
  expect(text).not.toContain("Unplaced"); expect(text.charCodeAt(0)).not.toBe(0xfeff);
  expect(multitrackExportName("../a/b\n" )).toBe("-a-b-");
  expect(multitrackExportName("🎤".repeat(50))).toBe("🎤".repeat(20));
});
it("maps original audio lanes, not slot IDs, owners, filtered scope or export order", () => {
  const doc = multitrackFixture();
  doc.manifest.tracks[0].id = "slot-10"; doc.manifest.tracks[1].id = "slot-11";
  doc.labels = [{ track_id: "slot-10", owner_name: "Bombet", cast_member_id: null, color: null }, { track_id: "slot-11", owner_name: "Nathaniel", cast_member_id: null, color: null }];
  doc.transcripts = [multitrackTranscript("slot-11"), multitrackTranscript("slot-10")];
  expect(multitrackAvidMarkers(doc)).toContain("Bombet\t01:00:09:23\tA1\tred");
  expect(multitrackAvidMarkers(multitrackScope(doc, ["slot-11"]))).toContain("Nathaniel\t01:00:09:23\tA2\tred");
  doc.manifest.tracks[1].physical_track_number = 7;
  expect(multitrackAvidMarkers(multitrackScope(doc, ["slot-11"]))).toContain("\tA7\tred");
  doc.labels[1].owner_name = "Bombet";
  expect(multitrackAvidMarkers(doc).trim().split("\n")).toHaveLength(2);
  doc.manifest.tracks[1].physical_track_number = 0;
  expect(() => multitrackAvidMarkers(doc)).toThrow(/track/i);
  doc.manifest.tracks[1].physical_track_number = 1;
  expect(() => multitrackAvidMarkers(doc)).toThrow(/More than one source track maps to A1/);
});
it("retains all 20 source lanes when the manifest and transcript lists are reordered", () => {
  // The supplied AAF uses MobSlots 10–29 for A1–A20. Synthetic speech keeps
  // the regression independent of the user's media and transcript contents.
  const doc = multitrackFixture(), template = doc.manifest.tracks[0];
  doc.manifest.tracks = Array.from({ length: 20 }, (_, index) => ({
    ...template, id: String(index + 10), physical_track_number: index + 1,
    name: index === 0 ? "BOMBETTE" : index === 1 ? "NATHANIEL" : `Mic ${index + 1}`,
  }));
  doc.labels = [];
  doc.transcripts = doc.manifest.tracks.map((track) => multitrackTranscript(track.id)).reverse();
  const original = multitrackAvidMarkers(doc);
  doc.manifest.tracks.reverse();
  expect(multitrackAvidMarkers(doc)).toBe(original);
  const rows = original.trim().split("\n").map((line) => line.split("\t"));
  expect(rows).toHaveLength(20);
  expect(new Set(rows.map((row) => row[2]))).toEqual(new Set(Array.from({ length: 20 }, (_, index) => `A${index + 1}`)));
  expect(rows.every((row) => row.length === 5)).toBe(true);
  expect(rows.find((row) => row[0] === "BOMBETTE")?.[2]).toBe("A1");
  expect(rows.find((row) => row[0] === "NATHANIEL")?.[2]).toBe("A2");
  expect(multitrackAvidMarkers(multitrackScope(doc, ["11"]))).toContain("NATHANIEL\t01:00:09:23\tA2\tred");
});
it("bounds zoomed-out text by viewport cells and preserves precise labels when zoomed in", () => {
  const cues = Array.from({ length: 500 }, (_, index) => ({ id: String(index), text: `Passage ${index}`, startFrame: index * 48, endFrame: index * 48 + 40 }));
  const wide = multitrackTextLayout(cues, 0, 24000, 800);
  expect(wide.length).toBeLessThanOrEqual(7); expect(wide.every((label) => label.summary)).toBe(true);
  const detailed = multitrackTextLayout(cues, 0, 240, 800);
  expect(detailed).toHaveLength(5); expect(detailed[0]).toMatchObject({ text: "Passage 0", summary: false, style: { left: "0%", width: `${40 / 240 * 100}%` } });
  expect(multitrackTextLayout(cues, 25000, 100, 800)).toEqual([]);
});
