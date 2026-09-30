import { describe, expect, it } from "vitest";
import { multitrackFixture, multitrackGroupFixture } from "../test/multitrack-fixture";
import { addSource, editFromSequence, giveTracks, hourOne, onTrack, patchAt, peopleOf, unpatch } from "./edit-new";

describe("new edits from AAF Audio sequences", () => {
  it("makes one lane per person, named by mic owner, starting at 01:00:00:00", () => {
    const edit = editFromSequence(multitrackFixture(), "First pass", true);
    expect(edit.title).toBe("First pass");
    expect(edit.tracks.map((track) => track.name)).toEqual(["Alex", "Sam mic", "Room"]);
    expect(edit.tracks[0].source_tracks).toEqual({ s1: "track-1" });
    expect(edit.segments).toEqual([{ kind: "source", id: "whole-s1", source: "s1", in_frame: 0, out_frame: 24000 }]);
    expect(edit.start_timecode_frames).toBe(86400);
    expect(editFromSequence(multitrackFixture(), "", false).segments).toEqual([]);
  });

  it("a new string out lists everyone and patches nobody, as an Avid sequence starts with no tracks", () => {
    const edit = editFromSequence(multitrackGroupFixture(), "x", false);
    // Ask and the source pane need everyone's words; the record has no tracks until something is cut in.
    expect(edit.tracks.map((track) => [track.name, track.featured])).toEqual([["Alex", false], ["Sam mic", false], ["Room", false]]);
    expect(edit.tracks.filter(onTrack)).toEqual([]);
  });

  it("patches top-down in the order people are asked for, and nobody else", () => {
    const edit = editFromSequence(multitrackFixture(), "x", false);
    // Ask for the room and then Alex: the room on A1, Alex on A2, Sam on no track.
    const given = giveTracks(edit, ["room", "alex"]);
    expect(peopleOf(given.tracks).map((lane) => [lane.name, lane.track])).toEqual([["Room", 1], ["Alex", 2], ["Sam mic", 0]]);
    expect(giveTracks(given, ["room", "alex"])).toBe(given);
    // Someone new goes on the next track down; nobody already patched moves.
    expect(peopleOf(giveTracks(given, ["sam-mic"]).tracks).map((lane) => [lane.name, lane.track])).toEqual([["Room", 1], ["Alex", 2], ["Sam mic", 3]]);
  });

  it("the patch panel moves a person to a track, and taking one off closes the tracks up", () => {
    const three = giveTracks(editFromSequence(multitrackFixture(), "x", false), ["alex", "sam-mic", "room"]);
    const moved = patchAt(three, "room", 0);
    expect(peopleOf(moved.tracks).map((lane) => [lane.name, lane.track])).toEqual([["Room", 1], ["Alex", 2], ["Sam mic", 3]]);
    expect(patchAt(moved, "room", 0)).toBe(moved);
    const off = unpatch(moved, "alex");
    expect(peopleOf(off.tracks).map((lane) => [lane.name, lane.track])).toEqual([["Room", 1], ["Sam mic", 2], ["Alex", 0]]);
    // Someone not on a track can be patched straight onto one.
    expect(peopleOf(patchAt(off, "alex", 1).tracks).map((lane) => [lane.name, lane.track])).toEqual([["Room", 1], ["Alex", 2], ["Sam mic", 3]]);
  });

  it("the whole sequence patches everyone with a track of their own, in its order, and no group angle", () => {
    const edit = editFromSequence(multitrackGroupFixture(), "x", true);
    expect(peopleOf(edit.tracks).map((lane) => [lane.name, lane.track])).toEqual([["Alex", 1], ["Sam mic", 0], ["Room", 0]]);
  });

  it("maps a person to their own track rather than to an angle of theirs listed first", () => {
    const doc = multitrackGroupFixture();
    // Room's mic is an angle in Alex's group, and Alex also owns it: Alex's own track wins whatever the order.
    doc.labels = [...doc.labels.filter((label) => label.track_id !== "track-3"), { track_id: "track-3", owner_name: "Alex", cast_member_id: null, color: null }];
    doc.manifest.tracks = [doc.manifest.tracks[2], doc.manifest.tracks[0], doc.manifest.tracks[1]];
    const edit = editFromSequence(doc, "x", false);
    expect(edit.tracks.find((track) => track.name === "Alex")).toEqual({ id: "alex", name: "Alex", kind: "sound", source_tracks: { s1: "track-1" }, featured: false });
  });

  it("adding a sequence patches nobody and moves nobody off a track", () => {
    const given = giveTracks(editFromSequence(multitrackGroupFixture(), "x", false), ["room"]);
    const other = multitrackFixture();
    other.id = "sequence-two";
    const joined = addSource(given, other);
    expect(joined.tracks.find((track) => track.name === "Room")).toMatchObject({ source_tracks: { s1: "track-3", s2: "track-3" }, featured: true });
    expect(joined.tracks.filter(onTrack).map((track) => track.name)).toEqual(["Room"]);
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

  it("counts 01:00:00:00 in the sequence's own timecode, drop-frame included", () => {
    expect(hourOne(24, false)).toBe(86400);
    expect(hourOne(25, false)).toBe(90000);
    expect(hourOne(30, true)).toBe(107892);
    expect(hourOne(60, true)).toBe(215784);
  });

  it("an empty string out takes its first sequence's rate and timecode", () => {
    const pal = multitrackFixture();
    pal.manifest.edit_rate = { numerator: 25, denominator: 1 }; pal.manifest.timecode_fps = 25;
    const empty = { ...editFromSequence(multitrackFixture(), "x", false), sources: [], tracks: [] };
    const edit = addSource(empty, pal);
    expect(edit.edit_rate).toEqual({ numerator: 25, denominator: 1 });
    expect(edit.start_timecode_frames).toBe(90000);
    expect(() => addSource(edit, multitrackFixture())).toThrow(/frame rate/);
  });

  it("refuses a source at another frame rate", () => {
    const first = editFromSequence(multitrackFixture(), "x", false);
    const other = multitrackFixture();
    other.id = "pal"; other.manifest.edit_rate = { numerator: 25, denominator: 1 };
    expect(() => addSource(first, other)).toThrow(/frame rate/);
  });
});
