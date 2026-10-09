// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { createFrameStore } from "../lib/frame-store";
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

function setup(open: OpenEdit = openEdit, everyone?: TimelineWord[], playhead = 0, snap = true) {
  const commits: { label: string; change: EditChange }[] = [];
  const commit = vi.fn(async (label: string, change: (state: OpenEdit) => EditChange) => { commits.push({ label, change: change(open) }); return true; });
  // No fps here, so the playhead store holds seconds.
  const seek = vi.fn(), frames = createFrameStore(playhead);
  const hook = renderHook(() => useEditWorkspace({ open, words, everyone, lanes, sourceLanes: { s1: ["rosa", "dev"] }, durations: { s1: 10 },
    audible: new Map([["s1", [[1, 3], [6, 7]]]]), frames, seek, commit, nameOf: (id) => id === "rosa" ? "Rosa" : "Dev", tc: (s) => `${s}`, snap }));
  const select = (from: number, to: number) => act(() => hook.result.current.setSelection({ anchor: from, focus: to, collapsed: false }));
  return { hook, commits, select, seek };
}

it("never cuts through overtalk: silences the speaker's own words and asks about the rest", () => {
  const { hook, commits, select } = setup();
  const index = hook.result.current.placed.findIndex((item) => item.word.id === "anyway");
  select(index, index);
  act(() => hook.result.current.remove(false));
  expect(commits.map((item) => item.label)).toEqual(["Mute Rosa"]);
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
  act(() => hook.result.current.toggleTrack(1, true));
  act(() => hook.result.current.setMarks({ in: 1.9, out: 2.6 }));
  act(() => hook.result.current.takeMarked(true));
  expect(commits).toEqual([]);
  expect(hook.result.current.extractGuard).toEqual({ who: ["dev"], count: 1 });
  act(() => hook.result.current.takeMarked(false));
  expect(commits.map((item) => item.label)).toEqual(["Lift"]);
  expect(hook.result.current.extractGuard).toBeNull();
});

it("Lift on one track takes it there alone, and restoring a lifted word undoes the Lift around it", () => {
  const { hook, commits } = setup();
  act(() => hook.result.current.toggleTrack(1, true));
  act(() => hook.result.current.setMarks({ in: 1, out: 3 }));
  act(() => hook.result.current.takeMarked(false));
  const lifted = commits[0].change!.timeline!;
  expect(lifted.mutes).toEqual([]);
  expect(lifted.segments.map((segment) => [segment.srcIn, segment.srcOut, segment.overrides ?? null])).toEqual([
    [0, 1, null], [1, 3, { rosa: { source: null } }], [3, 10, null]]);
  const again = setup({ ...openEdit, timeline: lifted });
  const shown = again.hook.result.current.placed;
  expect(shown.filter((item) => item.muted).map((item) => item.word.id)).toEqual(["so", "anyway"]);
  // One word: it and the air after it come back; "so", still lifted, stays out.
  const one = shown.findIndex((item) => item.word.id === "anyway");
  again.select(one, one);
  act(() => again.hook.result.current.remove(true));
  expect(again.commits[0].label).toBe("Unmute Rosa");
  expect(again.commits[0].change!.timeline!.segments.map((segment) => [segment.srcIn, segment.srcOut, segment.overrides ?? null])).toEqual([
    [0, 1, null], [1, 1.4, { rosa: { source: null } }], [1.4, 10, null]]);
  // Both: the whole Lift is undone and the clip is one again.
  again.select(shown.findIndex((item) => item.word.id === "so"), one);
  act(() => again.hook.result.current.remove(true));
  expect(again.commits[1].change!.timeline!.segments.map((segment) => [segment.srcIn, segment.srcOut, segment.overrides ?? null])).toEqual([[0, 10, null]]);
});

it("extracts without asking when every track with words in the range is selected, or when told to", () => {
  const { hook, commits } = setup();
  act(() => hook.result.current.setMarks({ in: 1.9, out: 2.6 }));
  act(() => hook.result.current.takeMarked(true));
  expect(commits.map((item) => item.label)).toEqual(["Extract"]);
  act(() => hook.result.current.toggleTrack(1, true));
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
    audible: new Map([["s1", [[1, 3], [6, 7]]]]), frames: createFrameStore(0), seek: vi.fn(), commit: vi.fn(), nameOf: String, tc: String }), { initialProps: { open: openEdit } });
  act(() => hook.result.current.findDead("air"));
  expect(hook.result.current.dead).not.toBeNull();
  // Same cut, new objects (a marker was added): the review stands.
  hook.rerender({ open: { ...openEdit, timeline: { ...timeline, segments: timeline.segments.map((segment) => ({ ...segment })) } } });
  expect(hook.result.current.dead).not.toBeNull();
  hook.rerender({ open: { ...openEdit, timeline: { ...timeline, segments: [{ id: "whole", source: "s1", srcIn: 0, srcOut: 9 }] } } });
  expect(hook.result.current.dead).toBeNull();
});

it("puts whoever's words are cut in on a record track, a group angle included, and says which", () => {
  const document = { tracks: [{ id: "rosa", name: "Rosa", kind: "sound", source_tracks: { s1: "1" } },
    { id: "ana", name: "Ana", kind: "sound", source_tracks: { s1: "branch-a" }, featured: false }] } as unknown as OpenEdit["document"];
  const { hook, commits } = setup({ ...openEdit, document });
  act(() => hook.result.current.insert("s1", [{ id: "hi", source: "s1", track: "ana", text: "hi", start: 4, end: 4.5 }], true));
  expect(commits.map((item) => item.label)).toEqual(["Insert 1 Word"]);
  expect(commits[0].change?.document?.tracks.map((track) => track.featured)).toEqual([undefined, true]);
  // The new clip plays the person whose words they are, and nobody else.
  expect(commits[0].change?.timeline?.segments).toHaveLength(2);
  expect(commits[0].change?.timeline?.segments.at(-1)).toMatchObject({ tracks: ["ana"], layers: { ana: 1 } });
  expect(hook.result.current.message).toBe("Inserted 1 word at 10 on A1.");
});

const patched = { ...openEdit, document: { tracks: [{ id: "rosa", name: "Rosa", kind: "sound", source_tracks: { s1: "1" } }] } as unknown as OpenEdit["document"] };

it("Insert lands at the record playhead, not at the text's caret, and parks the playhead after the new clip", () => {
  // Parked inside "later" (6-7 s): with Snap on, the splice moves to the gap before it.
  const { hook, commits, seek } = setup(patched, undefined, 6.4);
  const take = { in: 8, out: 9, playhead: 0, lanes: ["rosa"] };
  act(() => hook.result.current.insert("s1", [], false, take));
  const segments = commits[0].change!.timeline!.segments;
  expect(segments.map((segment) => [segment.srcIn, segment.srcOut])).toEqual([[0, 4.25], [8, 9], [4.25, 10]]);
  expect(seek).toHaveBeenLastCalledWith(5.25);
  // Snap off: exactly where the playhead is, through the word.
  const exact = setup(patched, undefined, 6.4, false);
  act(() => exact.hook.result.current.insert("s1", [], false, take));
  expect(exact.commits[0].change!.timeline!.segments[0].srcOut).toBeCloseTo(6.4);
});

it("a record In mark wins over the playhead, and the edit clears the record marks", () => {
  const { hook, commits } = setup(patched, undefined, 9);
  act(() => hook.result.current.setMarks({ in: 3.5, out: null }));
  act(() => hook.result.current.insert("s1", [], false, { in: 8, out: 9, playhead: 0, lanes: ["rosa"] }));
  expect(commits[0].change!.timeline!.segments[0].srcOut).toBeCloseTo(3.5);
  expect(hook.result.current.marks).toEqual({ in: null, out: null });
});

it("Overwrite replaces what is under the playhead for the clip's length on the chosen tracks alone, and the edit keeps its length", () => {
  const { hook, commits } = setup(patched, undefined, 4);
  act(() => hook.result.current.overwrite("s1", [], { in: 8, out: 9, playhead: 0, lanes: ["rosa"] }));
  expect(commits[0].label).toBe("Overwrite");
  const segments = commits[0].change!.timeline!.segments;
  // Rosa plays 8 to 9 s for that second; Dev, whose track was not chosen, keeps what he had.
  expect(segments.map((segment) => [segment.srcIn, segment.srcOut, segment.overrides ?? null])).toEqual([
    [0, 4, null], [4, 5, { rosa: { source: "s1", srcIn: 8 } }], [5, 10, null]]);
  expect(hook.result.current.message).toBe("Overwrote 1.0 s at 4 on A1.");
});

it("marks decide an edit by Avid's three-point rule: the record pair wins, a lone record Out backtimes, and a missing source mark is refused", () => {
  const shape = (change: EditChange) => change!.timeline!.segments.map((segment) => [segment.srcIn, segment.srcOut, segment.overrides ?? null]);
  // Record In 2 and Out 3, one source mark (In 8): a one-second Overwrite from 8.
  const pair = setup(patched, undefined, 7);
  act(() => pair.hook.result.current.setMarks({ in: 2, out: 3 }));
  act(() => pair.hook.result.current.overwrite("s1", [], { in: 8, out: null, playhead: 0, lanes: ["rosa"] }));
  expect(shape(pair.commits[0].change)).toEqual([[0, 2, null], [2, 3, { rosa: { source: "s1", srcIn: 8 } }], [3, 10, null]]);
  // Backtimed from the source Out instead: the second before 9.5.
  const back = setup(patched, undefined, 7);
  act(() => back.hook.result.current.setMarks({ in: 2, out: 3 }));
  act(() => back.hook.result.current.overwrite("s1", [], { in: null, out: 9.5, playhead: 0, lanes: ["rosa"] }));
  expect(shape(back.commits[0].change)[1]).toEqual([2, 3, { rosa: { source: "s1", srcIn: 8.5 } }]);
  // A record Out alone: the clip ENDS there.
  const ends = setup(patched, undefined, 0, false);
  act(() => ends.hook.result.current.setMarks({ in: null, out: 5 }));
  act(() => ends.hook.result.current.insert("s1", [], false, { in: 8, out: 9, playhead: 0, lanes: ["rosa"] }));
  expect(shape(ends.commits[0].change)).toEqual([[0, 4, null], [8, 9, null], [4, 10, null]]);
  // Nothing marked in the source and only a record In: refused, in a sentence, and nothing changes.
  const bare = setup(patched, undefined, 0);
  act(() => bare.hook.result.current.setMarks({ in: 2, out: null }));
  act(() => bare.hook.result.current.insert("s1", [], false, { in: null, out: null, playhead: 4, lanes: ["rosa"] }));
  expect(bare.commits).toHaveLength(0);
  expect(bare.hook.result.current.message).toMatch(/^Nothing is marked in the source/);
  // But with both record marks, the source playhead gives the start (Avid's Single-Mark Editing).
  act(() => bare.hook.result.current.setMarks({ in: 2, out: 3 }));
  act(() => bare.hook.result.current.overwrite("s1", [], { in: null, out: null, playhead: 4, lanes: ["rosa"] }));
  expect(shape(bare.commits[0].change)[1]).toEqual([2, 3, { rosa: { source: "s1", srcIn: 4 } }]);
});

it("the record caret is wherever the playhead is until a range is chosen", () => {
  const { hook } = setup(openEdit, undefined, 6.2);
  const later = hook.result.current.placed.findIndex((item) => item.word.id === "later");
  expect(hook.result.current.selection).toMatchObject({ anchor: later, collapsed: true });
  act(() => hook.result.current.setSelection({ anchor: 0, focus: 1, collapsed: false }));
  expect(hook.result.current.selection).toMatchObject({ anchor: 0, focus: 1, collapsed: false });
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

it("Insert puts material only on record tracks that are on, as Avid's track selectors do", () => {
  const both = { ...openEdit, document: { tracks: [{ id: "rosa", name: "Rosa", kind: "sound", source_tracks: { s1: "1" } }, { id: "dev", name: "Dev", kind: "sound", source_tracks: { s1: "2" } }] } as unknown as OpenEdit["document"] };
  const { hook, commits } = setup(both, undefined, 9);
  // Dev's record track off: a clip of both people lands on Rosa's alone.
  act(() => hook.result.current.toggleTrack(1, true));
  act(() => hook.result.current.insert("s1", [], false, { in: 8, out: 9, playhead: 0, lanes: ["rosa", "dev"] }));
  const clip = commits[0].change!.timeline!.segments.find((segment) => segment.srcIn === 8);
  expect(clip?.tracks).toEqual(["rosa"]);
  // Every track it would go to off: nothing is cut in, and the editor is told why.
  const none = setup(both, undefined, 9);
  act(() => none.hook.result.current.toggleTrack(1, true));
  act(() => none.hook.result.current.insert("s1", [], false, { in: 8, out: 9, playhead: 0, lanes: ["dev"], patch: { dev: 2 } }));
  expect(none.commits).toHaveLength(0);
  expect(none.hook.result.current.message).toMatch(/every record track it would go to is turned off/);
});

it("a record track is a layer: an Overwrite onto it replaces whoever was on it there, and says where it went", () => {
  const both = { ...openEdit, document: { tracks: [{ id: "rosa", name: "Rosa", kind: "sound", source_tracks: { s1: "1" } }, { id: "dev", name: "Dev", kind: "sound", source_tracks: { s1: "2" } }] } as unknown as OpenEdit["document"] };
  // Dev already plays on A2 here: putting another moment of Dev on A1 would take the A2 line away, so it is refused.
  const doubled = setup(both, undefined, 4);
  act(() => doubled.hook.result.current.overwrite("s1", [], { in: 8, out: 9, playhead: 0, lanes: ["dev"], patch: { dev: 1 } }));
  expect(doubled.commits).toHaveLength(0);
  expect(doubled.hook.result.current.message).toBe("Dev already plays on A2 there. Patch Dev to A2, or overwrite somewhere else.");
  // Only Rosa cut in: Dev's lav patched to A1, where Rosa is. For that second A1 plays Dev, and Rosa is lifted there.
  const rosaOnly = { ...both, timeline: { ...timeline, segments: timeline.segments.map((segment) => ({ ...segment, tracks: ["rosa"] })) } };
  const { hook, commits } = setup(rosaOnly, undefined, 4);
  act(() => hook.result.current.overwrite("s1", [], { in: 8, out: 9, playhead: 0, lanes: ["dev"], patch: { dev: 1 } }));
  const middle = commits[0].change!.timeline!.segments[1];
  expect([middle.srcIn, middle.srcOut, middle.overrides, middle.layers]).toEqual([4, 5, { rosa: { source: null }, dev: { source: "s1", srcIn: 8 } }, { dev: 1 }]);
  expect(hook.result.current.message).toBe("Overwrote 1.0 s at 4 on A1.");
  // Two people patched to one track: refused, in a sentence.
  act(() => hook.result.current.insert("s1", [], false, { in: 8, out: 9, playhead: 0, lanes: ["rosa", "dev"], patch: { rosa: 2, dev: 2 } }));
  expect(commits).toHaveLength(1);
  expect(hook.result.current.message).toBe("Rosa and Dev are both patched to A2. Patch one of them to another track.");
});

it("will not unsilence a lifted person onto a track someone else holds there now", () => {
  const both = { tracks: [{ id: "rosa", name: "Rosa", kind: "sound", source_tracks: { s1: "1" } }, { id: "dev", name: "Dev", kind: "sound", source_tracks: { s1: "2" } }] } as unknown as OpenEdit["document"];
  // Rosa's "later" (6-7 s) was lifted, and Dev was then overwritten onto her A1 there.
  const layered: Timeline = { segments: [
    { id: "a", source: "s1", srcIn: 0, srcOut: 6, tracks: ["rosa"] },
    { id: "b", source: "s1", srcIn: 6, srcOut: 7, tracks: ["rosa"], overrides: { rosa: { source: null }, dev: { source: "s1", srcIn: 2 } }, layers: { dev: 1 } },
    { id: "c", source: "s1", srcIn: 7, srcOut: 10, tracks: ["rosa"] },
  ], mutes: [] };
  const { hook, commits, select } = setup({ ...openEdit, document: both, timeline: layered });
  const index = hook.result.current.placed.findIndex((item) => item.word.id === "later");
  expect(hook.result.current.placed[index].muted).toBe(true);
  select(index, index);
  act(() => hook.result.current.remove(true));
  expect(commits).toHaveLength(0);
  expect(hook.result.current.message).toBe("Dev is on A1 there now, where Rosa was. Move one of them to another track first.");
});

it("refuses a patch past A64 when the edit is made, not later at the save", () => {
  const both = { tracks: [{ id: "rosa", name: "Rosa", kind: "sound", source_tracks: { s1: "1" } }, { id: "dev", name: "Dev", kind: "sound", source_tracks: { s1: "2" } }] } as unknown as OpenEdit["document"];
  const { hook, commits } = setup({ ...openEdit, document: both });
  act(() => hook.result.current.insert("s1", [], false, { in: 8, out: 9, playhead: 0, lanes: ["rosa"], patch: { rosa: 65 } }));
  expect(commits).toHaveLength(0);
  expect(hook.result.current.message).toBe("Media Composer takes 64 audio tracks, and Rosa is patched past A64. Patch fewer people, or patch them to lower tracks.");
});

it("Match Frame takes the clip under the playhead on the lowest selected track, a selected clip first, and the source frame under it", () => {
  const both = { tracks: [{ id: "rosa", name: "Rosa", kind: "sound", source_tracks: { s1: "1" } }, { id: "dev", name: "Dev", kind: "sound", source_tracks: { s1: "2" } }] } as unknown as OpenEdit["document"];
  // Rosa on A1 from 2 s of the source; over the same stretch Dev on A2 plays from 8 s.
  const layered: Timeline = { segments: [{ id: "a", source: "s1", srcIn: 2, srcOut: 6, tracks: ["rosa"], overrides: { dev: { source: "s1", srcIn: 8 } }, layers: { rosa: 1, dev: 2 } }], mutes: [] };
  const { hook } = setup({ ...openEdit, document: both, timeline: layered }, undefined, 1.5);
  expect(hook.result.current.matchTarget()).toEqual({ source: "s1", lane: "rosa", at: 3.5, layer: 1 });
  act(() => hook.result.current.toggleTrack(2, true));
  expect(hook.result.current.matchTarget()).toEqual({ source: "s1", lane: "dev", at: 9.5, layer: 2 });
  act(() => hook.result.current.toggleTrack(1, true));
  act(() => hook.result.current.pickClip({ layer: 2, from: 0 }, false));
  expect(hook.result.current.matchTarget()?.lane).toBe("dev");
  // Past the end: nothing to match, and it says so.
  const after = setup({ ...openEdit, document: both, timeline: layered }, undefined, 9);
  let none: ReturnType<typeof after.hook.result.current.matchTarget> | undefined;
  act(() => { none = after.hook.result.current.matchTarget(); });
  expect(none).toBeNull();
  expect(after.hook.result.current.message).toBe("There is no clip under the playhead to match.");
});
