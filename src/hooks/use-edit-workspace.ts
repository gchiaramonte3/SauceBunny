import { useMemo, useState } from "react";
import type { FrameStore } from "../lib/frame-store";
import type { EditDeadPreset, EditDeadReview } from "../components/EditDeadSpaceBar";
import { editDeadPresets } from "../components/EditDeadSpaceBar";
import type { EditSelection } from "../components/EditTranscript";
import { rippleMarkers, type OpenEdit, type TimelineMarker } from "../lib/edit-document";
import { giveTracks } from "../lib/edit-new";
import {
  addCut, clipAround, cutRange, doubledLane, firstAbove, runningEnds, deadDefaults, deleteWords, extractProgram, findDeadSpace, ghostLines, healSeam, layerClips, layerCount, layerOf, liftLayers, liftProgram,
  moveParagraph, muteWords, overwrite, paragraphs, placementKey, placeWords, programDuration, recordOrder, removeDeadSpace, restoreRange, seamList, segmentStarts,
  segmentLength, snapToGap, spliceIn, liftedAround, trackTakenFrom, unliftOnTrack, unmuteWords, type DeleteResult, type Ghost, type Layering, type Placement, type Timeline, type TimelineLane, type TimelineWord,
} from "../lib/edit-model";
import { measure } from "../lib/pipeline";
import { resolveThreePoint } from "../lib/edit-three-point";
import { copyClips, extractClips, liftClips, moveClips, nearestCut, pasteClips, pickedClip, slide, slip, trim, type ClipCopy, type ClipPick, type Roller, type TrimContext } from "../lib/edit-trim";
import type { EditChange } from "./use-edit-session";

type Commit = (label: string, change: (open: OpenEdit) => EditChange, group?: string | null) => Promise<boolean>;
export type EditMarks = { in: number | null; out: number | null };
type Prompt = { result: DeleteResult; keys: Set<string>; count: number; who: string[] };
/**
 * The source side of an edit: its marks (either may be unset), its playhead,
 * the lanes it brings, and the record track each is patched to (absent: the
 * brought lanes top-down from A1).
 */
type SourceMarks = { in: number | null; out: number | null; playhead: number; lanes: string[]; patch?: Record<string, number> };

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;
const toggled = <T,>(set: Set<T>, item: T) => { const next = new Set(set); if (!next.delete(item)) next.add(item); return next; };

type Options = {
  open: OpenEdit; words: TimelineWord[]; lanes: TimelineLane[]; durations: Record<string, number>;
  /** Everyone's words, group angles without a track included (`words` is only the people on tracks). */
  everyone?: TimelineWord[];
  /** Which lanes each source has a mic for. */
  sourceLanes: Record<string, string[]>;
  audible: Map<string, [number, number][]>;
  /** The record playhead, in frames (in seconds without `fps`): actions read it as they run, and the caret follows it a word at a time. */
  frames: FrameStore; seek: (seconds: number) => void; commit: Commit;
  nameOf: (lane: string) => string; tc: (seconds: number) => string;
  /** Snap (N): a splice lands between words rather than inside one. */
  snap?: boolean;
  /** The edit's frame rate: a splice's source range and record point land on frames, as Avid's do. */
  fps?: number;
};

/**
 * The editor's working state and every action that changes the edit. Model
 * work is in seconds (edit-model.ts); each change goes to the undo log through
 * `commit`, which snaps it to frames. Marks, selection, solo and the dead-space
 * review are view state and never enter the history.
 */
/** Media Composer's audio track limit, which the saved document and the AAF writer share. */
const MAX_RECORD_TRACKS = 64;

export function useEditWorkspace({ open, words, everyone, lanes, sourceLanes, durations, audible, frames, seek, commit, nameOf, tc, snap = true, fps }: Options) {
  const seconds = (frame: number) => fps ? frame / fps : frame, playheadNow = () => seconds(frames.get());
  const edit = open.timeline, markers = open.markers;
  const [stored, setSelection] = useState<EditSelection>({ anchor: 0, focus: 0, collapsed: true });
  const [marks, setMarks] = useState<EditMarks>({ in: null, out: null });
  /** The record track selectors, as track numbers (1 for A1); null is every track. */
  const [tracks, setTracks] = useState<Set<number> | null>(null);
  /** Clips selected on the record tracks (Neo's and Avid's segment selection), and the trim rollers when in Trim. */
  const [picks, setPicks] = useState<ClipPick[]>([]);
  const [rollers, setRollers] = useState<Roller[]>([]);
  /** Single-side trims ripple (Avid's yellow rollers) unless this is off, when they overwrite (red). */
  const [rippleTrim, setRippleTrim] = useState(true);
  /** An Extract of selected clips that would take other tracks' clips too, waiting for a choice. */
  const [clipGuard, setClipGuard] = useState<number[] | null>(null);
  /** What ⌘C or ⌘X took, for ⌘V: kept for the session, as an NLE's clipboard is. */
  const [copied, setCopied] = useState<ClipCopy[]>([]);
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
  // Each phrase whole, so people talking over one another read as lines, not alternate words.
  const placed = useMemo(() => measure("String Outs", `Placing ${words.length.toLocaleString("en-US")} words on the record`, () => recordOrder(placeWords(words, edit))), [words, edit]);
  const paras = useMemo(() => measure("String Outs", `Laying out ${placed.length.toLocaleString("en-US")} record words as paragraphs`, () => paragraphs(placed)), [placed]);
  const seams = useMemo(() => seamList(edit, words), [edit, words]);
  const ghosts = useMemo(() => ghostLines(edit, words, placed), [edit, words, placed]);
  const total = programDuration(edit), starts = segmentStarts(edit), count = placed.length;
  // One record position, as in Avid: a caret is wherever the playhead is, so
  // Insert, Add Edit, markers and the text all mean the same place. A range
  // is the editor's own choice and stays put while the playhead moves. The
  // caret is the first word ending after the playhead, by a binary search over
  // the running latest end (words on two tracks can overlap). Nothing here
  // subscribes to the playhead, or the whole editor would redraw at every
  // word: `caret` is as of this render, actions use `caretNow()`, and what
  // draws the caret while playing follows `caretAt(frame)` itself.
  const ends = useMemo(() => runningEnds(placed), [placed]);
  const caretAt = (frame: number) => firstAbove(ends, seconds(frame) + 1e-6), caretNow = () => (stored.collapsed ? caretAt(frames.get()) : Math.min(stored.anchor, count));
  const parked = caretAt(frames.get());
  const selection: EditSelection = stored.collapsed ? { anchor: parked, focus: parked, collapsed: true, after: !!stored.after && stored.anchor === parked } : stored;
  // Record tracks are layers (A1, A2…), not people: a clip says who sits on
  // which; one that does not (a string out from before layers) puts each person
  // on the track they were patched to.
  const layering = useMemo<Layering>(() => ({ carries: (source) => sourceLanes[source] ?? [], home: (lane) => lanes.find((item) => item.id === lane)?.track || undefined }),
    [sourceLanes, lanes]);
  const layerTotal = useMemo(() => layerCount(edit, layering), [edit, layering]);
  const isOn = (layer: number) => !tracks || tracks.has(layer);
  const onTracks = useMemo(() => new Set(Array.from({ length: layerTotal }, (_, index) => index + 1).filter((layer) => !tracks || tracks.has(layer))), [layerTotal, tracks]);
  const trimContext: TrimContext = { layering, durationOf: (source) => durations[source] ?? Infinity, fps: fps ?? 24, nameOf };
  const range: [number, number] | null = selection.collapsed || !count ? null
    : [Math.min(selection.anchor, selection.focus, count - 1), Math.min(Math.max(selection.anchor, selection.focus), count - 1)];
  const caret = Math.min(selection.anchor, count);
  const selected = range ? placed.slice(range[0], range[1] + 1) : [];
  const keys = new Set(selected.map(placementKey));
  const marked = marks.in != null && marks.out != null && marks.out > marks.in ? [marks.in, marks.out] as const : null;
  const names = (ids: string[]) => { const list = [...new Set(ids)].map(nameOf); return list.length < 3 ? list.join(" and ") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`; };

  const applyDelete = (cut: Set<string>, removed: number, at = range ? range[0] : caretNow()) => {
    const result = deleteWords(words, edit, cut);
    void change(`Delete ${plural(removed, "Word")}`, (timeline) => deleteWords(words, timeline, cut).edit);
    setSelection({ anchor: at, focus: at, collapsed: true, after: at > 0 });
    setPrompt(null); setSeam(null);
    seek(at > 0 ? recordOrder(placeWords(words, result.edit))[at - 1]?.programEnd ?? 0 : 0);
    setMessage(`Deleted ${plural(removed, "word")}, ${result.seconds.toFixed(2)} s.`);
  };
  const lift = (ids: Set<string>, chosen: typeof selected) => {
    const restoring = chosen.every((item) => item.muted);
    // Words a Lift on their track took out (rather than a Silence) come back by
    // undoing that Lift where they are.
    const spans = new Map<string, [number, number]>();
    for (const item of chosen) {
      if (edit.segments[item.segment]?.overrides?.[item.word.track]?.source !== null) continue;
      const span = spans.get(item.word.track);
      spans.set(item.word.track, span ? [Math.min(span[0], item.programStart), Math.max(span[1], item.programEnd)] : [item.programStart, item.programEnd]);
    }
    // A lifted person whose track someone else now holds there cannot come back on it: two people would share A1.
    if (restoring) for (const [lane, [from, to]] of spans) {
      const [start, end] = liftedAround(edit, placed, lane, from, to), starts = segmentStarts(edit);
      const taken = edit.segments.map((segment, index) => starts[index] < end - 1e-6 && starts[index] + segmentLength(segment) > start + 1e-6
        && segment.overrides?.[lane]?.source === null ? trackTakenFrom(segment, lane, layering) : null).find(Boolean);
      if (taken) { setMessage(`${nameOf(taken.lane)} is on A${taken.layer} there now, where ${nameOf(lane)} was. Move one of them to another track first.`); return; }
    }
    const unlift = (timeline: Timeline) => [...spans].reduce((next, [lane, [from, to]]) =>
      unliftOnTrack(next, ...liftedAround(edit, placed, lane, from, to), lane, layering), unmuteWords(words, timeline, ids));
    void change(`${restoring ? "Unmute" : "Mute"} ${names(chosen.map((item) => item.word.track))}`,
      (timeline) => restoring ? unlift(timeline) : muteWords(words, timeline, ids));
    setMessage(`${restoring ? "Unmuted" : "Muted"} ${plural(ids.size, "word")}.`);
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
   * Splice (or overwrite) source material in, as Avid's V and B do. Which
   * marks decide the length, the landing and the source range is Avid's
   * three-point rule (edit-three-point.ts): record In and Out win, else the
   * source gives the length and it lands at the record In, ends at the record
   * Out, or goes at the record playhead; with Snap on, that playhead moves to
   * the nearest gap between words so a splice never lands mid-word. Append
   * goes at the end. The playhead then parks after the new clip, so pressing V
   * again builds the cut in order, and the record marks clear. Selected words
   * mark the source In to Out with the air around them. With `take`, the
   * source side decides the rest, as Avid's source monitor and track
   * selectors do: the clip plays exactly the lanes whose mics are on, each
   * patched to the next record track down if it has none yet. Without it, the
   * clip plays the people whose words were selected.
   */
  const place = (how: "insert" | "append" | "overwrite", source: string, sourceWords: TimelineWord[], take?: SourceMarks) => {
    if (!sourceWords.length && !take) return;
    // Their own neighbouring words bound the air kept around the cut.
    const speakers = new Set(sourceWords.map((word) => word.track));
    const bounds = words.concat((everyone ?? []).filter((word) => speakers.has(word.track)));
    // On frames before anything is computed: the saved edit is whole frames, and
    // rounding afterwards could leave an Overwrite a frame longer or shorter.
    const frame = (seconds: number) => fps ? Math.round(seconds * fps) / fps : seconds;
    const extent = durations[source] ?? Infinity;
    // Selected words mark the source In to Out, with the air around them.
    const chosen = sourceWords.length ? cutRange(bounds, sourceWords, { source, srcIn: 0, srcOut: extent }) : null;
    // The record playhead, moved to the nearest gap between words with Snap on so a splice never lands mid-word. Marks are where they were put.
    const parked = Math.max(0, Math.min(total, playheadNow()));
    const resolved = resolveThreePoint({
      source: { in: chosen ? chosen[0] : take!.in, out: chosen ? chosen[1] : take!.out, playhead: take?.playhead ?? 0, start: 0, end: extent },
      // Append is Insert at the end, whatever the record has marked.
      record: how === "append" ? { in: null, out: null, playhead: total } : { in: marks.in, out: marks.out, playhead: snap ? snapToGap(edit, placed, parked) : parked },
    });
    if ("refusal" in resolved) { setMessage(resolved.refusal); return; }
    if (!Number.isFinite(resolved.edit.srcOut)) { setMessage("This source is still loading, so its end is not known yet. Mark a source Out, or try again in a moment."); return; }
    const [srcIn, srcOut] = [resolved.edit.srcIn, resolved.edit.srcOut].map(frame);
    // Each source track lands on the record track it is patched to, as in
    // Avid; one that is not patched goes top-down from A1. A record track that
    // does not exist yet is made (Avid's Auto-create New Tracks).
    const brought = take ? take.lanes : [...speakers];
    const all: Placement[] = brought.map((lane, index) => ({ lane, layer: take?.patch?.[lane] ?? index + 1 }));
    const twice = all.find((item, index) => all.findIndex((other) => other.layer === item.layer) !== index);
    if (twice) { setMessage(`${names(all.filter((item) => item.layer === twice.layer).map((item) => item.lane))} are both patched to A${twice.layer}. Patch one of them to another track.`); return; }
    // Media Composer takes 64 audio tracks; past that the save would fail later with no way back.
    const beyond = all.filter((item) => item.layer > MAX_RECORD_TRACKS);
    if (beyond.length) { setMessage(`Media Composer takes ${MAX_RECORD_TRACKS} audio tracks, and ${names(beyond.map((item) => item.lane))} ${beyond.length === 1 ? "is" : "are"} patched past A${MAX_RECORD_TRACKS}. Patch fewer people, or patch them to lower tracks.`); return; }
    // Avid's rule: material lands only on record tracks that are on.
    const placements = all.filter((item) => isOn(item.layer));
    if (!placements.length) { setMessage("Nothing went in: every record track it would go to is turned off. Turn one on, or patch the source to another track."); return; }
    const lanes = placements.map((item) => item.lane);
    const position = how === "append" ? total : frame(Math.min(total, resolved.edit.at));
    // An Overwrite cannot put someone on a second track where they already play: the model holds a person on one track at a time.
    const twiceOver = how === "overwrite" ? doubledLane(edit, position, srcOut - srcIn, placements, layering) : null;
    if (twiceOver) { setMessage(`${nameOf(twiceOver.lane)} already plays on A${twiceOver.layer} there. Patch ${nameOf(twiceOver.lane)} to A${twiceOver.layer}, or overwrite somewhere else.`); return; }
    const label = how === "overwrite" ? "Overwrite" : sourceWords.length ? `Insert ${plural(sourceWords.length, "Word")}` : "Insert Clip";
    void commit(label, (state) => {
      const timeline = how === "overwrite" ? overwrite(state.timeline, source, srcIn, srcOut, position, placements, layering)
        : spliceIn(state.timeline, source, srcIn, srcOut, position, placements);
      // Everyone placed is heard from now on: their words, mics and waveforms load.
      return { timeline, markers: rippleMarkers(state.timeline, timeline, state.markers), document: giveTracks(state.document, lanes) };
    });
    setMarks({ in: null, out: null });
    seek(position + srcOut - srcIn);
    const what = sourceWords.length ? plural(sourceWords.length, "word") : `${(srcOut - srcIn).toFixed(1)} s`;
    const where = [...new Set(placements.map((item) => item.layer))].sort((a, b) => a - b).map((layer) => `A${layer}`);
    setMessage(`${how === "overwrite" ? "Overwrote" : "Inserted"} ${what} at ${tc(position)} on ${where.length < 3 ? where.join(" and ") : `${where.slice(0, -1).join(", ")} and ${where[where.length - 1]}`}.`);
  };
  const insert = (source: string, sourceWords: TimelineWord[], atEnd: boolean, take?: SourceMarks) =>
    place(atEnd ? "append" : "insert", source, sourceWords, take);
  const move = (index: number, direction: -1 | 1) => {
    const paragraph = paras[index];
    if (!paragraph || !paras[index + direction]) return;
    const next = moveParagraph(words, edit, paragraph, direction < 0 ? paras[index - 1] : paras[index + 2] ?? null);
    if (next === edit) return;
    const target = direction < 0 ? paras[index - 1] : paras[index + 2] ?? null;
    void change("Move Paragraph", (timeline) => moveParagraph(words, timeline, paragraph, target), `move:${paragraph.words[0].word.id}`);
    const first = recordOrder(placeWords(words, next)).findIndex((item) => item.word.id === paragraph.words[0].word.id);
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
    void change("Restore Cut", (timeline) => healSeam(timeline, seam, true));
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
    const every = !tracks || onTracks.size === layerTotal;
    if (close && !force && !every) {
      // Words on a record track that is not selected, which the Extract would take too.
      const caught = placed.filter((item) => !item.muted && item.programStart < to && item.programEnd > from
        && !isOn(layerOf(edit.segments[item.segment], item.word.track, layering) ?? 0));
      if (caught.length) return setExtractGuard({ who: caught.map((item) => item.word.track), count: caught.length });
    }
    setExtractGuard(null);
    const chosen = [...onTracks];
    void change(close ? "Extract" : "Lift", (timeline) => close ? extractProgram(timeline, from, to).edit
      : every ? liftProgram(timeline, from, to) : liftLayers(timeline, from, to, chosen, layering));
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
  const addMarker = () => { const playhead = playheadNow(); void commit("Add Marker", (state) => state.markers.some((m) => Math.abs(m.at - playhead) < 1e-3) ? null
    : { markers: [...state.markers, { id: `m-${Date.now().toString(36)}`, at: playhead, track: null, name: "Marker", comment: "", color: "red" }].sort((a, b) => a.at - b.at) }); };
  const updateMarker = (id: string, change: Partial<Pick<TimelineMarker, "name" | "comment" | "color">>, group?: string) =>
    void commit("Edit Marker", (state) => ({ markers: state.markers.map((item) => item.id === id ? { ...item, ...change } : item) }), group ?? `marker:${id}`);
  const removeMarker = (id: string) => { setMarker(null); void commit("Delete Marker", (state) => ({ markers: state.markers.filter((item) => item.id !== id) })); };
  /**
   * Add Edit (⌘B), as Neo's: a cut at the playhead on the selected clips that
   * cross it, else on the selected record tracks (every track when none is
   * chosen). It used to split the edit on every track at once, which a record
   * of layers then drew as no cut at all.
   */
  const cutAt = (at: number, layers: number[]) => {
    if (addCut(edit, at, layers, layering)) { void change("Add Edit", (timeline) => addCut(timeline, at, layers, layering)); return; }
    const crossing = layers.some((layer) => layerClips(edit, layer, layering).some((clip) => clip.from < at - 1e-6 && clip.to > at + 1e-6));
    setMessage(crossing ? "There is already an edit there." : "There is no clip under the playhead on the selected tracks.");
  };
  const cutHere = () => {
    const at = playheadNow();
    const selected = livePicks.filter((pick) => { const clip = pickedClip(edit, pick, layering); return clip && clip.from < at - 1e-6 && clip.to > at + 1e-6; });
    cutAt(at, selected.length ? selected.map((pick) => pick.layer) : [...onTracks]);
  };
  /** The blade, as Neo's: the clicked clip's track, and the record tracks chosen by hand, cut at that frame. */
  const blade = (at: number, layer: number) => cutAt(at, [...new Set([layer, ...(tracks ? [...tracks] : [])])]);
  const setTimeline = (label: string, next: Timeline) => void change(label, () => next);

  // --- Selection and trim on the record tracks (Neo's tools, Avid's rules) ---
  const tell = (result: { refusal: string } | { limited: string | null; frames: number }, done: string) =>
    setMessage("refusal" in result ? result.refusal : result.limited ? `${done} Stopped at ${result.limited}.` : done);
  const frameWord = (count: number) => `${Math.abs(count)} frame${Math.abs(count) === 1 ? "" : "s"}`;
  /** U: enter Trim at the cut nearest the playhead on the selected tracks, or leave it. */
  const enterTrim = () => {
    if (rollers.length) { setRollers([]); setMessage("Left Trim."); return; }
    const seated = nearestCut(edit, [...onTracks], playheadNow(), layering);
    if (!seated.length) { setMessage("There is no edit on the selected tracks."); return; }
    setPicks([]); setRollers(seated); seek(seated[0].at);
  };
  /** Trim the rollers by frames; false when there are none, so the key can mean something else. */
  const trimBy = (count: number) => {
    if (!rollers.length) return false;
    const dry = trim(edit, rollers, count, rippleTrim, trimContext, layerTotal);
    if ("refusal" in dry) { setMessage(dry.refusal); return true; }
    const kind = rollers[0].side === "both" ? "Roll" : rippleTrim ? "Ripple Trim" : "Overwrite Trim";
    void change(kind, (timeline) => { const result = trim(timeline, rollers, count, rippleTrim, trimContext, layerTotal); return "refusal" in result ? null : result.edit; }, "trim");
    setRollers(dry.rollers);
    seek(dry.rollers[0].at);
    tell(dry, `${kind} ${dry.frames > 0 ? "+" : "−"}${frameWord(dry.frames)}.`);
    return true;
  };
  /** Nudge (or, with `copy`, duplicate) the selected clips by frames and tracks, overwriting where they land; false with none selected. */
  const shiftClips = (count: number, trackDelta: number, copy = false) => {
    if (!picks.length) return false;
    const dry = moveClips(edit, picks, count, trackDelta, trimContext, copy);
    if ("refusal" in dry) { setMessage(dry.refusal); return true; }
    const label = copy ? picks.length === 1 ? "Copy Clip" : "Copy Clips" : trackDelta ? "Move Clip to Track" : "Nudge Clip";
    void change(label, (timeline) => { const result = moveClips(timeline, picks, count, trackDelta, trimContext, copy); return "refusal" in result ? null : result.edit; }, copy ? undefined : "nudge");
    setPicks(dry.picks);
    const where = [...new Set(dry.picks.map((pick) => `A${pick.layer}`))].join(", ");
    setMessage(copy ? `Copied to ${where}.` : trackDelta ? `Moved to ${where}.` : `Nudged ${count > 0 ? "+" : "−"}${frameWord(count)}.`);
    return true;
  };
  /** Delete lifts the selected clips; ⇧Delete extracts their time from every track, asking first when that takes other tracks' clips. */
  const deleteClips = (extract: boolean, force = false) => {
    if (!picks.length) return false;
    if (!extract) {
      void change(picks.length === 1 ? "Lift Clip" : "Lift Clips", (timeline) => liftClips(timeline, picks, layering));
      setPicks([]); setMessage(`Lifted ${picks.length === 1 ? "the clip" : `${picks.length} clips`}.`);
      return true;
    }
    const dry = extractClips(edit, picks, trimContext, layerTotal);
    if (dry.caught.length && !force) { setClipGuard(dry.caught); return true; }
    setClipGuard(null);
    void change(picks.length === 1 ? "Extract Clip" : "Extract Clips", (timeline) => extractClips(timeline, picks, trimContext, layerTotal).edit);
    setPicks([]); setMessage(`Extracted ${picks.length === 1 ? "the clip" : `${picks.length} clips`}.`);
    return true;
  };
  const slipBy = (count: number) => {
    if (picks.length !== 1) { if (picks.length) setMessage("Select one clip to slip."); return picks.length > 0; }
    const dry = slip(edit, picks[0], count, trimContext);
    if ("refusal" in dry) { setMessage(dry.refusal); return true; }
    void change("Slip", (timeline) => { const result = slip(timeline, picks[0], count, trimContext); return "refusal" in result ? null : result.edit; }, "slip");
    tell(dry, `Slipped ${count > 0 ? "+" : "−"}${frameWord(dry.frames)}.`);
    return true;
  };
  const slideBy = (count: number) => {
    if (picks.length !== 1) { if (picks.length) setMessage("Select one clip to slide."); return picks.length > 0; }
    const dry = slide(edit, picks[0], count, trimContext);
    if ("refusal" in dry) { setMessage(dry.refusal); return true; }
    void change("Slide", (timeline) => { const result = slide(timeline, picks[0], count, trimContext); return "refusal" in result ? null : result.edit; }, "slide");
    setPicks([dry.pick]);
    tell(dry, `Slid ${count > 0 ? "+" : "−"}${frameWord(dry.frames)}.`);
    return true;
  };
  /** Click a clip: select it, or with ⇧/⌘ add or take it away. Clicking a clip leaves Trim. */
  const pickClip = (pick: ClipPick | null, add: boolean) => {
    setRollers([]);
    if (!pick) { setPicks([]); return; }
    setPicks((current) => {
      const has = current.some((item) => item.layer === pick.layer && Math.abs(item.from - pick.from) < 1e-6);
      if (!add) return [pick];
      return has ? current.filter((item) => !(item.layer === pick.layer && Math.abs(item.from - pick.from) < 1e-6)) : [...current, pick];
    });
  };
  /** Click on an edit: seat a roller there (Trim), or with ⇧ add or take it away. */
  const pickRoller = (roller: Roller, add: boolean) => {
    setPicks([]);
    setRollers((current) => {
      const index = current.findIndex((item) => item.layer === roller.layer && Math.abs(item.at - roller.at) < 1e-6);
      if (!add) return [roller];
      if (index >= 0) return current[index].side === roller.side ? current.filter((_, at) => at !== index) : current.map((item, at) => at === index ? roller : item);
      return [...current, roller];
    });
    seek(roller.at);
  };
  /**
   * Match Frame: the clip the record playhead means, and the source frame
   * under it. A selected clip crossing the playhead wins; else the clip there
   * on the lowest selected track that has one, else on any track (Neo's rule,
   * and Avid's topmost-selected-track one). Null, and says so, with none.
   */
  const matchTarget = (): { source: string; lane: string; at: number; layer: number } | null => {
    const at = playheadNow(), crosses = (clip: { from: number; to: number }) => clip.from <= at + 1e-9 && at < clip.to - 1e-9;
    const picked = livePicks.map((pick) => ({ pick, clip: pickedClip(edit, pick, layering) })).find((item) => item.clip && crosses(item.clip));
    const lowest = (layers: number[]) => layers.sort((a, b) => a - b).flatMap((layer) => {
      const clip = layerClips(edit, layer, layering).find(crosses);
      return clip ? [{ layer, clip }] : [];
    })[0];
    const hit = picked?.clip ? { layer: picked.pick.layer, clip: picked.clip } : lowest([...onTracks]) ?? lowest(Array.from({ length: layerTotal }, (_, index) => index + 1));
    if (!hit) { setMessage("There is no clip under the playhead to match."); return null; }
    return { source: hit.clip.source, lane: hit.clip.lane, at: hit.clip.srcIn + at - hit.clip.from, layer: hit.layer };
  };
  /** ⌘C, or ⌘X (which lifts them too): the selected clips, held for ⌘V. False with none selected, so the key can copy text instead. */
  const copySelected = (cut: boolean) => {
    if (!livePicks.length) return false;
    const held = copyClips(edit, livePicks, layering);
    setCopied(held);
    if (cut) { void change(held.length === 1 ? "Cut Clip" : "Cut Clips", (timeline) => liftClips(timeline, livePicks, layering)); setPicks([]); }
    setMessage(`${cut ? "Cut" : "Copied"} ${held.length === 1 ? "the clip" : `${held.length} clips`}. ⌘V lays ${held.length === 1 ? "it" : "them"} over the playhead.`);
    return true;
  };
  /** ⌘V: the copied clips over the record at the playhead, on their own tracks. False with nothing copied. */
  const paste = () => {
    if (!copied.length) return false;
    const at = playheadNow(), dry = pasteClips(edit, copied, at, trimContext);
    if ("refusal" in dry) { setMessage(dry.refusal); return true; }
    void change(copied.length === 1 ? "Paste Clip" : "Paste Clips", (timeline) => { const result = pasteClips(timeline, copied, at, trimContext); return "refusal" in result ? null : result.edit; });
    setRollers([]); setPicks(dry.picks);
    setMessage(`Pasted ${copied.length === 1 ? "the clip" : `${copied.length} clips`} at ${tc(at)}.`);
    return true;
  };
  /** ⌘A on the record tracks: every clip on the selected tracks. */
  const selectAllClips = () => {
    const all = [...onTracks].flatMap((layer) => layerClips(edit, layer, layering).map((clip) => ({ layer, from: clip.from })));
    setRollers([]); setPicks(all);
    setMessage(all.length ? `Selected ${all.length} clip${all.length === 1 ? "" : "s"}.` : "There are no clips on the selected tracks.");
  };
  // Picks that no longer name a clip (after an undo, say) drop away rather than act on nothing.
  const livePicks = picks.filter((pick) => pickedClip(edit, pick, layering));

  return {
    picks: livePicks, rollers, rippleTrim, clipGuard, setClipGuard, setPicks, setRollers, trimContext,
    enterTrim, trimBy, shiftClips, deleteClips, slipBy, slideBy, pickClip, pickRoller, selectAllClips, blade, matchTarget, copySelected, paste, copied: copied.length,
    toggleRipple: () => { setRippleTrim(!rippleTrim); setMessage(rippleTrim ? "One-sided trims overwrite now (red rollers)." : "One-sided trims ripple now (yellow rollers)."); },
    edit, markers, placed, paras, seams, ghosts, total, count, range, caret, caretAt, caretNow, frames, selected, keys, marks, marked, onTracks, layering, layerTotal, selection, dead, prompt, seam, message, extractGuard, setExtractGuard,
    setSelection, setMarks, setSeam, setMessage, setPrompt, setDead, names, marker: markers.find((item) => item.id === marker) ?? null, setMarker, updateMarker, removeMarker,
    toggleTrack: (layer: number, only: boolean) => setTracks((state) => only ? new Set([layer])
      : toggled(state ?? new Set(Array.from({ length: layerTotal }, (_, index) => index + 1)), layer)),
    skipDead: (index: number) => setDeadHeld((state) => state && { ...state, review: { ...state.review, skip: toggled(state.review.skip, index) } }),
    remove, applyDelete, restore, insert, overwrite: (source: string, sourceWords: TimelineWord[], take?: SourceMarks) => place("overwrite", source, sourceWords, take), move, chooseSeam, healCut, takeMarked, findDead, applyDead, addMarker, cutHere, setTimeline,
    markIn: () => { const playhead = playheadNow(); setMarks((m) => ({ in: playhead, out: m.out != null && m.out > playhead ? m.out : null })); },
    markOut: () => { const playhead = playheadNow(); setMarks((m) => ({ in: m.in != null && m.in < playhead ? m.in : null, out: playhead })); },
    // Mark Clip, as Avid's: the selected clips when there are any (a segment
    // selection wins), else the clip under the playhead on the lowest selected
    // track that has one there, else the segment under it.
    markClip: () => {
      const chosen = livePicks.flatMap((pick) => { const clip = pickedClip(edit, pick, layering); return clip ? [clip] : []; });
      if (chosen.length) return setMarks({ in: Math.min(...chosen.map((clip) => clip.from)), out: Math.max(...chosen.map((clip) => clip.to)) });
      const at = playheadNow();
      for (const layer of [...onTracks].sort((a, b) => a - b)) {
        const clip = layerClips(edit, layer, layering).find((item) => item.from <= at + 1e-9 && at < item.to - 1e-9);
        if (clip) return setMarks({ in: clip.from, out: clip.to });
      }
      const clip = clipAround(edit, at);
      if (clip) setMarks({ in: clip[0], out: clip[1] });
    },
  };
}

