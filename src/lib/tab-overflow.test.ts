import { expect, it } from "vitest";
import { visibleTabs } from "./tab-overflow";

it("draws every tab when they fit or when nothing has been measured", () => {
  expect(visibleTabs([50, 50, 50], 150, 40, 0)).toEqual([0, 1, 2]);
  expect(visibleTabs([0, 0, 0], 0, 0, 2)).toEqual([0, 1, 2]);
  expect(visibleTabs([50, 50, 50], 0, 40, 1)).toEqual([0, 1, 2]);
});

it("keeps the leading tabs that fit beside the more button, in order", () => {
  expect(visibleTabs([50, 50, 50, 50], 160, 40, 0)).toEqual([0, 1]);
});

it("always draws the chosen tab, giving up the last tab that would not fit with it", () => {
  expect(visibleTabs([50, 50, 50, 50, 50], 160, 40, 4)).toEqual([0, 4]);
  expect(visibleTabs([50, 50, 50, 50, 50], 160, 40, 1)).toEqual([0, 1]);
});

it("draws the chosen tab even when it alone is wider than the strip", () => {
  expect(visibleTabs([50, 400, 50], 160, 40, 1)).toEqual([1]);
});
