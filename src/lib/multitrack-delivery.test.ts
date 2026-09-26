import { describe, expect, it } from "vitest";
import { multitrackFixture, multitrackTranscript } from "../test/multitrack-fixture";
import { assignedMarkerColor } from "./cast-marker";
import { castFromSpeakers, sanitizeCast } from "./cast";
import { exportMultitrack } from "./multitrack";
import { multitrackPrintDoc } from "./multitrack-export";
import { multitrackAvidMarkers } from "./multitrack-person";
import { recordingDates, shootDate } from "./multitrack-metadata";
import { multitrackLibraryEntries } from "./transcript-library";

describe("authoritative multitrack delivery", () => {
  it("keeps missing/mixed recording dates explicit, with a separate reversible override", () => {
    const doc = multitrackFixture(); doc.transcripts = [multitrackTranscript()];
    expect(shootDate(doc)).toBe("Not provided");
    doc.manifest.recording_dates = ["2026-08-02", "2026-08-01", "2026-08-01"].map((date, index) => ({ source_id: String(index), date, provenance: "bwf-origination-date" }));
    expect(recordingDates(doc)).toEqual(["2026-08-01", "2026-08-02"]);
    expect(exportMultitrack(doc, "txt")).toContain("Shoot date: 2026-08-01, 2026-08-02 (source metadata)");
    doc.shoot_date_override = "2026-08-03";
    expect(multitrackPrintDoc(doc, "José <cast>")).toContain("Shoot date: 2026-08-03 (user supplied)");
    expect(multitrackPrintDoc(doc, "José <cast>")).toContain("José &lt;cast&gt;");
    expect(recordingDates(doc)).toHaveLength(2);
    doc.shoot_date_override = ""; expect(shootDate(doc)).toBe("Not provided");
    delete doc.shoot_date_override; expect(shootDate(doc)).toBe("2026-08-01, 2026-08-02");
  });
  it("keeps Blue/Pink and original A1 through A50 lanes at fractional rate", () => {
    const doc = multitrackFixture(), template = doc.manifest.tracks[0];
    doc.manifest.tracks = Array.from({ length: 50 }, (_, index) => ({ ...template, id: `mic-${index}`, physical_track_number: 50 - index }));
    doc.labels = doc.manifest.tracks.map((track, index) => ({ track_id: track.id, owner_name: `Person ${index}`, cast_member_id: null, color: null, marker_color: index % 2 ? "pink" : "blue" }));
    doc.transcripts = doc.manifest.tracks.map(track => multitrackTranscript(track.id));
    const lines = multitrackAvidMarkers(doc).trim().split("\n");
    expect(lines).toHaveLength(50);
    for (let index = 0; index < 50; ++index) {
      expect(lines.some(line => line.includes(`\t01:00:09:23\tA${50 - index}\t${index % 2 ? "pink" : "blue"}\t`))).toBe(true);
    }
  });
  it("persists manual cast preferences without inferring unspecified assignments", () => {
    expect(assignedMarkerColor("unspecified", "purple")).toBe("purple");
    expect(assignedMarkerColor("nonbinary", "orange")).toBe("orange");
    expect(assignedMarkerColor("man")).toBe("blue");
    expect(assignedMarkerColor("woman")).toBe("pink");
    const cast = castFromSpeakers("Cast", [{ tag: "1", name: "José", color: "#123456", gender: "man", markerColor: "pink" }]);
    expect(sanitizeCast(JSON.parse(JSON.stringify(cast)))?.members[0]).toMatchObject({ gender: "man", markerColor: "pink", name: "José" });
    const legacy = sanitizeCast({ ...cast, members: [{ id: "old", name: "Woman", color: "#123456" }] })!;
    expect(legacy.members[0].gender).toBeUndefined(); expect(legacy.members[0].markerColor).toBeUndefined();
  });
  it("updates source-named entries without fake SRT paths and preserves historical duplicates", () => {
    const base = { id: "first-id", source_path: "/one/Same.aaf", name: "Sequence", track_count: 50, transcribed_tracks: 1, modified_ms: 2 };
    expect(multitrackLibraryEntries([base])[0]).toMatchObject({ kind: "multitrack", title: "Same.aaf" });
    expect(multitrackLibraryEntries([{ ...base, transcribed_tracks: 50 }])[0].summary.transcribed_tracks).toBe(50);
    const entries = multitrackLibraryEntries([base, { ...base, id: "second-id", source_path: "/two/Same.aaf" }, { ...base, id: "not-run", transcribed_tracks: 0 }]);
    expect(entries).toHaveLength(2); expect(new Set(entries.map(item => item.title)).size).toBe(2);
    expect(entries.every(item => !("path" in item) && !("cues" in item))).toBe(true);
  });
});
