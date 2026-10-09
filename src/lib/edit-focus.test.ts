import { describe, expect, it } from "vitest";
import type { EditDocument } from "../bindings/EditDocument";
import type { EditSegment } from "../bindings/EditSegment";
import { focusOnMarkers } from "./edit-focus";
import { fromDocument } from "./edit-document";
import { paragraphs, placeWords, recordOrder, type TimelineWord } from "./edit-model";
import { layoutEditBites } from "./edit-stringout";

const people = ["jordan", "brandon", "yeremi", "kadie"];
const base = (segments: EditSegment[] = [], markers: EditDocument["markers"] = []): EditDocument => ({
  schema_version: 2, title: "Crowd", edit_rate: { numerator: 24, denominator: 1 }, start_timecode_frames: 86400,
  sources: [{ id: "s1", name: "HEAT 1", document_id: "h1" }],
  tracks: people.map((id, n) => ({ id, name: id.toUpperCase(), kind: "sound" as const, source_tracks: { s1: String(10 + n) } })),
  segments, mutes: [], markers });
const clip = (id: string, inFrame: number, outFrame: number, tracks: string[], extra: Partial<Extract<EditSegment, { kind: "source" }>> = {}): EditSegment =>
  ({ kind: "source", id, source: "s1", in_frame: inFrame, out_frame: outFrame, tracks, ...extra });
const marker = (id: string, frame: number, track: string) => ({ id, frame, track, name: track.toUpperCase(), comment: id, color: "white" });
let made = 0;
const word = (track: string, start: number, end: number, text: string, cue = `${track}-${Math.floor(start)}`): TimelineWord =>
  ({ id: `w${made++}`, source: "s1", track, text, start, end, cue });

describe("focusing on marked lines", () => {
  it("silences everyone in a clip but the people its markers name", () => {
    const { document, clips } = focusOnMarkers(base([clip("a", 240, 480, ["jordan", "brandon", "yeremi"])], [marker("m", 10, "jordan")]));
    expect(clips).toBe(1);
    expect(document.mutes).toEqual([
      { source: "s1", track: "brandon", in_frame: 240, out_frame: 480 },
      { source: "s1", track: "yeremi", in_frame: 240, out_frame: 480 },
    ]);
  });

  it("never silences someone over source their own marked line plays elsewhere", () => {
    // A silence holds for that stretch of a mic wherever it plays, so Brandon's
    // line in the second clip would go quiet with him.
    const { document } = focusOnMarkers(base(
      [clip("a", 0, 100, ["jordan", "brandon"]), { kind: "gap", id: "g", frames: 24 }, clip("b", 50, 150, ["brandon", "jordan"])],
      [marker("m1", 5, "jordan"), marker("m2", 130, "brandon")]));
    expect(document.mutes).toEqual([
      { source: "s1", track: "brandon", in_frame: 0, out_frame: 50 },
      { source: "s1", track: "jordan", in_frame: 100, out_frame: 150 },
    ]);
  });

  it("leaves a clip with no marker on a person, a track playing something else, and what is already silent", () => {
    const untouched = base([clip("a", 0, 100, ["jordan", "brandon"])], [{ ...marker("m", 5, "jordan"), track: null }]);
    expect(focusOnMarkers(untouched)).toEqual({ document: untouched, clips: 0 });
    const overridden = base([clip("a", 0, 100, ["jordan", "brandon"], { overrides: { brandon: { source: null, in_frame: 0 } } })], [marker("m", 5, "jordan")]);
    expect(focusOnMarkers(overridden).clips).toBe(0);
    const once = focusOnMarkers(base([clip("a", 0, 100, ["jordan", "brandon"])], [marker("m", 5, "jordan")])).document;
    expect(focusOnMarkers(once)).toEqual({ document: once, clips: 0 });
  });

  it("a clip that names nobody's track plays every patched lane, and every one of them but the named is silenced", () => {
    const whole = { ...base([clip("a", 0, 100, [])], [marker("m", 5, "kadie")]) };
    whole.segments = [{ kind: "source", id: "a", source: "s1", in_frame: 0, out_frame: 100 }];
    expect(focusOnMarkers(whole).document.mutes.map((mute) => mute.track)).toEqual(["jordan", "brandon", "yeremi"]);
  });

  it("Ask's string out of a crowd plays the line it chose over the room, with the room kept on its tracks", () => {
    // HEAT 1: everyone around the plank talks at once, so every mic joined every bite.
    const room = [word("brandon", 10.2, 10.6, "Go"), word("yeremi", 10.4, 10.8, "come"), word("kadie", 11, 11.3, "on")];
    // Everyone in the room has a line of their own later in the string out, so each may join as a listener.
    const lines = [{ source: "s1", track: "jordan", from: 10, to: 12, text: "These two are here though." },
      ...["brandon", "yeremi", "kadie"].map((track, n) => ({ source: "s1", track, from: 40 + n * 10, to: 42 + n * 10, text: "Later." }))];
    const words = [word("jordan", 10, 12, "These"), ...room];
    const built = layoutEditBites(base(), lines, "Crowd", { s1: 100 }, words);
    expect(built.segments[0]).toMatchObject({ tracks: ["jordan", "brandon", "yeremi", "kadie"] });
    const first = fromDocument(built).timeline;
    const placed = placeWords(words, { ...first, segments: first.segments.slice(0, 1) });
    expect(placed.filter((item) => !item.muted).map((item) => item.word.track)).toEqual(["jordan"]);
    expect(placed.filter((item) => item.muted).map((item) => item.word.track)).toEqual(["brandon", "yeremi", "kadie"]);
    // Each later line still plays: nobody is silenced over their own.
    const later = placeWords([word("brandon", 40, 42, "Later"), word("yeremi", 50, 52, "Later"), word("kadie", 60, 62, "Later")], first);
    expect(later.filter((item) => !item.muted).map((item) => item.word.track)).toEqual(["brandon", "yeremi", "kadie"]);
  });
});

describe("the record transcript, phrase by phrase", () => {
  it("keeps each person's phrase whole where they talk over one another", () => {
    // Word by word, every paragraph of a crowd was a single word.
    const words = [word("jordan", 1, 1.4, "These", "j1"), word("brandon", 1.2, 1.5, "Go", "b1"), word("jordan", 1.5, 1.9, "two", "j1"),
      word("brandon", 1.6, 2, "girl", "b1"), word("jordan", 2, 2.4, "here", "j1")];
    const timeline = { segments: [{ id: "a", source: "s1", srcIn: 0, srcOut: 5 }], mutes: [] };
    const interleaved = paragraphs(placeWords(words, timeline));
    expect(interleaved.map((paragraph) => paragraph.words.length)).toEqual([1, 1, 1, 1, 1]);
    const read = paragraphs(recordOrder(placeWords(words, timeline)));
    expect(read.map((paragraph) => [paragraph.track, paragraph.words.map((item) => item.word.text).join(" ")])).toEqual([
      ["jordan", "These two here"], ["brandon", "Go girl"]]);
  });
});
