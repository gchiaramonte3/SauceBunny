import { expect, it } from "vitest";
import type { PlacedWord } from "../lib/edit-model";
import { selectionRuns } from "./EditSendTo";

const placed = (id: string, segment: number, start: number, end: number): PlacedWord =>
  ({ word: { id, source: "s1", track: "rosa", text: id, start, end }, segment, programStart: 0, programEnd: 0, muted: false });

it("sends each side of a cut as its own bite, so the words removed between them stay removed", () => {
  const runs = selectionRuns([placed("a", 0, 1, 1.4), placed("b", 0, 1.5, 2), placed("c", 1, 8, 8.5)]);
  expect(runs).toEqual([{ source: "s1", start: 1, end: 2, count: 2 }, { source: "s1", start: 8, end: 8.5, count: 1 }]);
});
