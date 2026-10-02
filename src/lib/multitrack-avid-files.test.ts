import { expect, it } from "vitest";
import { multitrackGroupFixture, multitrackTranscript } from "../test/multitrack-fixture";
import { multitrackAvidMarkers, multitrackAvidTrack, multitrackScope } from "./multitrack-person";
import { hasGroupMicrophones, multitrackAvidFiles, multitrackAvidGuide, needsMicrophoneFiles } from "./multitrack-avid-files";

it("exports an offline alternative on its parent A4 in sequence timecode with its own Pink color", () => {
  const doc = multitrackGroupFixture();
  doc.manifest.tracks[0].physical_track_number = 4;
  doc.manifest.tracks[1].physical_track_number = 99; // Never route using a virtual lane's ordinal.
  doc.manifest.graph!.lanes[1].availability = "offline";
  doc.labels.push({ track_id: "track-2", owner_name: "Renamed\t\nmic", color: null, cast_member_id: null, marker_color: "pink" });
  doc.transcripts = [multitrackTranscript("track-2")];
  const text = multitrackAvidMarkers(doc);
  expect(text).toContain("Renamed mic\t01:00:09:23\tA4\tpink\t[Group alternative:");
  expect(text.trim().split("\t")).toHaveLength(5);
  expect(text).not.toContain("A99");
  expect(doc.transcripts[0].cues[0].text).toBe("This is the first answer.");
  expect(needsMicrophoneFiles(doc, ["track-2"])).toBe(false);
  expect(needsMicrophoneFiles(doc, ["track-1", "track-2"])).toBe(true);
  expect(hasGroupMicrophones(doc)).toBe(true);
});

it("keeps alternatives separate even with the same owner, same frame and different colors", () => {
  const doc = multitrackGroupFixture();
  doc.labels = doc.manifest.tracks.map((track, index) => ({ track_id: track.id, owner_name: "Shared name", cast_member_id: "same-cast", color: null, marker_color: index === 1 ? "blue" : "pink" }));
  doc.transcripts = doc.manifest.tracks.map(track => multitrackTranscript(track.id));
  expect(() => multitrackAvidMarkers(doc)).toThrow(/separate Avid marker files/);
  const files = multitrackAvidFiles(doc, ["track-2", "track-3"], true);
  expect(files).toHaveLength(2);
  expect(new Set(files.map(file => file.name)).size).toBe(2);
  expect(files[0].text).toContain("\tA1\tblue\t"); expect(files[1].text).toContain("\tA1\tpink\t");
  expect(files.every(file => file.text.trim().split("\n").length === 1)).toBe(true);
  expect(multitrackAvidFiles(doc, [], true)).toEqual([]);
  doc.transcripts[1].cues[0].text = "[BLANK_AUDIO]"; doc.transcripts[2].cues[0].text = ".";
  expect(multitrackAvidFiles(doc, ["track-2", "track-3"], true)).toEqual([]);
  doc.transcripts[2].cues[0].text = "[inaudible]";
  expect(multitrackAvidFiles(doc, ["track-3"], true)[0].text).toContain("[inaudible]");
});

it("rejects missing/cyclic parents and resolves nested alternatives by graph identity", () => {
  const doc = multitrackGroupFixture(), lanes = doc.manifest.graph!.lanes;
  lanes[2].parent_track_id = "track-2";
  expect(multitrackAvidTrack(doc, "track-3")).toBe("A1");
  lanes[1].parent_track_id = "track-3";
  expect(() => multitrackAvidTrack(doc, "track-3")).toThrow(/cannot be resolved/);
  lanes[1].parent_track_id = "missing";
  expect(() => multitrackAvidTrack(doc, "track-2")).toThrow(/cannot be resolved/);
});

it("exports 98 source lanes to 20 real sequence tracks without renumbering or merging", () => {
  const doc = multitrackGroupFixture(), template = doc.manifest.tracks[0];
  doc.manifest.tracks = Array.from({ length: 98 }, (_, index) => ({ ...template, id: `mic-${index}`, name: `Microphone ${index}`, physical_track_number: index < 20 ? index + 1 : 999 }));
  doc.manifest.graph!.lanes = doc.manifest.tracks.map((track, index) => ({ track_id: track.id, parent_track_id: index < 20 ? null : `mic-${(index - 20) % 20}`, branch_id: index < 20 ? null : `branch-${index}`, group_name: "Generated group", availability: "offline" }));
  doc.labels = [];
  doc.transcripts = doc.manifest.tracks.map(track => multitrackTranscript(track.id));
  const ids = doc.manifest.tracks.map(track => track.id), files = multitrackAvidFiles(doc, ids, true);
  expect(files).toHaveLength(98); expect(new Set(files.map(file => file.name)).size).toBe(98);
  const routes = files.map(file => file.text.trim().split("\t")[2]);
  expect(new Set(routes)).toEqual(new Set(Array.from({ length: 20 }, (_, index) => `A${index + 1}`)));
  expect(routes.filter(route => route === "A4")).toHaveLength(5);
  const before = new Map(files.map(file => [file.trackIds[0], file.text]));
  doc.manifest.tracks.reverse();
  for (const file of multitrackAvidFiles(doc, ids, true)) expect(file.text).toBe(before.get(file.trackIds[0]));
});

it("retains drop-frame timing and documents the actual unique filenames separately from import data", () => {
  const doc = multitrackGroupFixture(); doc.transcripts = [multitrackTranscript("track-2")];
  doc.manifest = { ...doc.manifest, start_frame: 0, edit_rate: { numerator: 30000, denominator: 1001 }, drop_frame: true };
  doc.transcripts[0].cues[0].start_sample = 960960;
  expect(multitrackAvidMarkers(multitrackScope(doc, ["track-2"]))).toContain("00:01:00;02\tA1");
  const guide = multitrackAvidGuide(doc, [{ path: "/exports/Épisode mic (2).txt", trackIds: ["track-2"] }]);
  expect(guide).toContain("Épisode mic (2).txt"); expect(guide).not.toContain("/exports/");
  expect(guide).toContain("Sam mic -> A1"); expect(guide).toContain("Branch: branch-1");
  expect(guide).toContain("not the source group clip"); expect(guide).toContain("one microphone file per parent track");
});
