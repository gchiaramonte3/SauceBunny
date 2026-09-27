// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { OpenEdit } from "../lib/edit-document";
import type { Timeline, TimelineLane, TimelineWord } from "../lib/edit-model";
import type { EditChange } from "./use-edit-session";
import { useEditWorkspace } from "./use-edit-workspace";

const lanes: TimelineLane[] = [{ id: "rosa", name: "Rosa", track: 1 }, { id: "dev", name: "Dev", track: 2 }];
const word = (id: string, track: string, start: number, end: number): TimelineWord => ({ id, source: "s1", track, text: id, start, end });
// Rosa talks 1-3 s, Dev says "yeah" over her at 2.0-2.4 s, Rosa again at 6-7 s.
const words = [word("so", "rosa", 1, 1.4), word("anyway", "rosa", 1.5, 2.5), word("yeah", "dev", 2, 2.4), word("later", "rosa", 6, 7)];
const timeline: Timeline = { segments: [{ id: "whole", source: "s1", srcIn: 0, srcOut: 10 }], mutes: [] };
const open = { document: {} as OpenEdit["document"], timeline, markers: [] } satisfies OpenEdit;

function setup() {
  const commits: { label: string; change: EditChange }[] = [];
  const commit = vi.fn(async (label: string, change: (state: OpenEdit) => EditChange) => { commits.push({ label, change: change(open) }); });
  const hook = renderHook(() => useEditWorkspace({ open, words, lanes, sourceLanes: { s1: ["rosa", "dev"] }, durations: { s1: 10 },
    audible: new Map([["s1", [[1, 3], [6, 7]]]]), playhead: 0, seek: vi.fn(), commit, nameOf: (id) => id === "rosa" ? "Rosa" : "Dev", tc: (s) => `${s}` }));
  const select = (from: number, to: number) => act(() => hook.result.current.setSelection({ anchor: from, focus: to, collapsed: false }));
  return { hook, commits, select };
}

it("never cuts through overtalk: silences the speaker's own words and asks about the rest", () => {
  const { hook, commits, select } = setup();
  const index = hook.result.current.placed.findIndex((item) => item.word.id === "anyway");
  select(index, index);
  act(() => hook.result.current.remove(false));
  expect(commits.map((item) => item.label)).toEqual(["Remove from Rosa's Track"]);
  expect(commits[0].change?.timeline?.mutes.map((mute) => mute.track)).toEqual(["rosa"]);
  expect(commits[0].change?.timeline?.segments).toEqual(timeline.segments);
  expect(hook.result.current.prompt?.result.crosstalk.map((item) => item.id)).toEqual(["yeah"]);
});

it("deletes clean speech outright, closing the time on every track", () => {
  const { hook, commits, select } = setup();
  const index = hook.result.current.placed.findIndex((item) => item.word.id === "later");
  select(index, index);
  act(() => hook.result.current.remove(false));
  expect(commits[0].label).toBe("Delete 1 Word");
  const program = commits[0].change!.timeline!.segments.reduce((sum, segment) => sum + segment.srcOut - segment.srcIn, 0);
  expect(program).toBeLessThan(10);
});

it("finds dead space only where no mic is audible and no word is said", () => {
  const { hook } = setup();
  act(() => hook.result.current.findDead("air"));
  const spaces = hook.result.current.dead!.spaces;
  expect(spaces.length).toBeGreaterThan(0);
  for (const space of spaces) expect(space.to <= 1 || space.from >= 3).toBe(true);
});
