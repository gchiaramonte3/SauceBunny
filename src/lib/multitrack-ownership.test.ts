import { expect, it } from "vitest";
import type { AafWordOwnership } from "../bindings/AafWordOwnership";
import { cueLabels, cueOwnership, ownershipIndex } from "./multitrack-ownership";

const word = (index: number, label: AafWordOwnership["label"], heard_on?: string, manual = false): AafWordOwnership =>
  ({ track_id: "dev", cue_id: "c1", index, label, heard_on, delta_db: -12, manual });

it("indexes labels by track and cue, so a cue with none reads as its owner's", () => {
  const index = ownershipIndex({ document_id: "d", measured: [], missing: [], stamp: "", counts: { owner: 0, bleed: 2, overtalk: 0, offmic: 0, unsure: 0, other: 0 }, warnings: [], voices: 0, words: [word(0, "bleed", "rosa"), word(2, "bleed", "rosa")] });
  expect(cueLabels(index, "dev", "c1")?.get(2)?.label).toBe("bleed");
  expect(cueLabels(index, "dev", "other")).toBeUndefined();
  expect(cueOwnership(undefined, 4)).toEqual({ bleed: false, heardOn: null, manual: false, offMic: false, voice: null });
});

it("calls a cue bleed only when most of its words are, and names the mic most of them came from", () => {
  const labels = (list: AafWordOwnership[]) => new Map(list.map((item) => [item.index, item]));
  const mostly = cueOwnership(labels([word(0, "bleed", "rosa"), word(1, "bleed", "rosa"), word(2, "bleed", "ellie")]), 4);
  expect(mostly).toMatchObject({ bleed: true, heardOn: "rosa" });
  // A neighbour's "yeah" under the owner's line does not hide the line.
  expect(cueOwnership(labels([word(0, "bleed", "rosa")]), 5).bleed).toBe(false);
  expect(cueOwnership(labels([word(0, "owner", undefined, true)]), 1)).toMatchObject({ bleed: false, manual: true });
  expect(cueOwnership(labels([word(0, "offmic"), word(1, "offmic")]), 2).offMic).toBe(true);
  // The voice check heard another cast member leaning into this mic.
  expect(cueOwnership(labels([word(0, "other", "ellie"), word(1, "other", "ellie")]), 2)).toMatchObject({ voice: "ellie", bleed: false });
});
