import { useMemo, useState } from "react";
import type { EditDeadPreset, EditDeadReview } from "../components/EditDeadSpaceBar";
import { editDeadPresets } from "../components/EditDeadSpaceBar";
import type { EditSelection } from "../components/EditTranscript";
import { rippleMarkers, type OpenEdit, type TimelineMarker } from "../lib/edit-document";
import type { AafDocument } from "../bindings/AafDocument";
import { giveTracks, patchAt, unpatch } from "../lib/edit-new";
import { alternativeLane } from "../lib/multitrack-graph";
import {
  addEdit, clipAround, cutRange, deadDefaults, deleteWords, extractProgram, findDeadSpace, ghostLines, healSeam, liftOnTracks, liftProgram,
  moveParagraph, muteWords, overwrite, paragraphs, placementKey, placeWords, programDuration, removeDeadSpace, restoreRange, seamList, segmentStarts,
  snapToGap, spliceIn, unmuteWords, type DeleteResult, type Ghost, type Timeline, type TimelineLane, type TimelineWord,
} from "../lib/edit-model";
import { measure } from "../lib/pipeline";
import type { EditChange } from "./use-edit-session";

type Commit = (label: string, change: (open: OpenEdit) => EditChange, group?: string | null) => Promise<boolean>;
export type EditMarks = { in: number | null; out: number | null };
type Prompt = { result: DeleteResult; keys: Set<string>; count: number; who: string[] };

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;
const toggled = <T,>(set: Set<T>, item: T) => { const next = new Set(set); if (!next.delete(item)) next.add(item); return next; };

type Options = {
  open: OpenEdit; words: TimelineWord[]; lanes: TimelineLane[]; durations: Record<string, number>;
  /** Everyone's words, group angles without a track included (`words` is only the people on tracks). */
  everyone?: TimelineWord[];
  /** Which lanes each source has a mic for. */
  sourceLanes: Record<string, string[]>;
  audible: Map<string, [number, number][]>; playhead: number; seek: (seconds: number) => void; commit: Commit;
  nameOf: (lane: string) => string; tc: (seconds: number) => string;
  /** Snap (N): a splice lands between words rather than inside one. */
  snap?: boolean;
  /** The edit's frame rate: a splice's source range and record point land on frames, as Avid's do. */
  fps?: number;
  /** The sources' AAF Audio sequences, which say who has a track of their own in one. */
  documents?: Map<string, AafDocument>;
};

/**
 * The editor's working state and every action that changes the edit. Model
 * work is in seconds (edit-model.ts); each change goes to the undo log through
 * `commit`, which snaps it to frames. Marks, selection, solo and the dead-space
 * review are view state and never enter the history.
 */
export function useEditWorkspace({ open, words, everyone, lanes, sourceLanes, durations, audible, playhead, seek, commit, nameOf, tc, documents, snap = true, fps }: Options) {
  const edit = open.timeline, markers = open.markers;
  const [stored, setSelection] = useState<EditSelection>({ anchor: 0, focus: 0, collapsed: true });
  const [marks, setMarks] = useState<EditMarks>({ in: null, out: null });
  const [tracks, setTracks] = useState<Set<string> | null>(null);
  /** A dead-space review holds for the timeline it was found on; any change to the cut retires it. */
  const [deadHeld, setDeadHeld] = useState<{ review: EditDeadReview; against: string } | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  /** An Extract that would take words from a track that is not selected, waiting for a choice. */
  const [extractGuard, setExtractGuard] = useState<{ who: string[]; count: number } | null>(null);
  const [seam, setSeam] = useState<number | null>(null);
  /** The marker clicked on the ruler, for the Inspector to edit and Delete to remove. */
  const [marker, setMarker] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const cutKey = useMemo(() => JSON.stringify(edit.segments), [edit.segments]);
  const dead = deadHeld && deadHeld.against === cutKey ? deadHeld.review : null;
  const setDead = (review: EditDeadReview | null) => setDeadHeld(review && { review, against: cutKey });
  /**
   * Every change to the cut is computed from the log's CURRENT state, never
   * from the one this render saw (a commit may still be in flight), and
   * carries the markers along with the material under them.
   */
  const change = (label: string, next: (timeline: Timeline) => Timeline | null, group?: string | null) =>
    commit(label, (state) => {
      const timeline = next(state.timeline);
      return !timeline || timeline === state.timeline ? null : { timeline, markers: rippleMarkers(state.timeline, timeline, state.markers) };
    }, group);
  const placed = useMemo(() => measure("String Outs", `Placing ${words.length.toLocaleString("en-US")} words on the record`, () => placeWords(words, edit)), [words, edit]);
  const paras = useMemo(() => measure("String Outs", `Laying out ${placed.length.toLocaleString("en-US")} record words as paragraphs`, () => paragraphs(placed)), [placed]);
  const seams = useMemo(() => seamList(edit, words), [edit, words]);
  const ghosts = useMemo(() => ghostLines(edit, words, durations), [edit, words, durations]);
  const total = programDuration(edit), starts = segmentStarts(edit), count = placed.length;
  // One record position, as in Avid: a caret is wherever the playhead is, so
  // Insert, Add Edit, markers and the text all mean the same place. A range
  // is the editor's own choice and stays put while the playhead moves.
  const underPlayhead = placed.findIndex((item) => item.programEnd > playhead + 1e-6);
  const parked = underPlayhead < 0 ? count : underPlayhead;
  const selection: EditSelection = stored.collapsed ? { anchor: parked, focus: parked, collapsed: true, after: !!stored.after && stored.anchor === parked } : stored;
  const onTracks = tracks ?? new Set(lanes.map((lane) => lane.id));
  const range: [number, number] | null = selection.collapsed || !count ? null
    : [Math.min(selection.anchor, selection.focus, count - 1), Math.min(Math.max(selection.anchor, selection.focus), count - 1)];
  const caret = Math.min(selection.anchor, count);
  const selected = range ? placed.slice(range[0], range[1] + 1) : [];
  const keys = new Set(selected.map(placementKey));
  const marked = marks.in != null && marks.out != null && marks.out > marks.in ? [marks.in, marks.out] as const : null;
  const names = (ids: string[]) => { const list = [...new Set(ids)].map(nameOf); return list.length < 3 ? list.join(" and ") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`; };

  const applyDelete = (cut: Set<string>, removed: number, at = range ? range[0] : caret) => {
    const result = deleteWords(words, edit, cut);
    void change(`Delete ${plural(removed, "Word")}`, (timeline) => deleteWords(words, timeline, cut).edit);
    setSelection({ anchor: at, focus: at, collapsed: true, after: at > 0 });
    setPrompt(null); setSeam(null);
    seek(at > 0 ? placeWords(words, result.edit)[at - 1]?.programEnd ?? 0 : 0);
    setMessage(`Deleted ${plural(removed, "word")}, ${result.seconds.toFixed(2)} s.`);
  };
  const lift = (ids: Set<string>, chosen: typeof selected) => {
    const restoring = chosen.every((item) => item.muted);
    void change(`${restoring ? "Unsilence" : "Silence"} ${names(chosen.map((item) => item.word.track))}`,
      (timeline) => restoring ? unmuteWords(words, timeline, ids) : muteWords(words, timeline, ids));
    setMessage(`${restoring ? "Unsilenced" : "Silenced"} ${plural(ids.size, "word")}.`);
  };
  /**
   * Delete, or with `trackOnly` silence on the speaker's own track. Overtalk is
   * never cut through. `explicit` names the words when the caller has just
   * chosen them (⌫ at a caret), since the selection state is not updated yet.
   */
  const remove = (trackOnly: boolean, explicit?: [number, number]) => {
    const chosen = explicit ? placed.slice(explicit[0], explicit[1] + 1) : selected;
    if (!chosen.length) return;
    const ids = new Set(chosen.map((item) => item.word.id));
    const cut = new Set(chosen.map(placementKey));
    if (trackOnly) return lift(ids, chosen);
    const dry = deleteWords(words, edit, cut);
    if (dry.crosstalk.length) {
      lift(ids, chosen);
      return setPrompt({ result: dry, keys: cut, count: chosen.length, who: chosen.map((item) => item.word.track) });
    }
    applyDelete(cut, chosen.length, explicit ? explicit[0] : undefined);
  };
  const restore = (ghost: Ghost) => {
    void change("Restore Line", (timeline) => restoreRange(timeline, ghost.at, ghost.source, ghost.from, ghost.to));
    setMessage(`Restored ${nameOf(ghost.track)}'s line.`);
  };
  /**
   * Splice (or overwrite) source words in at the record In mark, else the
   * record playhead, as Avid's V and B do; with Snap on the point moves to the
   * nearest gap between words so a splice never lands mid-word. Append goes at
   * the end. The playhead then parks after the new clip, so pressing V again
   * builds the cut in order, and the record marks clear, as an edit clears
   * them in Avid. With `take`, the source side decides the rest, as Avid's
   * source monitor and track selectors do: with no words selected its In to
   * Out is the clip (room tone has no words), and the clip plays exactly the
   * lanes whose mics are on, each patched to the next record track down if it
   * has none yet. Without it, the clip plays the people whose words were selected.
   */
  const place = (how: "insert" | "append" | "overwrite", source: string, sourceWords: TimelineWord[], take?: { from: number; to: number; lanes: string[] }) => {
    if (!sourceWords.length && !take) return;
    // Their own neighbouring words bound the air kept around the cut.
    const speakers = new Set(sourceWords.map((word) => word.track));
    const bounds = words.concat((everyone ?? []).filter((word) => speakers.has(word.track)));
    // On frames before anything is computed: the saved edit is whole frames, and
    // rounding afterwards could leave an Overwrite a frame longer or shorter.
    const frame = (seconds: number) => fps ? Math.round(seconds * fps) / fps : seconds;
    const [srcIn, srcOut] = (sourceWords.length ? cutRange(bounds, sourceWords, { id: "whole", source, srcIn: 0, srcOut: durations[source] ?? Infinity }) : [take!.from, take!.to]).map(frame);
    const lanes = take ? take.lanes : [...speakers];
    const at = Math.max(0, Math.min(total, marks.in ?? playhead));
    const position = how === "append" ? total : frame(snap ? snapToGap(edit, placed, at) : at);
    const given = open.document.tracks.filter((lane) => lane.featured === false && lanes.includes(lane.id)).map((lane) => lane.name);
    const label = how === "overwrite" ? "Overwrite" : sourceWords.length ? `Insert ${plural(sourceWords.length, "Word")}` : "Insert Clip";
    void commit(label, (state) => {
      const timeline = (how === "overwrite" ? overwrite : spliceIn)(state.timeline, source, srcIn, srcOut, position, lanes);
      return { timeline, markers: rippleMarkers(state.timeline, timeline, state.markers), document: giveTracks(state.document, lanes) };
    });
    setMarks({ in: null, out: null });
    seek(position + srcOut - srcIn);
    const what = sourceWords.length ? plural(sourceWords.length, "word") : `${(srcOut - srcIn).toFixed(1)} s`;
    setMessage(`${how === "overwrite" ? "Overwrote" : "Inserted"} ${what} at ${tc(position)}.${given.length ? ` ${given.join(", ")} ${given.length === 1 ? "is" : "are"} now on ${given.length === 1 ? "a track" : "tracks"}.` : ""}`);
  };
  const insert = (source: string, sourceWords: TimelineWord[], atEnd: boolean, take?: { from: number; to: number; lanes: string[] }) =>
    place(atEnd ? "append" : "insert", source, sourceWords, take);
  /** Take someone off their record track; the tracks below move up. */
  const untrack = (id: string) => void commit(`Take ${nameOf(id)} Off a Track`, (state) => {
    const document = unpatch(state.document, id);
    return document === state.document ? null : { document };
  });
  /** The patch panel: put someone on record track `position` (0 for A1). */
  const patch = (id: string, position: number) => void commit(`Patch ${nameOf(id)} to A${position + 1}`, (state) => {
    const document = patchAt(state.document, id, position);
    return document === state.document ? null : { document };
  });
  /** An empty string out's quickest start: a source whole, as the first clip. */
  const addWhole = (source: string) => {
    const length = durations[source] ?? 0;
    if (length <= 0) return;
    // Everyone with a track of their own in it comes on a track, in the sequence's order, as the whole sequence has them.
    const aaf = documents?.get(source);
    const own = aaf ? aaf.manifest.tracks.filter((track) => !alternativeLane(aaf, track.id))
      .flatMap((track) => open.document.tracks.filter((lane) => lane.source_tracks[source] === track.id).map((lane) => lane.id)) : [];
    void commit("Add Whole Sequence", (state) => {
      const timeline = spliceIn(state.timeline, source, 0, length, programDuration(state.timeline));
      return { timeline, markers: rippleMarkers(state.timeline, timeline, state.markers), document: giveTracks(state.document, own) };
    });
    setMessage("Added the whole sequence.");
  };
  const move = (index: number, direction: -1 | 1) => {
    const paragraph = paras[index];
    if (!paragraph || !paras[index + direction]) return;
    const next = moveParagraph(words, edit, paragraph, direction < 0 ? paras[index - 1] : paras[index + 2] ?? null);
    if (next === edit) return;
    const target = direction < 0 ? paras[index - 1] : paras[index + 2] ?? null;
    void change("Move Paragraph", (timeline) => moveParagraph(words, timeline, paragraph, target), `move:${paragraph.words[0].word.id}`);
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
    void change("Restore Cut", (timeline) => healSeam(timeline, seam));
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
    void change(close ? "Extract" : "Lift", (timeline) => close ? extractProgram(timeline, from, to).edit
      : every ? liftProgram(timeline, from, to) : liftOnTracks(timeline, from, to, (source) => (sourceLanes[source] ?? []).filter((id) => onTracks.has(id))));
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
    const keep = editDeadPresets[dead.preset].keep;
    // The spaces were found on this cut; if the log has moved on, they no longer mean anything.
    if (result.seconds > 0) void change("Remove Dead Space", (timeline) => JSON.stringify(timeline.segments) === cutKey ? removeDeadSpace(timeline, chosen, keep).edit : null);
    setDead(null);
    setMessage(`Removed ${result.seconds.toFixed(1)} s.`);
  };
  const addMarker = () => void commit("Add Marker", (state) => state.markers.some((m) => Math.abs(m.at - playhead) < 1e-3) ? null
    : { markers: [...state.markers, { id: `m-${Date.now().toString(36)}`, at: playhead, track: null, name: "Marker", comment: "", color: "red" }].sort((a, b) => a.at - b.at) });
  const updateMarker = (id: string, change: Partial<Pick<TimelineMarker, "name" | "comment" | "color">>, group?: string) =>
    void commit("Edit Marker", (state) => ({ markers: state.markers.map((item) => item.id === id ? { ...item, ...change } : item) }), group ?? `marker:${id}`);
  const removeMarker = (id: string) => { setMarker(null); void commit("Delete Marker", (state) => ({ markers: state.markers.filter((item) => item.id !== id) })); };
  const cutHere = () => void change("Add Edit", (timeline) => addEdit(timeline, playhead));
  const setTimeline = (label: string, next: Timeline) => void change(label, () => next);

  return {
    edit, markers, placed, paras, seams, ghosts, total, count, range, caret, selected, keys, marks, marked, onTracks, selection, dead, prompt, seam, message, extractGuard, setExtractGuard,
    setSelection, setMarks, setSeam, setMessage, setPrompt, setDead, names, marker: markers.find((item) => item.id === marker) ?? null, setMarker, updateMarker, removeMarker,
    toggleTrack: (id: string, only: boolean) => setTracks((state) => only ? new Set([id]) : toggled(state ?? new Set(lanes.map((lane) => lane.id)), id)),
    skipDead: (index: number) => setDeadHeld((state) => state && { ...state, review: { ...state.review, skip: toggled(state.review.skip, index) } }),
    remove, applyDelete, restore, insert, overwrite: (source: string, sourceWords: TimelineWord[], take?: { from: number; to: number; lanes: string[] }) => place("overwrite", source, sourceWords, take), untrack, patch, addWhole, move, chooseSeam, healCut, takeMarked, findDead, applyDead, addMarker, cutHere, setTimeline,
    markIn: () => setMarks((m) => ({ in: playhead, out: m.out != null && m.out > playhead ? m.out : null })),
    markOut: () => setMarks((m) => ({ in: m.in != null && m.in < playhead ? m.in : null, out: playhead })),
    markClip: () => { const clip = clipAround(edit, playhead); if (clip) setMarks({ in: clip[0], out: clip[1] }); },
  };
}
