import { describe, expect, it } from "vitest";
import { multitrackFixture, multitrackGroupFixture } from "../test/multitrack-fixture";
import { addSource, editFromSequence } from "./edit-new";

describe("new edits from AAF Audio sequences", () => {
  it("makes one lane per person, named by mic owner, starting at 01:00:00:00", () => {
    const edit = editFromSequence(multitrackFixture(), "First pass", true);
    expect(edit.title).toBe("First pass");
    expect(edit.tracks.map((track) => track.name)).toEqual(["Alex", "Sam mic", "Room"]);
    expect(edit.tracks[0].source_tracks).toEqual({ s1: "track-1" });
    expect(edit.segments).toEqual([{ kind: "source", id: "whole-s1", source: "s1", in_frame: 0, out_frame: 24000 }]);
    expect(edit.start_timecode_frames).toBe(Math.round(3600 * 24000 / 1001));
    expect(editFromSequence(multitrackFixture(), "", false).segments).toEqual([]);
  });

  it("leaves alternative mics in a group out", () => {
    expect(editFromSequence(multitrackGroupFixture(), "x", false).tracks.map((track) => track.name)).toEqual(["Alex"]);
  });

  it("a second source joins lanes by person and adds new people", () => {
    const first = editFromSequence(multitrackFixture(), "x", false);
    const other = multitrackFixture();
    other.id = "sequence-two"; other.manifest.name = "Judges";
    other.labels = [{ track_id: "track-2", owner_name: "Alex", cast_member_id: null, color: null }];
    const edit = addSource(first, other);
    expect(edit.sources.map((source) => source.id)).toEqual(["s1", "s2"]);
    expect(edit.tracks.find((track) => track.name === "Alex")!.source_tracks).toEqual({ s1: "track-1", s2: "track-2" });
    expect(edit.tracks.map((track) => track.name)).toEqual(["Alex", "Sam mic", "Room", "Alex mic"]);
    expect(addSource(edit, other)).toBe(edit);
  });

  it("refuses a source at another frame rate", () => {
    const first = editFromSequence(multitrackFixture(), "x", false);
    const other = multitrackFixture();
    other.id = "pal"; other.manifest.edit_rate = { numerator: 25, denominator: 1 };
    expect(() => addSource(first, other)).toThrow(/frame rate/);
  });
});
