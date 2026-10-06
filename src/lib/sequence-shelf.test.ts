// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import type { AafDocumentSummary } from "../bindings/AafDocumentSummary";
import { HIDDEN_SEQUENCES_KEY, hiddenCount, hideSequences, isHiddenSequence, loadHiddenSequences, sequenceShelf, showHiddenSequences } from "./sequence-shelf";

const sequence = (id: string, modified_ms?: number): AafDocumentSummary =>
  ({ id, name: `Sequence ${id}`, track_count: 3, transcribed_tracks: 0, source_path: `/fixtures/${id}.aaf`, modified_ms });

beforeEach(() => localStorage.clear());

it("lists the newest save first", () => {
  const list = [sequence("old", 100), sequence("new", 300), sequence("mid", 200), sequence("unknown")];
  expect(sequenceShelf(list, {}).map((item) => item.id)).toEqual(["new", "mid", "old", "unknown"]);
});

it("hides a sequence without deleting anything, until it is saved again", () => {
  const scene = sequence("scene", 1_000), other = sequence("other", 900);
  const hidden = hideSequences([scene], [scene, other], {});
  expect(loadHiddenSequences()).toEqual({ scene: 1_000 });
  expect(sequenceShelf([scene, other], hidden).map((item) => item.id)).toEqual(["other"]);
  expect(hiddenCount([scene, other], hidden)).toBe(1);
  // Saved again in AAF Audio: newer than the stamp, so it is current and listed.
  expect(isHiddenSequence({ ...scene, modified_ms: 1_001 }, hidden)).toBe(false);
  expect(sequenceShelf([{ ...scene, modified_ms: 1_001 }, other], hidden).map((item) => item.id)).toEqual(["scene", "other"]);
});

it("forgets stamps for sequences AAF Audio no longer has", () => {
  const kept = sequence("kept", 5);
  hideSequences([sequence("gone", 1)], [sequence("gone", 1), kept], {});
  expect(hideSequences([kept], [kept], loadHiddenSequences())).toEqual({ kept: 5 });
});

it("puts every hidden sequence back", () => {
  hideSequences([sequence("a", 1), sequence("b", 2)], [sequence("a", 1), sequence("b", 2)], {});
  expect(showHiddenSequences()).toEqual({});
  expect(loadHiddenSequences()).toEqual({});
});

it("reads a mangled value as nothing hidden", () => {
  localStorage.setItem(HIDDEN_SEQUENCES_KEY, "[1,2]");
  expect(loadHiddenSequences()).toEqual({});
  localStorage.setItem(HIDDEN_SEQUENCES_KEY, JSON.stringify({ good: 4, bad: "4", worse: null }));
  expect(loadHiddenSequences()).toEqual({ good: 4 });
  localStorage.setItem(HIDDEN_SEQUENCES_KEY, "{not json");
  expect(loadHiddenSequences()).toEqual({});
});
