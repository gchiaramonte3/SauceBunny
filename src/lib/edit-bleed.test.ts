import { expect, it } from "vitest";
import type { AafSpeech } from "../bindings/AafSpeech";
import { wordsFromSpeech } from "./edit-document";
import { deleteWords, placeWords, placementKey, type TimelineWord } from "./edit-model";
import { ALL_VOICES, sourceOrder } from "./edit-source-view";

// String Outs' half of the bleed resolver (accuracy spec, phase 3).
const speech = (track: string, cues: [string, string[]][]): AafSpeech => ({
  track_id: track, floor_db: -60, activity: [], reactions: [], measured: true,
  words: cues.flatMap(([cue, words], c) => words.map((text, i) => ({ cue_id: cue, text, start_sample: (c * 10 + i) * 16_000, end_sample: (c * 10 + i + 0.5) * 16_000 }))),
});

it("labels a word by its place in its own cue, the way the resolver counts", () => {
  const words = wordsFromSpeech(speech("aaf-2", [["a", ["Yes", "please"]], ["b", ["I", "moved"]]]), "s1", "dev",
    (cue, index) => cue === "b" && index === 1 ? "aaf-1" : undefined);
  expect(words.map((word) => word.heardOn)).toEqual([undefined, undefined, undefined, "aaf-1"]);
  expect(words.every((word) => !("heardOn" in word) || word.heardOn)).toBe(true);
});

const word = (track: string, cue: string, index: number, text: string, start: number, heardOn?: string): TimelineWord =>
  ({ id: `s1:${track}:${cue}:${index}`, source: "s1", track, cue, text, start, end: start + 0.4, ...(heardOn ? { heardOn } : {}) });
const edit = { segments: [{ id: "seg", source: "s1", srcIn: 0, srcOut: 60 }], mutes: [] };

it("reads a bleed line once in All voices, from the mic it was said into, and keeps it on its own tab", () => {
  const words = [word("rosa", "r1", 0, "I", 1), word("rosa", "r1", 1, "moved", 1.4), word("dev", "d1", 0, "I", 1.02, "aaf-rosa"), word("dev", "d1", 1, "moved", 1.42, "aaf-rosa")];
  const placed = placeWords(words, edit);
  expect(sourceOrder(placed, ALL_VOICES).map((item) => item.word.track)).toEqual(["rosa", "rosa"]);
  expect(sourceOrder(placed, "dev")).toHaveLength(2);
  // One bleed word under a real line leaves the line where it is.
  const mixed = placeWords([word("dev", "d2", 0, "yeah", 5, "aaf-rosa"), word("dev", "d2", 1, "right", 5.4), word("dev", "d2", 2, "okay", 5.8)], edit);
  expect(sourceOrder(mixed, ALL_VOICES)).toHaveLength(3);
});

it("does not call a bleed copy of the cut line someone talking over it", () => {
  const words = [word("rosa", "r1", 0, "kitchen", 10), word("dev", "d1", 0, "kitchen", 10.02, "aaf-rosa"), word("ellie", "e1", 0, "wait", 10.1)];
  const placed = placeWords(words, edit);
  const keys = new Set(placed.filter((item) => item.word.track === "rosa").map(placementKey));
  const result = deleteWords(words, edit, keys);
  expect(result.crosstalk.map((item) => item.track)).toEqual(["ellie"]);
});
