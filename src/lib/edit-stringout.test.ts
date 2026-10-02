import { describe, expect, it } from "vitest";
import type { AafCue } from "../bindings/AafCue";
import { multitrackFixture, multitrackGroupFixture, multitrackTranscript } from "../test/multitrack-fixture";
import { editFromSequence, giveTracks } from "./edit-new";
import { bitesFor, layoutEditBites, stringoutFor, stringoutsFor } from "./edit-stringout";

const cue = (id: string, from: number, to: number, text: string): AafCue => ({ id, start_sample: from * 16_000, end_sample: to * 16_000, text, boundary_review: false });

function scene() {
  const document = multitrackFixture();
  document.transcripts = [
    { ...multitrackTranscript("track-1"), cues: [cue("a1", 10, 12, "I moved here in May."), cue("a2", 13, 15, "It was a lot."), cue("a3", 40, 40.5, "Yes."), cue("a4", 60, 64, "Then Rosa called.")] },
    { ...multitrackTranscript("track-2"), cues: [cue("b1", 20, 25, "Sam talks here.")] },
  ];
  return document;
}

describe("rules-based string-outs", () => {
  it("joins a person's cues across short pauses and drops what is too short to use", () => {
    expect(bitesFor(scene(), ["track-1"]).map((bite) => [bite.from, bite.to, bite.text])).toEqual([
      [10, 15, "I moved here in May. It was a lot."],
      [60, 64, "Then Rosa called."],
    ]);
  });

  it("lays bites end to end with handles, filler between and a marker per bite", () => {
    const edit = stringoutFor(scene(), "Alex")!;
    const fps = 24000 / 1001;
    expect(edit.segments).toEqual([
      { kind: "source", id: "bite-0", source: "s1", in_frame: Math.floor(9.5 * fps), out_frame: Math.ceil(16 * fps), tracks: ["alex"] },
      { kind: "gap", id: "gap-1", frames: 24 },
      { kind: "source", id: "bite-1", source: "s1", in_frame: Math.floor(59.5 * fps), out_frame: Math.ceil(65 * fps), tracks: ["alex"] },
    ]);
    // A new sequence of chunks: Alex on A1 and nobody else on a track.
    expect(edit.tracks.filter((track) => track.featured !== false).map((track) => track.name)).toEqual(["Alex"]);
    const first = Math.ceil(16 * fps) - Math.floor(9.5 * fps);
    expect(edit.markers.map((marker) => [marker.frame, marker.name, marker.comment, marker.color])).toEqual([
      [0, "Alex", "I moved here in May. It was a lot.", "red"],
      [first + 24, "Alex", "Then Rosa called.", "red"],
    ]);
    expect(edit.title).toBe("SO_Interview_Alex");
  });

  it("patches only the people it has bites of, a group angle included, top-down in the order they speak", () => {
    const document = multitrackGroupFixture();
    document.transcripts = [{ ...multitrackTranscript("track-2"), cues: [cue("b1", 20, 25, "Sam talks here.")] }];
    // Sam's mic is an alternate in Alex's group: his string out has Sam on A1 and nobody else.
    const edit = stringoutFor(document, "Sam mic")!;
    expect(edit.tracks.map((track) => [track.name, track.featured])).toEqual([["Sam mic", true], ["Alex", false], ["Room", false]]);
    // Asked for the room and then Alex: the room on A1, Alex on A2, each bite on its own person's track.
    const base = giveTracks(editFromSequence(document, "x", false), ["alex", "sam-mic"]);
    const asked = layoutEditBites(base, [{ source: "s1", track: "room", from: 1, to: 3, text: "Room tone" }, { source: "s1", track: "alex", from: 10, to: 12, text: "Hi" }], "Room", { s1: 1000 });
    expect(asked.tracks.filter((track) => track.featured !== false).map((track) => track.id)).toEqual(["room", "alex"]);
    expect(asked.segments.flatMap((segment) => segment.kind === "source" ? [segment.tracks] : [])).toEqual([["room"], ["alex"]]);
  });

  it("never plays a frame twice when handles overlap", () => {
    const document = scene();
    document.transcripts[0].cues = [cue("a1", 10, 12, "One two three."), cue("a2", 14.2, 16, "Four five six.")];
    const edit = stringoutFor(document, "Alex", { head: 0.5, tail: 1, gapFrames: 0, join: 2, minimum: 1 })!;
    const sources = edit.segments.filter((segment) => segment.kind === "source");
    for (let index = 1; index < sources.length; index++) {
      const [previous, current] = [sources[index - 1], sources[index]];
      if (previous.kind === "source" && current.kind === "source") expect(current.in_frame).toBeGreaterThanOrEqual(previous.out_frame);
    }
  });

  it("makes one string-out per person who says something, and none for the silent", () => {
    expect(stringoutsFor(scene()).map((edit) => edit.title)).toEqual(["SO_Interview_Alex", "SO_Interview_Sam mic"]);
  });
});

describe("adding a bite to another edit", () => {
  it("brings the sequence in as a source and appends after filler, snapped outward", async () => {
    const { appendBite } = await import("./edit-stringout");
    const document = scene();
    const target = stringoutFor(document, "Sam mic")!;
    const fps = 24000 / 1001;
    const next = appendBite(target, document, 10.02, 11.98);
    expect(next.sources).toHaveLength(1);
    const tail = next.segments.slice(-2);
    expect(tail[0]).toMatchObject({ kind: "gap", frames: 24 });
    expect(tail[1]).toMatchObject({ kind: "source", source: "s1", in_frame: Math.floor(10.02 * fps), out_frame: Math.ceil(11.98 * fps) });
    expect(appendBite(target, document, 5, 4)).toBe(target);
  });
});
