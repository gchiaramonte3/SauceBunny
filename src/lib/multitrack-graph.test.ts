import { describe, expect, it } from "vitest";
import { multitrackGroupFixture as groupFixture, multitrackTranscript } from "../test/multitrack-fixture";
import { alternativeLane, auditionLanes, laneReady, mediaRevision, trackProvenance, visibleLanes } from "./multitrack-graph";
import { multitrackAvidMarkers, multitrackScope } from "./multitrack-person";
import { exportMultitrack } from "./multitrack";
import { multitrackPrintDoc } from "./multitrack-export";

describe("AAF group routing", () => {
  it("expands without changing audition choices or identity", () => {
    const doc = groupFixture(), muted = new Set(["track-2", "track-3"]);
    expect(visibleLanes(doc, new Set()).map(track => track.id)).toEqual(["track-1"]);
    expect(visibleLanes(doc, new Set(["track-1"]))).toHaveLength(3);
    expect(auditionLanes(doc, new Set(), muted)).toEqual(["track-1"]);
    muted.delete("track-2");
    expect(auditionLanes(doc, new Set(), muted)).toEqual(["track-1", "track-2"]);
    expect(alternativeLane(doc,"track-2")).toBe(true);
    const revision = mediaRevision(doc); doc.labels[0].owner_name = "Edited";
    expect(mediaRevision(doc)).toBe(revision);
  });
  it("does not double-play the same source mapping through a parent and an alias", () => {
    const doc=groupFixture(); doc.manifest.tracks[1].clips=structuredClone(doc.manifest.tracks[0].clips);
    expect(auditionLanes(doc,new Set(),new Set(["track-3"]))).toEqual(["track-1"]);
    expect(auditionLanes(doc,new Set(["track-2"]),new Set())).toEqual(["track-2"]);
  });
  it("offline and unsupported microphones cannot enter the mixer", () => {
    const doc = groupFixture(); doc.manifest.graph!.lanes[1].availability = "offline"; doc.manifest.graph!.lanes[2].availability = "unsupported";
    expect(laneReady(doc,"track-2")).toBe(false); expect(auditionLanes(doc,new Set(),new Set())).toEqual(["track-1"]);
  });
  it("does not reject original marker tracks just because group alternatives exist", () => {
    const doc=groupFixture(); doc.transcripts=[multitrackTranscript()];
    expect(multitrackAvidMarkers(doc)).toContain("A1");
    doc.transcripts.push(multitrackTranscript("track-2"));
    expect(() => multitrackAvidMarkers(doc)).toThrow(/separate Avid marker files/);
    expect(multitrackAvidMarkers(multitrackScope(doc,["track-1"]))).toContain("A1");
    expect(multitrackAvidMarkers(multitrackScope(doc,["track-2"]))).toContain("\tA1\tred\t[Group alternative:");
  });
  it("exports alternative provenance without confusing it with a sequence track", () => {
    const doc=groupFixture(); doc.transcripts=[multitrackTranscript("track-2")];
    expect(trackProvenance(doc,"track-2")).toContain("Group alternative");
    for (const text of [exportMultitrack(doc,"txt"),exportMultitrack(doc,"csv"),multitrackPrintDoc(doc,"Test")]) expect(text).toContain("Group alternative");
  });
});
