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
const openEdit = { document: {} as OpenEdit["document"], timeline, markers: [] } satisfies OpenEdit;

function setup(open: OpenEdit = openEdit, everyone?: TimelineWord[]) {
  const commits: { label: string; change: EditChange }[] = [];
  const commit = vi.fn(async (label: string, change: (state: OpenEdit) => EditChange) => { commits.push({ label, change: change(open) }); return true; });
  const hook = renderHook(() => useEditWorkspace({ open, words, everyone, lanes, sourceLanes: { s1: ["rosa", "dev"] }, durations: { s1: 10 },
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

it("asks before an Extract takes words from a track that is not selected, and Lift leaves them", () => {
  const { hook, commits } = setup();
  act(() => hook.result.current.toggleTrack("rosa", true));
  act(() => hook.result.current.setMarks({ in: 1.9, out: 2.6 }));
  act(() => hook.result.current.takeMarked(true));
  expect(commits).toEqual([]);
  expect(hook.result.current.extractGuard).toEqual({ who: ["dev"], count: 1 });
  act(() => hook.result.current.takeMarked(false));
  expect(commits.map((item) => item.label)).toEqual(["Lift"]);
  expect(hook.result.current.extractGuard).toBeNull();
});

it("extracts without asking when every track with words in the range is selected, or when told to", () => {
  const { hook, commits } = setup();
  act(() => hook.result.current.setMarks({ in: 1.9, out: 2.6 }));
  act(() => hook.result.current.takeMarked(true));
  expect(commits.map((item) => item.label)).toEqual(["Extract"]);
  act(() => hook.result.current.toggleTrack("rosa", true));
  act(() => hook.result.current.setMarks({ in: 1.9, out: 2.6 }));
  act(() => hook.result.current.takeMarked(true, true));
  expect(commits.map((item) => item.label)).toEqual(["Extract", "Extract"]);
});

it("a delete moves the markers after it and drops one on the words it removed", () => {
  const marker = (id: string, at: number) => ({ id, at, track: null, name: id, comment: "", color: "red" });
  const { hook, commits, select } = setup({ ...openEdit, markers: [marker("on", 6.5), marker("after", 9)] });
  const index = hook.result.current.placed.findIndex((item) => item.word.id === "later");
  select(index, index);
  act(() => hook.result.current.remove(false));
  const markers = commits[0].change!.markers!;
  expect(markers.map((item) => item.id)).toEqual(["after"]);
  expect(markers[0].at).toBeLessThan(9);
});

it("⌫ at a caret deletes the word it names, not the selection the last render saw", () => {
  const { hook, commits } = setup();
  const index = hook.result.current.placed.findIndex((item) => item.word.id === "later");
  act(() => hook.result.current.remove(false, [index, index]));
  expect(commits.map((item) => item.label)).toEqual(["Delete 1 Word"]);
});

it("retires a dead-space review once the cut changes under it", () => {
  const hook = renderHook(({ open }) => useEditWorkspace({ open, words, lanes, sourceLanes: { s1: ["rosa", "dev"] }, durations: { s1: 10 },
    audible: new Map([["s1", [[1, 3], [6, 7]]]]), playhead: 0, seek: vi.fn(), commit: vi.fn(), nameOf: String, tc: String }), { initialProps: { open: openEdit } });
  act(() => hook.result.current.findDead("air"));
  expect(hook.result.current.dead).not.toBeNull();
  // Same cut, new objects (a marker was added): the review stands.
  hook.rerender({ open: { ...openEdit, timeline: { ...timeline, segments: timeline.segments.map((segment) => ({ ...segment })) } } });
  expect(hook.result.current.dead).not.toBeNull();
  hook.rerender({ open: { ...openEdit, timeline: { ...timeline, segments: [{ id: "whole", source: "s1", srcIn: 0, srcOut: 9 }] } } });
  expect(hook.result.current.dead).toBeNull();
});

it("an empty string out takes a whole source in one step", async () => {
  const empty = { ...openEdit, timeline: { segments: [], mutes: [] } } satisfies OpenEdit;
  const { hook, commits } = setup(empty);
  await act(async () => hook.result.current.addWhole("s1"));
  expect(commits).toHaveLength(1);
  expect(commits[0].label).toBe("Add Whole Sequence");
  const [segment] = commits[0].change!.timeline!.segments;
  expect(segment).toMatchObject({ source: "s1", srcIn: 0, srcOut: 10 });
  expect(hook.result.current.message).toBe("Added the whole sequence.");
  // A source with no known length is not guessed at.
  await act(async () => hook.result.current.addWhole("unknown"));
  expect(commits).toHaveLength(1);
});

it("patches whoever's words are cut in to the next track down, a group angle included, and says so", () => {
  const document = { tracks: [{ id: "rosa", name: "Rosa", kind: "sound", source_tracks: { s1: "1" } },
    { id: "ana", name: "Ana", kind: "sound", source_tracks: { s1: "branch-a" }, featured: false }] } as unknown as OpenEdit["document"];
  const { hook, commits } = setup({ ...openEdit, document });
  act(() => hook.result.current.insert("s1", [{ id: "hi", source: "s1", track: "ana", text: "hi", start: 4, end: 4.5 }], true));
  expect(commits.map((item) => item.label)).toEqual(["Insert 1 Word"]);
  expect(commits[0].change?.document?.tracks.map((track) => track.featured)).toEqual([undefined, true]);
  // The new clip plays the person whose words they are, and nobody else.
  expect(commits[0].change?.timeline?.segments).toHaveLength(2);
  expect(commits[0].change?.timeline?.segments.at(-1)?.tracks).toEqual(["ana"]);
  expect(hook.result.current.message).toBe("Inserted 1 word at 10. Ana is now on a track.");
});

it("an inserted group angle's own next word bounds the air kept after their line", () => {
  const document = { tracks: [{ id: "rosa", name: "Rosa", kind: "sound", source_tracks: { s1: "1" } },
    { id: "ana", name: "Ana", kind: "sound", source_tracks: { s1: "branch-a" }, featured: false }] } as unknown as OpenEdit["document"];
  // Ana says "hi" at 4.0-4.5 and "there" at 4.55: the cut may not reach into "there".
  const ana = [{ id: "hi", source: "s1", track: "ana", text: "hi", start: 4, end: 4.5 }, { id: "there", source: "s1", track: "ana", text: "there", start: 4.55, end: 5 }];
  const { hook, commits } = setup({ ...openEdit, document }, [...words, ...ana]);
  act(() => hook.result.current.insert("s1", [ana[0]], true));
  const added = commits[0].change!.timeline!.segments.at(-1)!;
  expect(added.srcOut).toBeLessThanOrEqual(4.55);
  expect(added.srcOut).toBeCloseTo(4.525);
});

it("takes anyone off their track, the tracks below moving up, and records nothing for someone with none", () => {
  const document = { tracks: [{ id: "rosa", name: "Rosa", kind: "sound", source_tracks: { s1: "1" } },
    { id: "ana", name: "Ana", kind: "sound", source_tracks: { s1: "branch-a" }, featured: true },
    { id: "kai", name: "Kai", kind: "sound", source_tracks: { s1: "3" }, featured: false }] } as unknown as OpenEdit["document"];
  const { hook, commits } = setup({ ...openEdit, document });
  act(() => hook.result.current.untrack("rosa"));
  act(() => hook.result.current.untrack("kai"));
  expect(commits.map((item) => item.change?.document?.tracks.map((track) => [track.id, track.featured]) ?? null)).toEqual([
    [["ana", true], ["rosa", false], ["kai", false]],
    null,
  ]);
});

it("the patch panel puts someone on a track, and a person already there is no change", () => {
  const document = { tracks: [{ id: "rosa", name: "Rosa", kind: "sound", source_tracks: { s1: "1" }, featured: true },
    { id: "kai", name: "Kai", kind: "sound", source_tracks: { s1: "3" }, featured: false }] } as unknown as OpenEdit["document"];
  const { hook, commits } = setup({ ...openEdit, document });
  act(() => hook.result.current.patch("kai", 0));
  act(() => hook.result.current.patch("rosa", 0));
  expect(commits.map((item) => item.change?.document?.tracks.map((track) => [track.id, track.featured]) ?? null)).toEqual([
    [["kai", true], ["rosa", true]],
    null,
  ]);
});
