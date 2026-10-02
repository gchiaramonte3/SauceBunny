import { expect, it } from "vitest";
import type { EditTrack } from "../bindings/EditTrack";
import { paragraphs, placeWords, type TimelineWord } from "./edit-model";
import { ALL_VOICES, firstSpeaker, sourceOrder, sourcePeople } from "./edit-source-view";

const word = (track: string, cue: string, start: number, text: string): TimelineWord =>
  ({ id: `s1:${track}:${cue}:${start}`, source: "s1", track, cue, text, start, end: start + 0.3 });
const whole = { segments: [{ id: "whole", source: "s1", srcIn: 0, srcOut: 100 }], mutes: [] };

// Two lavs hear each other: Rosa says a sentence while Dev's mic picks up a
// word of it, and Dev answers while Rosa's mic hears the start of his line.
const words = [
  word("rosa", "r1", 1.0, "I"), word("rosa", "r1", 1.4, "was"), word("rosa", "r1", 1.8, "exhausted"),
  word("dev", "d1", 1.5, "was"), word("dev", "d2", 2.4, "Me"), word("dev", "d2", 2.8, "too"),
  word("rosa", "r2", 2.5, "Me"),
];
const placed = placeWords(words, whole);

it("All voices keeps each cue whole, so bleeding lavs read by turn instead of word by word", () => {
  // Canary: in plain time order the two mics really do interleave word by word.
  expect(placed.map((item) => item.word.track)).toEqual(["rosa", "rosa", "dev", "rosa", "dev", "rosa", "dev"]);
  const all = sourceOrder(placed, ALL_VOICES);
  expect(all.map((item) => `${item.word.track}:${item.word.text}`)).toEqual([
    "rosa:I", "rosa:was", "rosa:exhausted", "dev:was", "dev:Me", "dev:too", "rosa:Me",
  ]);
  // Everything is still there, once.
  expect(new Set(all.map((item) => item.word.id)).size).toBe(words.length);
  // Rosa's sentence is one paragraph, not three.
  expect(paragraphs(all).map((paragraph) => paragraph.words.map((item) => item.word.text).join(" "))).toEqual(["I was exhausted", "was Me too", "Me"]);
});

it("a person's tab holds that lane's words only, one paragraph per cue", () => {
  const rosa = sourceOrder(placed, "rosa");
  expect(rosa.every((item) => item.word.track === "rosa")).toBe(true);
  expect(rosa.map((item) => item.word.text)).toEqual(["I", "was", "exhausted", "Me"]);
  expect(paragraphs(rosa, true).map((paragraph) => paragraph.words.length)).toEqual([3, 1]);
  // Without the cue break, two close cues of one person run together.
  expect(paragraphs(rosa).map((paragraph) => paragraph.words.length)).toEqual([4]);
});

it("the tabs are everyone with a mic in this source, group angles included, in lane order", () => {
  const tracks: EditTrack[] = [
    { id: "rosa", name: "ROSA", kind: "sound", source_tracks: { s1: "t1" } },
    { id: "ana", name: "ANA", kind: "sound", source_tracks: { s1: "branch-1" }, featured: false },
    { id: "kai", name: "KAI", kind: "sound", source_tracks: { s2: "t9" } },
    { id: "v1", name: "V1", kind: "picture", source_tracks: { s1: "p1" } },
  ];
  expect(sourcePeople(tracks, "s1", { rosa: "#f00" })).toEqual([
    { id: "rosa", name: "ROSA", trackIds: ["t1"], color: "#f00" },
    { id: "ana", name: "ANA", trackIds: ["branch-1"], color: null },
  ]);
});

it("a source opens on the first person who says anything in it", () => {
  const people = [{ id: "kai", name: "KAI", trackIds: ["t9"], color: null }, { id: "dev", name: "DEV", trackIds: ["t2"], color: null }];
  expect(firstSpeaker(people, placed)).toBe("dev");
  expect(firstSpeaker(people, [])).toBe(ALL_VOICES);
});
