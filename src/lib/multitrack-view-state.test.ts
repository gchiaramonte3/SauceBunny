// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { loadViewState, saveViewState, VIEW_STATE_KEY, VIEW_STATE_LIMIT } from "./multitrack-view-state";

beforeEach(() => localStorage.clear());

it("merges fields written by different owners and drops tracks the import no longer has", () => {
  saveViewState("doc", { solo: ["a"], mute: ["b", "gone"], levels: { a: 3, gone: -6 } });
  saveViewState("doc", { zoom: 4, density: "large", expanded: ["a"] });
  expect(loadViewState("doc", ["a", "b"])).toEqual({ solo: ["a"], mute: ["b"], levels: { a: 3 }, zoom: 4, density: "large",
    text: undefined, expanded: ["a"], selected: undefined, waveforms: undefined });
  expect(loadViewState("other", ["a"])).toBeNull();
});

it("keeps only the most recently used sequences", () => {
  for (let index = 0; index < VIEW_STATE_LIMIT + 5; index++) saveViewState(`doc-${index}`, { zoom: 2 }, index);
  const stored = JSON.parse(localStorage.getItem(VIEW_STATE_KEY)!);
  expect(Object.keys(stored)).toHaveLength(VIEW_STATE_LIMIT);
  expect(stored["doc-0"]).toBeUndefined();
  expect(stored[`doc-${VIEW_STATE_LIMIT + 4}`]).toBeTruthy();
});

it("ignores malformed values rather than restoring them", () => {
  localStorage.setItem(VIEW_STATE_KEY, JSON.stringify({ doc: { solo: "a", zoom: 3, density: "huge", levels: { a: "loud" }, waveforms: "yes" } }));
  expect(loadViewState("doc", ["a"])).toMatchObject({ solo: undefined, zoom: undefined, density: undefined, levels: {}, waveforms: undefined });
});
