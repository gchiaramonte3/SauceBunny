import { describe, expect, it } from "vitest";
import type { EditDocument } from "../bindings/EditDocument";
import { audibleSpans, fromDocument, rippleMarkers, toDocument, toFrames, toSeconds, wordsFromSpeech } from "./edit-document";
import { GAP, liftProgram, type Timeline } from "./edit-model";

const base: EditDocument = {
  schema_version: 1, title: "Edit", edit_rate: { numerator: 24000, denominator: 1001 }, start_timecode_frames: 86400,
  sources: [{ id: "s", name: "S", document_id: "d" }],
  tracks: [{ id: "rosa", name: "Rosa", kind: "sound", source_tracks: { s: "track-1" } }],
  segments: [], mutes: [], markers: [],
};

describe("edit document", () => {
  it("frames and seconds round-trip at 23.976", () => {
    for (const frames of [0, 1, 24, 1001, 86_400]) expect(toFrames(toSeconds(frames, base.edit_rate), base.edit_rate)).toBe(frames);
  });

  it("snaps every boundary to a frame, drops what rounds to nothing, and keeps gaps as gaps", () => {
    const timeline: Timeline = { segments: [
      { id: "a", source: "s", srcIn: 0.01, srcOut: 2.0 },
      { id: "tiny", source: "s", srcIn: 3.0, srcOut: 3.01 },
      { id: "g", source: GAP, srcIn: 0, srcOut: 1 },
    ], mutes: [] };
    const document = toDocument(base, timeline, []);
    expect(document.segments).toEqual([
      { kind: "source", id: "a", source: "s", in_frame: 0, out_frame: 48 },
      { kind: "gap", id: "g", frames: 24 },
    ]);
  });

  it("snaps a silenced range outward so it still covers its words", () => {
    const document = toDocument(base, { segments: [], mutes: [{ source: "s", track: "rosa", srcIn: 1.01, srcOut: 1.49 }] }, []);
    const [mute] = document.mutes;
    expect(toSeconds(mute.in_frame, base.edit_rate)).toBeLessThanOrEqual(1.01);
    expect(toSeconds(mute.out_frame, base.edit_rate)).toBeGreaterThanOrEqual(1.49);
  });

  it("round-trips a model through the document, lifts and markers included", () => {
    const whole: Timeline = { segments: [{ id: "w", source: "s", srcIn: 0, srcOut: 10 }], mutes: [] };
    const lifted = liftProgram(whole, 2, 3);
    const document = toDocument(base, lifted, [{ id: "m", at: 2.5, track: null, name: "Bite", comment: "why", color: "Red" }]);
    const back = fromDocument(document);
    expect(back.timeline.segments.map((segment) => segment.source)).toEqual(["s", GAP, "s"]);
    expect(toDocument(base, back.timeline, back.markers)).toEqual(document);
    expect(document.markers[0].frame).toBe(toFrames(2.5, base.edit_rate));
  });

  it("reads analysed words and audible spans in source seconds", () => {
    const speech = { track_id: "track-1", floor_db: -60, activity: [[16_000, 32_000] as [number, number]], reactions: [[48_000, 56_000] as [number, number]],
      words: [{ cue_id: "c", text: "Okay", start_sample: 16_000, end_sample: 24_000 }], measured: true };
    const [word] = wordsFromSpeech(speech, "s", "rosa");
    expect(word).toMatchObject({ source: "s", track: "rosa", text: "Okay", start: 1, end: 1.5 });
    expect(audibleSpans(speech)).toEqual([[1, 2], [3, 3.5]]);
  });

  it("markers ride on the material under them, and go with it when it is removed", () => {
    const before: Timeline = { segments: [{ id: "a", source: "s", srcIn: 0, srcOut: 10 }], mutes: [] };
    const after: Timeline = { segments: [{ id: "a", source: "s", srcIn: 0, srcOut: 2 }, { id: "b", source: "s", srcIn: 5, srcOut: 10 }], mutes: [] };
    const marker = (id: string, at: number) => ({ id, at, track: null, name: id, comment: "", color: "red" });
    const moved = rippleMarkers(before, after, [marker("early", 1), marker("gone", 3), marker("late", 6)]);
    expect(moved.map((item) => [item.id, item.at])).toEqual([["early", 1], ["late", 3]]);
    const same = [marker("x", 1)];
    expect(rippleMarkers(before, before, same)).toBe(same);
  });
});
