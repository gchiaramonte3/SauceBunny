import { useMemo, useState } from "react";
import type { EditDeadPreset, EditDeadReview } from "../components/EditDeadSpaceBar";
import { editDeadPresets } from "../components/EditDeadSpaceBar";
import type { EditSelection } from "../components/EditTranscript";
import type { OpenEdit, TimelineMarker } from "../lib/edit-document";
import {
  addEdit, clipAround, cutRange, deadDefaults, deleteWords, extractProgram, findDeadSpace, ghostLines, healSeam, liftOnTracks, liftProgram,
  moveParagraph, muteWords, paragraphs, placementKey, placeWords, programDuration, removeDeadSpace, restoreRange, seamList, segmentStarts,
  spliceIn, unmuteWords, type DeleteResult, type Ghost, type Timeline, type TimelineLane, type TimelineWord,
} from "../lib/edit-model";
import type { EditChange } from "./use-edit-session";

type Commit = (label: string, change: (open: OpenEdit) => EditChange, group?: string | null) => Promise<unknown>;
export type EditMarks = { in: number | null; out: number | null };
type Prompt = { result: DeleteResult; count: number; who: string[] };

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;
const toggled = <T,>(set: Set<T>, item: T) => { const next = new Set(set); if (!next.delete(item)) next.add(item); return next; };

type Options = {
  open: OpenEdit; words: TimelineWord[]; lanes: TimelineLane[]; durations: Record<string, number>;
  /** Which lanes each source has a mic for. */
  sourceLanes: Record<string, string[]>;
  audible: Map<string, [number, number][]>; playhead: number; seek: (seconds: number) => void; commit: Commit;
  nameOf: (lane: string) => string; tc: (seconds: number) => string;
};

/**
 * The editor's working state and every action that changes the edit. Model
 * work is in seconds (edit-model.ts); each change goes to the undo log through
 * `commit`, which snaps it to frames. Marks, selection, solo and the dead-space
 * review are view state and never enter the history.
 */
export function useEditWorkspace({ open, words, lanes, sourceLanes, durations, audible, playhead, seek, commit, nameOf, tc }: Options) {
  const edit = open.timeline, markers = open.markers;
  const [selection, setSelection] = useState<EditSelection>({ anchor: 0, focus: 0, collapsed: true });
  const [marks, setMarks] = useState<EditMarks>({ in: null, out: null });
  const [tracks, setTracks] = useState<Set<string> | null>(null);
  const [dead, setDead] = useState<EditDeadReview | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  /** An Extract that would take words from a track that is not selected, waiting for a choice. */
  const [extractGuard, setExtractGuard] = useState<{ who: string[]; count: number } | null>(null);
  const [seam, setSeam] = useState<number | null>(null);
  const [message, setMessage] = useState("");

  const placed = useMemo(() => placeWords(words, edit), [words, edit]);
  const paras = useMemo(() => paragraphs(placed), [placed]);
  const seams = useMemo(() => seamList(edit, words), [edit, words]);
  const ghosts = useMemo(() => ghostLines(edit, words, durations), [edit, words, durations]);
  const total = programDuration(edit), starts = segmentStarts(edit), count = placed.length;
  const onTracks = tracks ?? new Set(lanes.map((lane) => lane.id));
  const range: [number, number] | null = selection.collapsed || !count ? null
    : [Math.min(selection.anchor, selection.focus, count - 1), Math.min(Math.max(selection.anchor, selection.focus), count - 1)];
  const caret = Math.min(selection.anchor, count);
  const selected = range ? placed.slice(range[0], range[1] + 1) : [];
  const keys = new Set(selected.map(placementKey));
  const marked = marks.in != null && marks.out != null && marks.out > marks.in ? [marks.in, marks.out] as const : null;
  const names = (ids: string[]) => { const list = [...new Set(ids)].map(nameOf); return list.length < 3 ? list.join(" and ") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`; };

  const applyDelete = (result: DeleteResult, removed: number) => {
    const at = range ? range[0] : caret;
    void commit(`Delete ${plural(removed, "Word")}`, () => ({ timeline: result.edit }));
    setSelection({ anchor: at, focus: at, collapsed: true, after: at > 0 });
    setPrompt(null); setSeam(null);
    seek(at > 0 ? placeWords(words, result.edit)[at - 1]?.programEnd ?? 0 : 0);
    setMessage(`Deleted ${plural(removed, "word")}, ${result.seconds.toFixed(2)} s.`);
  };
  const lift = (ids: Set<string>) => {
    const restoring = selected.every((item) => item.muted);
    void commit(restoring ? "Restore on Track" : `Remove from ${names(selected.map((item) => item.word.track))}'s Track`,
      (state) => ({ timeline: restoring ? unmuteWords(words, state.timeline, ids) : muteWords(words, state.timeline, ids) }));
    setMessage(`${restoring ? "Unsilenced" : "Silenced"} ${plural(ids.size, "word")}.`);
  };
  /** Delete, or with `trackOnly` silence on the speaker's own track. Overtalk is never cut through. */
  const remove = (trackOnly: boolean) => {
    if (!selected.length) return;
    const ids = new Set(selected.map((item) => item.word.id));
    const dry = deleteWords(words, edit, keys);
    if (trackOnly) return lift(ids);
    if (dry.crosstalk.length) {
      lift(ids);
      return setPrompt({ result: dry, count: selected.length, who: selected.map((item) => item.word.track) });
    }
    applyDelete(dry, selected.length);
  };
  const restore = (ghost: Ghost) => {
    void commit("Restore Line", (state) => ({ timeline: restoreRange(state.timeline, ghost.at, ghost.source, ghost.from, ghost.to) }));
    setMessage(`Restored ${nameOf(ghost.track)}'s line.`);
  };
  const insertionPoint = (index: number) => {
    if (index >= count) return total;
    if (index <= 0) return 0;
    const [before, after] = [placed[index - 1], placed[index]];
    return before.segment !== after.segment ? starts[after.segment] : (before.programEnd + after.programStart) / 2;
  };
  /** Splice source words in at the caret (or the end), as a splice-in does. */
  const insert = (source: string, sourceWords: TimelineWord[], atEnd: boolean) => {
    if (!sourceWords.length) return;
    const [srcIn, srcOut] = cutRange(words, sourceWords, { id: "whole", source, srcIn: 0, srcOut: durations[source] ?? Infinity });
    const position = atEnd ? total : insertionPoint(range ? range[0] : caret);
    void commit(`Insert ${plural(sourceWords.length, "Word")}`, (state) => ({ timeline: spliceIn(state.timeline, source, srcIn, srcOut, position) }));
    setMessage(`Inserted ${plural(sourceWords.length, "word")} at ${tc(position)}.`);
  };
  const move = (index: number, direction: -1 | 1) => {
    const paragraph = paras[index];
    if (!paragraph || !paras[index + direction]) return;
    const next = moveParagraph(words, edit, paragraph, direction < 0 ? paras[index - 1] : paras[index + 2] ?? null);
    if (next === edit) return;
    void commit("Move Paragraph", () => ({ timeline: next }), `move:${paragraph.words[0].word.id}`);
    const first = placeWords(words, next).findIndex((item) => item.word.id === paragraph.words[0].word.id);
    setSelection({ anchor: first, focus: first + paragraph.words.length - 1, collapsed: false });
  };
  const chooseSeam = (index: number) => {
    setSeam(index); seek(starts[index] ?? 0);
    const info = seams.find((item) => item.index === index);
    if (info) setMessage(info.kind === "cut" ? `Cut at ${tc(info.at)}, ${info.gap.toFixed(2)} s removed.` : `Edit point at ${tc(info.at)}.`);
  };
  const healCut = () => {
    const info = seams.find((item) => item.index === seam);
    if (seam == null || !info || info.kind !== "cut") return;
    void commit("Restore Cut", (state) => ({ timeline: healSeam(state.timeline, seam) }));
    setSeam(null);
  };
  /**
   * Lift (Z) takes the marked range off the SELECTED tracks and leaves a hole;
   * the others keep playing. Extract (X) closes the range up on EVERY track,
   * because a magnetic timeline stays in sync. So an Extract over someone on
   * a track that is not selected would take their words too, and asks first,
   * the way a delete over overtalk does.
   */
  const takeMarked = (close: boolean, force = false) => {
    if (!marked) return;
    const [from, to] = marked;
    const every = lanes.every((lane) => onTracks.has(lane.id));
    if (close && !force && !every) {
      const caught = placed.filter((item) => !item.muted && !onTracks.has(item.word.track) && item.programStart < to && item.programEnd > from);
      if (caught.length) return setExtractGuard({ who: caught.map((item) => item.word.track), count: caught.length });
    }
    setExtractGuard(null);
    const shiftMarkers = (list: TimelineMarker[]) => list.filter((m) => m.at <= from || m.at >= to).map((m) => m.at >= to ? { ...m, at: m.at - (to - from) } : m);
    void commit(close ? "Extract" : "Lift", (state) => close
      ? { timeline: extractProgram(state.timeline, from, to).edit, markers: shiftMarkers(state.markers) }
      : { timeline: every ? liftProgram(state.timeline, from, to) : liftOnTracks(state.timeline, from, to, (source) => (sourceLanes[source] ?? []).filter((id) => onTracks.has(id))) });
    setMarks({ in: null, out: null }); seek(from);
    setMessage(`${close ? "Extracted" : "Lifted"} ${(to - from).toFixed(2)} s.`);
  };
  // Dead space: nothing audible on ANY mic (the speech analysis's hysteresis
  // spans, reactions included) and no word. Every track, since removing it ripples all.
  const loudest = (source: string, from: number, to: number) => (audible.get(source) ?? []).some(([a, b]) => a < to && b > from) ? 1 : 0;
  const findDead = (preset: EditDeadPreset = dead?.preset ?? "air") =>
    setDead({ spaces: findDeadSpace(edit, words, loudest, { ...deadDefaults, minimum: editDeadPresets[preset].minimum }), skip: new Set(), preset });
  const applyDead = () => {
    if (!dead) return;
    const chosen = dead.spaces.filter((_, index) => !dead.skip.has(index));
    const result = removeDeadSpace(edit, chosen, editDeadPresets[dead.preset].keep);
    if (result.seconds > 0) void commit("Remove Dead Space", () => ({ timeline: result.edit, markers: [] }));
    setDead(null);
    setMessage(`Removed ${result.seconds.toFixed(1)} s.`);
  };
  const addMarker = () => void commit("Add Marker", (state) => state.markers.some((m) => Math.abs(m.at - playhead) < 1e-3) ? null
    : { markers: [...state.markers, { id: `m-${Date.now().toString(36)}`, at: playhead, track: null, name: "Marker", comment: "", color: "red" }].sort((a, b) => a.at - b.at) });
  const cutHere = () => { const next = addEdit(edit, playhead); if (next !== edit) void commit("Add Edit", () => ({ timeline: next })); };
  const setTimeline = (label: string, timeline: Timeline) => void commit(label, () => ({ timeline, markers: [] }));

  return {
    edit, markers, placed, paras, seams, ghosts, total, count, range, caret, selected, keys, marks, marked, onTracks, selection, dead, prompt, seam, message, extractGuard, setExtractGuard,
    setSelection, setMarks, setSeam, setMessage, setPrompt, setDead, names,
    toggleTrack: (id: string, only: boolean) => setTracks((state) => only ? new Set([id]) : toggled(state ?? new Set(lanes.map((lane) => lane.id)), id)),
    skipDead: (index: number) => setDead((state) => state && { ...state, skip: toggled(state.skip, index) }),
    remove, applyDelete, restore, insert, move, chooseSeam, healCut, takeMarked, findDead, applyDead, addMarker, cutHere, setTimeline,
    markIn: () => setMarks((m) => ({ in: playhead, out: m.out != null && m.out > playhead ? m.out : null })),
    markOut: () => setMarks((m) => ({ in: m.in != null && m.in < playhead ? m.in : null, out: playhead })),
    markClip: () => { const clip = clipAround(edit, playhead); if (clip) setMarks({ in: clip[0], out: clip[1] }); },
  };
}
