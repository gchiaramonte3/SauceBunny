import { useEffect, useMemo, useRef, useState } from "react";
import { secondsToTc } from "../src/lib/timecode";
import { answer, type TeAgentContext, type TeLine } from "./transcript-editor-agent";
import { activate, closeTab, columnOf, defaultDock, isClosable, isSourceTab, moveTab, openTab, sourceTab, teColumnNames, teColumns, TE_PINNED, type TeColumn } from "./transcript-editor-dock";
import { teDurations, tePeaks, teScene, teSources, teSpeakers, teTc, teWholeScene, teWords } from "./transcript-editor-fixture";
import { clampTimeline, layoutPanes, tePaneLimits, teTimelineLimits, type TePane } from "./transcript-editor-layout";
import {
  addEdit, clipAround, cutRange, deleteWords, extractProgram, findDeadSpace, isGap, teDeadDefaults, liftOnTracks, liftProgram, removeDeadSpace, TE_GAP, ghostLines, healSeam, moveParagraph, muteWords, paragraphs, placeWords, placementKey, programDuration,
  programToSource, restoreRange, seamList, segmentStarts, spliceIn, unmuteWords, type TeDeleteResult, type TeEdit, type TeGhost,
} from "./transcript-editor-model";
import { TeAsk, type TeAskMessage } from "./TeAsk";
import { TeDocument, type TeSelection } from "./TeDocument";
import { TeHistory } from "./TeHistory";
import { TeInspector } from "./TeInspector";
import { createLog, current as headOf, jump, pin, record, redo, redoTarget, undo, type TeLog } from "./transcript-editor-history";
import type { TeSeamInfo } from "./TeParagraph";
import { TePrompt } from "./TePrompt";
import { TeRecord } from "./TeRecord";
import { TeSidebar, type TeLibraryGroup } from "./TeSidebar";
import { TeSource } from "./TeSource";
import { TeSplitter } from "./TeSplitter";
import { TeTabBar, type TeTab } from "./TeTabBar";
import type { TeTextStyle } from "./TeTextSettings";
import { teDeadPresets, type TeDeadPreset, type TeDeadReview } from "./TeDeadSpace";
import { TeTimeline } from "./TeTimeline";
import { TeToolbar } from "./TeToolbar";
import { TeTransport } from "./TeTransport";
import { useTePlayback } from "./use-te-playback";

/** Well-separated hues from the production SPEAKER_SOLIDS palette
 *  (src/components/transcript/helpers.tsx), which the catalog may not import. */
const colors: Record<string, string> = Object.fromEntries(teSpeakers.map((speaker, index) =>
  [speaker.id, ["#FD8A8C", "#EB9A04", "#0AF2CD", "#75B0FF", "#E887FE", "#ABF201", "#F886BB"][index]]));
const fps = teScene.fps;
const sourceOf = (id: string) => teSources.find((source) => source.id === id)!;
const shortName = (id: string) => id === TE_GAP ? "Gap" : sourceOf(id).short;
const sourceSpeakers = Object.fromEntries(teSources.map((source) => [source.id, source.speakers]));
const sourcePlaced = Object.fromEntries(teSources.map((source) => [source.id, placeWords(teWords, teWholeScene(source.id))]));
const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;
const tc = (seconds: number) => teTc(seconds, fps);
const nameOf = (id: string) => teSpeakers.find((speaker) => speaker.id === id)?.name ?? id;
const names = (ids: string[]) => { const list = [...new Set(ids)].map(nameOf); return list.length < 3 ? list.join(" and ") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`; };
const tabLabel = (tab: string) => isSourceTab(tab) ? sourceOf(tab.slice(7)).short : ({ library: "Library", edit: "Edit", inspector: "Inspector", ask: "Ask", history: "History" } as Record<string, string>)[tab] ?? tab;
const pane = (column: TeColumn) => column as TePane;

type Snapshot = { edit: TeEdit; corrections: Record<string, string>; markers: number[] };
type Drag = { tab: string; x: number; y: number; target: { column: TeColumn; index: number } | null };

/**
 * Transcript Editor, as a clickable prototype. Nothing here reads a file or
 * plays sound: the sources are generated, and the playheads run on a clock.
 * What IS real is the edit model, so every deletion, move, splice, restore and
 * undo does to the timeline exactly what it says.
 */
export function TranscriptEditorPrototype() {
  const root = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 1680, height: 1020 });
  const [log, setLog] = useState<TeLog<Snapshot>>(() => createLog<Snapshot>({ edit: teWholeScene(), corrections: {}, markers: [] }, Date.now()));
  const { edit, corrections, markers } = headOf(log);
  const [selection, setSelection] = useState<TeSelection>({ anchor: 0, focus: 0, collapsed: true });
  const [solo, setSolo] = useState<Set<string>>(new Set());
  const [mute, setMute] = useState<Set<string>>(new Set());
  const [dock, setDock] = useState(defaultDock);
  const [open, setOpen] = useState<Record<TePane, boolean>>({ left: true, source: true, right: true });
  const [sizes, setSizes] = useState<Record<TePane, number>>({ left: 220, source: 340, right: 290 });
  const [priority, setPriority] = useState<TePane[]>(["source", "right", "left"]);
  const [recordView, setRecordView] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [timelineWanted, setTimeline] = useState<number | null>(null);
  const [showRemoved, setShowRemoved] = useState(true);
  const [seam, setSeam] = useState<number | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [ranges, setRanges] = useState<Record<string, [number, number] | null>>({});
  const [focusSource, setFocusSource] = useState("mg3");
  const [match, setMatch] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<{ result: TeDeleteResult; lift: Set<string>; who: string[] } | null>(null);
  const [text, setText] = useState<Record<"source" | "edit", TeTextStyle>>({ source: { family: "sans", size: 13, leading: "normal" }, edit: { family: "sans", size: 15, leading: "normal" } });
  const [messages, setMessages] = useState<TeAskMessage[]>([]);
  const [message, setMessage] = useState("");
  const [marks, setMarks] = useState<{ in: number | null; out: number | null }>({ in: null, out: null });
  const [snap, setSnap] = useState(true);
  const [followHead, setFollowHead] = useState(true);
  const [looping, setLooping] = useState(false);
  const [zoom, setZoom] = useState(1);
  // Avid's track selectors: which tracks Lift, Mark Clip and dead-space
  // detection act on. Extract always ripples every track (sync locked).
  const [tracks, setTracks] = useState<Set<string>>(() => new Set(teSpeakers.map((speaker) => speaker.id)));
  const [dead, setDead] = useState<TeDeadReview | null>(null);

  const placed = useMemo(() => placeWords(teWords, edit), [edit]);
  const paras = useMemo(() => paragraphs(placed), [placed]);
  const seams = useMemo(() => seamList(edit, teWords), [edit]);
  const ghosts = useMemo(() => ghostLines(edit, teWords, teDurations), [edit]);
  const used = useMemo(() => new Set(placed.map((item) => item.word.id)), [placed]);
  const total = programDuration(edit);
  const marked = marks.in != null && marks.out != null && marks.out > marks.in ? [marks.in, marks.out] as const : null;
  const [loopFrom, loopTo] = marked ?? [0, total];
  const loop = useMemo(() => looping ? { target: "record", from: loopFrom, to: loopTo } : null, [looping, loopFrom, loopTo]);
  const playback = useTePlayback({ record: total, ...teDurations }, loop);
  const playhead = playback.head("record");
  const count = placed.length;
  const starts = segmentStarts(edit);
  const range: [number, number] | null = selection.collapsed || !count ? null
    : [Math.min(selection.anchor, selection.focus, count - 1), Math.min(Math.max(selection.anchor, selection.focus), count - 1)];
  const caret = Math.min(selection.anchor, count);
  const selected = range ? placed.slice(range[0], range[1] + 1) : [];
  const keys = new Set(selected.map(placementKey));
  const dryRun = selected.length ? deleteWords(teWords, edit, keys) : null;
  const current = placed.find((item) => item.programStart <= playhead && playhead < item.programEnd) ?? null;
  const currentKey = current ? placementKey(current) : null;
  const has = (column: TeColumn) => dock[column].tabs.length > 0;
  const layout = layoutPanes(box.width, { left: open.left && has("left"), source: open.source && has("source"), right: open.right && has("right") }, sizes, priority);
  const timelineHeight = clampTimeline(timelineWanted ?? Math.min(teTimelineLimits.ideal, Math.round(box.height * 0.3)), box.height);
  const seamInfo: Record<number, TeSeamInfo> = Object.fromEntries(seams.map((item) => [item.index, { kind: item.kind, seconds: item.kind === "cut" ? item.gap : null }]));
  const talk: Record<string, number> = {};
  for (const item of placed) if (!item.muted) talk[item.word.speaker] = (talk[item.word.speaker] ?? 0) + item.programEnd - item.programStart;
  const context: TeAgentContext = { words: teWords, placed, speakers: teSpeakers, sources: teSources };

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setBox({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const follow = playback.playing === "record" || playback.scrubbing;
  useEffect(() => {
    if (follow && currentKey) root.current?.querySelector(".cp-te-doc .cp-te-word.is-current")?.scrollIntoView({ block: "nearest" });
  }, [currentKey, follow]);

  const focusDoc = () => requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(".cp-te-doc")?.focus());
  const seek = (position: number) => playback.seek("record", position);
  // Every change is a step in the log; `group` lets rapid repeats of one
  // action (a paragraph nudged five times) land as one step.
  const commit = (label: string, change: (present: Snapshot) => Partial<Snapshot> | null, group: string | null = null) => {
    const at = Date.now();
    setLog((state) => {
      const present = headOf(state), next = change(present);
      return next ? record(state, label, { ...present, ...next }, at, group) : state;
    });
  };
  const undoLabel = log.states[log.head].parent == null ? null : log.states[log.head].label;
  const redoId = redoTarget(log), redoLabel = redoId == null ? null : log.states[redoId].label;
  const moveHead = (next: TeLog<Snapshot>, text: string) => {
    if (next === log) return;
    setLog(next);
    setSeam(null); setPrompt(null);
    setMessage(text);
  };
  const step = (back: boolean) => back ? moveHead(undo(log), `Undo ${undoLabel}`) : moveHead(redo(log), `Redo ${redoLabel}`);
  const applyDelete = (result: TeDeleteResult, words: number) => {
    const at = range ? range[0] : caret;
    commit(`Delete ${plural(words, "Word")}`, () => ({ edit: result.edit }));
    // The caret stays at the end of the line you were on, and so does the
    // playhead: nothing jumps into the next line until you go there.
    setSelection({ anchor: at, focus: at, collapsed: true, after: at > 0 });
    setPrompt(null); setSeam(null);
    seek(at > 0 ? placeWords(teWords, result.edit)[at - 1]?.programEnd ?? 0 : 0);
    setMessage(`Deleted ${plural(words, "word")}, ${result.seconds.toFixed(2)} s.`);
    focusDoc();
  };
  const lift = (ids: Set<string>, who: string[], focus = true) => {
    const restoring = selected.every((item) => item.muted);
    commit(restoring ? "Restore on Track" : `Remove from ${names(who)}'s Track`, (present) =>
      ({ edit: restoring ? unmuteWords(teWords, present.edit, ids) : muteWords(teWords, present.edit, ids) }));
    setPrompt(null);
    setMessage(`${restoring ? "Unsilenced" : "Silenced"} ${plural(ids.size, "word")}.`);
    if (focus) focusDoc();
  };
  const remove = (speakerOnly: boolean) => {
    if (!dryRun || !selected.length) return;
    const ids = new Set(selected.map((item) => item.word.id));
    const who = selected.map((item) => item.word.speaker);
    if (speakerOnly) return lift(ids, who);
    // Overtalk: rippling would take the other speaker's words down with the
    // cut. So the deleted words are filled with silence on their own track
    // only, nothing moves, and closing the time up for everyone is a choice.
    if (dryRun.crosstalk.length) { lift(ids, who, false); return setPrompt({ result: dryRun, lift: ids, who }); }
    applyDelete(dryRun, selected.length);
  };
  const restore = (ghost: TeGhost) => {
    commit("Restore Line", (present) => ({ edit: restoreRange(present.edit, ghost.at, ghost.source, ghost.from, ghost.to) }));
    setMessage(`Restored ${nameOf(ghost.speaker)}'s line.`);
  };
  const insertionPoint = (index: number) => {
    if (index >= count) return total;
    if (index <= 0) return 0;
    const [before, after] = [placed[index - 1], placed[index]];
    return before.segment !== after.segment ? starts[after.segment] : (before.programEnd + after.programStart) / 2;
  };
  const splice = (lines: { source: string; words: typeof teWords }[], at: number | null, label: string) => {
    let next = edit, position = at ?? total;
    for (const line of lines) {
      const whole = teWholeScene(line.source).segments[0];
      const [srcIn, srcOut] = cutRange(teWords, line.words, whole);
      next = spliceIn(next, line.source, srcIn, srcOut, position);
      position += srcOut - srcIn;
    }
    commit(label, () => ({ edit: next }));
    return next;
  };
  const insert = (atEnd: boolean) => {
    const chosenRange = ranges[focusSource];
    if (!chosenRange) return;
    const words = sourcePlaced[focusSource].slice(chosenRange[0], chosenRange[1] + 1).map((item) => item.word);
    const position = atEnd ? total : insertionPoint(range ? range[0] : caret);
    const next = splice([{ source: focusSource, words }], position, `Insert ${plural(words.length, "Word")}`);
    const fresh = new Set(next.segments.filter((segment) => !edit.segments.some((old) => old.id === segment.id)).map((segment) => next.segments.indexOf(segment)));
    const indexes = placeWords(teWords, next).flatMap((item, index) => fresh.has(item.segment) && words.includes(item.word) ? [index] : []);
    if (indexes.length) setSelection({ anchor: indexes[0], focus: indexes[indexes.length - 1], collapsed: false });
    setMessage(`Inserted ${plural(words.length, "word")} at ${tc(position)}.`);
    focusDoc();
  };
  const showPanel = (tab: string, fallback: TeColumn) => {
    const next = openTab(dock, tab, fallback);
    setDock(next);
    const column = columnOf(next, tab)!;
    if (column !== "record") { setOpen((state) => ({ ...state, [column]: true })); setPriority((order) => [pane(column), ...order.filter((item) => item !== column)]); }
    if (layout.folded.includes(pane(column))) setRecordView(tab);
  };
  const showInSource = (source: string, words: typeof teWords) => {
    const indexes = words.map((word) => sourcePlaced[source].findIndex((item) => item.word.id === word.id)).filter((index) => index >= 0);
    if (!indexes.length) return;
    showPanel(sourceTab(source), "source");
    setFocusSource(source);
    setRanges((state) => ({ ...state, [source]: [Math.min(...indexes), Math.max(...indexes)] }));
    setMatch(words[0].id);
    playback.seek(source, words[0].start);
  };
  const findInSource = () => {
    const targets = selected.length ? selected : placed[caret] ? [placed[caret]] : [];
    if (!targets.length) return;
    const source = targets[0].word.source;
    showInSource(source, targets.filter((item) => item.word.source === source).map((item) => item.word));
    setMessage(`Found in ${sourceOf(source).short} at ${teTc(targets[0].word.start, fps, sourceOf(source).startTc)}.`);
  };
  const findInEdit = () => {
    const chosenRange = ranges[focusSource];
    if (!chosenRange) return;
    const word = sourcePlaced[focusSource][chosenRange[0]].word;
    const index = placed.findIndex((item) => item.word.id === word.id);
    if (index < 0) return setMessage(`Not in the edit. V inserts it.`);
    setSelection({ anchor: index, focus: index, collapsed: true });
    seek(placed[index].programStart);
    setMessage(`Found in the edit at ${tc(placed[index].programStart)}.`);
    focusDoc();
  };
  const toggle = (column: TePane) => {
    if (layout.shown[column]) return setOpen((state) => ({ ...state, [column]: false }));
    if (!has(column as TeColumn)) return setMessage(`The ${column} panel is empty.`);
    setOpen((state) => ({ ...state, [column]: true }));
    setPriority((order) => [column, ...order.filter((item) => item !== column)]);
  };
  const chooseSeam = (index: number) => {
    setSeam(index);
    seek(starts[index] ?? 0);
    const info = seams.find((item) => item.index === index);
    if (info) setMessage(info.kind === "cut" ? `Cut at ${tc(info.at)}, ${info.gap.toFixed(2)} s removed.` : `Edit point at ${tc(info.at)}.`);
  };
  // Timeline tools. Marks and toggles are view state; cuts and markers are
  // edits, so they go through history and ⌘Z.
  const cutHere = () => {
    const next = addEdit(edit, playhead);
    if (next === edit) return;
    commit("Add Edit", () => ({ edit: next }));
  };
  const markIn = () => setMarks((m) => ({ in: playhead, out: m.out != null && m.out > playhead ? m.out : null }));
  const markOut = () => setMarks((m) => ({ in: m.in != null && m.in < playhead ? m.in : null, out: playhead }));
  const takeMarked = (close: boolean) => {
    if (!marked) return;
    const [from, to] = marked;
    const every = teSpeakers.every((speaker) => tracks.has(speaker.id));
    commit(close ? "Extract" : "Lift", (present) => close
      ? { edit: extractProgram(present.edit, from, to).edit, markers: present.markers.filter((t) => t <= from || t >= to).map((t) => t >= to ? t - (to - from) : t) }
      : { edit: every ? liftProgram(present.edit, from, to) : liftOnTracks(present.edit, from, to, (source) => (sourceSpeakers[source] ?? []).filter((id) => tracks.has(id))) });
    setMarks({ in: null, out: null });
    seek(from);
    setMessage(`${close ? "Extracted" : "Lifted"} ${(to - from).toFixed(2)} s.`);
  };
  const markClip = () => { const clip = clipAround(edit, playhead); if (clip) setMarks({ in: clip[0], out: clip[1] }); };
  // Dead space: quiet on EVERY mic and nothing in the transcript. Every
  // track, not just the selected ones: removing it ripples all of them.
  const loudest = (source: string, from: number, to: number) => Math.max(0, ...(sourceSpeakers[source] ?? [])
    .map((id) => Math.max(...tePeaks(source, id, from, to, 4).map(([, high]) => high))));
  const findDead = (preset: TeDeadPreset = dead?.preset ?? "air") => {
    const spaces = findDeadSpace(edit, teWords, loudest, { ...teDeadDefaults, minimum: teDeadPresets[preset].minimum });
    setDead({ spaces, skip: new Set(), preset });
  };
  const applyDead = () => {
    if (!dead) return;
    const chosen = dead.spaces.filter((_, index) => !dead.skip.has(index));
    const result = removeDeadSpace(edit, chosen, teDeadPresets[dead.preset].keep);
    if (result.seconds > 0) commit("Remove Dead Space", () => ({ edit: result.edit, markers: [] }));
    setDead(null);
    setMessage(`Removed ${result.seconds.toFixed(1)} s.`);
  };
  const newEdit = (empty: boolean) => {
    commit(empty ? "New Empty Edit" : "New Edit", () => ({ edit: empty ? { segments: [], mutes: [] } : teWholeScene(), markers: [] }));
    setSelection({ anchor: 0, focus: 0, collapsed: true }); setMarks({ in: null, out: null }); seek(0); setMessage("");
  };
  const addMarker = () => commit("Add Marker", (present) => present.markers.some((t) => Math.abs(t - playhead) < 1 / fps) ? null
    : { markers: [...present.markers, playhead].sort((a, b) => a - b) });
  const previousEdit = [...seams].reverse().find((item) => item.at < playhead - 1e-3) ?? null;
  const nextEdit = seams.find((item) => item.at > playhead + 1e-3) ?? null;
  const zoomBy = (direction: -1 | 0 | 1) => setZoom((z) => direction === 0 ? 1 : Math.max(1, Math.min(32, direction > 0 ? z * 2 : z / 2)));
  const openAsk = () => {
    showPanel("ask", "right");
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(".cp-te-ask-input")?.focus());
  };
  const moveTo = (tab: string, to: TeColumn, index?: number) => {
    setDock((state) => moveTab(state, tab, to, index));
    if (to !== "record") { setOpen((state) => ({ ...state, [to]: true })); setPriority((order) => [pane(to), ...order.filter((item) => item !== to)]); }
    setRecordView(null);
    setMessage(`Moved ${tabLabel(tab)} to the ${to === "record" ? "edit" : to} panel.`);
  };
  const dropTarget = (x: number, y: number, tab: string): Drag["target"] => {
    const hit = document.elementsFromPoint(x, y).find((element) => (element as HTMLElement).dataset?.dockColumn) as HTMLElement | undefined;
    if (!hit) return null;
    const column = hit.dataset.dockColumn as TeColumn;
    if (tab === TE_PINNED && column !== "record") return null;
    const own = Array.from(hit.querySelectorAll<HTMLElement>("[data-dock-tab]")).filter((element) => dock[column].tabs.includes(element.dataset.dockTab!));
    const onStrip = !!(document.elementsFromPoint(x, y).find((element) => (element as HTMLElement).dataset?.dockStrip));
    const index = onStrip ? own.filter((element) => { const rect = element.getBoundingClientRect(); return rect.left + rect.width / 2 < x; }).length : dock[column].tabs.length;
    return { column, index };
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target !== document.body && !root.current?.contains(target)) return;
    if (target.closest("input, textarea, select, [role=alertdialog], [role=dialog]")) return;
    const key = event.key.toLowerCase();
    const inSource = target.closest<HTMLElement>("[data-source-id]")?.dataset.sourceId;
    if (event.key === " " && !target.closest("button, [role=separator], [role=tab]")) { event.preventDefault(); return playback.toggle(inSource ?? "record"); }
    if (event.metaKey && !event.ctrlKey && key === "z") { event.preventDefault(); return step(!event.shiftKey); }
    if (event.metaKey && !event.ctrlKey && key === "k") { event.preventDefault(); return openAsk(); }
    if (event.metaKey && event.shiftKey && !event.ctrlKey && key === "n") { event.preventDefault(); return newEdit(true); }
    if (event.metaKey && !event.ctrlKey && key === "y") { event.preventDefault(); return showPanel("history", "right"); }
    if (event.metaKey && event.ctrlKey && (key === "s" || key === "i")) { event.preventDefault(); return toggle(key === "s" ? "left" : "right"); }
    const onEdit = !inSource;
    if (onEdit && event.metaKey && !event.ctrlKey && !event.altKey) {
      const action = ({ b: cutHere, l: () => setLooping((value) => !value), "=": () => zoomBy(1), "-": () => zoomBy(-1) } as Record<string, () => void>)[key];
      if (action) { event.preventDefault(); return action(); }
    }
    if (onEdit && event.altKey && !event.metaKey && event.code === "KeyX") { event.preventDefault(); return setMarks({ in: null, out: null }); }
    if (key === "escape" && dead) { event.preventDefault(); return setDead(null); }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (onEdit && event.shiftKey && key === "z") { event.preventDefault(); return zoomBy(0); }
    const tool = onEdit && !event.shiftKey ? ({ i: markIn, o: markOut, z: () => takeMarked(false), x: () => takeMarked(true), m: addMarker, t: markClip, n: () => setSnap((value) => !value),
      a: () => previousEdit && chooseSeam(previousEdit.index), s: () => nextEdit && chooseSeam(nextEdit.index) } as Record<string, () => void>)[key] : undefined;
    if (tool) { event.preventDefault(); return tool(); }
    if (key === "v") { event.preventDefault(); return insert(false); }
    if (key === "f") { event.preventDefault(); return event.shiftKey ? findInEdit() : findInSource(); }
    if (key === "escape" && drag) { setDrag(null); }
  };

  // On the window, not the root: after a button that disabled itself (Apply,
  // say) focus falls to <body>, and ⌘Z still has to reach the edit.
  const keyHandler = useRef(onKeyDown);
  useEffect(() => { keyHandler.current = onKeyDown; });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keyHandler.current(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const panel = (tab: string) => {
    if (tab === "library") return <TeSidebar groups={library(dock)} current="edit" onNew={newEdit}
      onOpen={(item) => item.id === "edit" ? setMessage("") : item.ready ? (showPanel(sourceTab(item.id), "source"), setFocusSource(item.id)) : setMessage("Placeholder.")} />;
    if (tab === "inspector") return <TeInspector speakers={teSpeakers.filter((speaker) => talk[speaker.id] || placed.some((item) => item.word.speaker === speaker.id))} colors={colors} fps={fps}
      selected={selected} caretWord={placed[caret] ?? null} crosstalk={dryRun?.crosstalk ?? []} cutSeconds={dryRun?.seconds ?? 0} onDelete={remove} onMatch={findInSource}
      seam={seam == null ? null : (() => { const info = seams.find((item) => item.index === seam); return info ? { index: info.index, at: info.at, gap: info.gap, kind: info.kind, removed: info.removed.length, clipped: [...info.clipped].map(nameOf) } : null; })()}
      onRestoreSeam={() => {
        const info = seams.find((item) => item.index === seam);
        if (seam == null || !info || info.kind !== "cut") return;
        commit("Restore Cut", (present) => ({ edit: healSeam(present.edit, seam) }));
        setSeam(null);
        setMessage(`Restored ${info.gap.toFixed(2)} s.`);
      }}
      onCloseSeam={() => setSeam(null)}
      summary={{ running: total, sources: [...new Set(edit.segments.filter((segment) => !isGap(segment)).map((segment) => sourceOf(segment.source).short))], removedLines: ghosts.length,
        clips: edit.segments.length, cuts: seams.length, lifted: placed.filter((item) => item.muted).length, corrections: Object.keys(corrections).length }}
      talk={talk} />;
    if (tab === "history") return <TeHistory log={log} onJump={(id) => moveHead(jump(log, id), log.states[id].pinned ?? log.states[id].label)}
      onPin={(id, name) => setLog((state) => pin(state, id, name))} />;
    if (tab === "ask") return <TeAsk context={context} messages={messages} colors={colors} sourceName={(id) => sourceOf(id).short}
      lineTc={(line) => teTc(line.words[0].start, fps, sourceOf(line.source).startTc)}
      onSend={(prompt) => {
        const reply = answer(prompt, context);
        setMessages((list) => [...list, { id: list.length, role: "you", text: prompt }, { id: list.length + 1, role: "ask", text: reply.text, reply }]);
      }}
      onJump={(line: TeLine) => showInSource(line.source, line.words)}
      onApply={(item) => {
        const proposal = item.reply?.proposal;
        if (!proposal) return;
        if (proposal.kind === "insert") splice(proposal.lines, null, `Ask: ${proposal.label}`);
        else {
          const ids = new Set(proposal.ids);
          // Never cut through someone else's words: a filler with overtalk
          // under it is silenced on its own track; the rest close up.
          const under = new Set([...ids].filter((id) => { const mine = teWords.find((word) => word.id === id)!;
            return teWords.some((other) => other.source === mine.source && other.speaker !== mine.speaker && other.start < mine.end && other.end > mine.start); }));
          const result = deleteWords(teWords, edit, new Set(placed.filter((word) => ids.has(word.word.id) && !under.has(word.word.id)).map(placementKey)));
          commit(`Ask: ${proposal.label}`, () => ({ edit: under.size ? muteWords(teWords, result.edit, under) : result.edit }));
        }
        setMessages((list) => list.map((entry) => entry.id === item.id ? { ...entry, applied: true } : entry));
        requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(".cp-te-ask-input")?.focus());
        setMessage(`${proposal.label}.`);
      }} />;
    if (isSourceTab(tab)) {
      const source = sourceOf(tab.slice(7));
      return <div data-source-id={source.id} className="cp-te-source-host" onFocusCapture={() => setFocusSource(source.id)} onPointerDownCapture={() => setFocusSource(source.id)}>
        <TeSource source={source} speakers={teSpeakers} colors={colors} fps={fps} words={teWords} used={used} corrections={corrections}
          range={ranges[source.id] ?? null} onRange={(next) => { setRanges((state) => ({ ...state, [source.id]: next })); setMatch(null); }} match={match}
          playhead={playback.head(source.id)} playing={playback.playing === source.id} onPlay={() => playback.toggle(source.id)}
          onScrub={(value) => playback.seek(source.id, value)} onScrubStart={playback.scrubStart} onScrubEnd={playback.scrubEnd}
          text={text.source} onText={(style) => setText((state) => ({ ...state, source: style }))}
          onInsert={() => insert(false)} onAppend={() => insert(true)} />
      </div>;
    }
    return <TeRecord fps={fps} playhead={playhead} total={total} marks={seams.map((item) => item.at)}
      note=""
      onScrub={seek} onScrubStart={playback.scrubStart} onScrubEnd={playback.scrubEnd}
      text={text.edit} onText={(style) => setText((state) => ({ ...state, edit: style }))}>
      <TeDocument speakers={teSpeakers} colors={colors} fps={fps} paragraphs={paras} placed={placed} selection={selection} current={currentKey}
        sourceLabel={shortName} seams={seamInfo} seam={seam} onSeam={chooseSeam}
        ghosts={showRemoved ? ghosts : null} onRestore={restore} corrections={corrections} editing={editing}
        onCorrect={(id, value) => {
          setEditing(null);
          const original = teWords.find((word) => word.id === id)?.text;
          commit("Correct Text", (present) => {
            if ((present.corrections[id] ?? null) === (value === original ? null : value)) return null;
            const next = { ...present.corrections };
            if (!value || value === original) delete next[id]; else next[id] = value;
            return { corrections: next };
          });
          focusDoc();
        }}
        onSelect={(next, seekTo) => { setSelection(next); if (seekTo) seek(next.anchor < count ? placed[next.anchor].programStart : total); }}
        onScrub={seek} onDelete={remove} onEdit={setEditing}
        onMove={(index, direction) => {
          const paragraph = paras[index];
          if (!paragraph || !paras[index + direction]) return;
          const next = moveParagraph(teWords, edit, paragraph, direction < 0 ? paras[index - 1] : paras[index + 2] ?? null);
          if (next === edit) return;
          commit("Move Paragraph", () => ({ edit: next }), `move:${paragraph.words[0].word.id}`);
          const first = placeWords(teWords, next).findIndex((item) => item.word.id === paragraph.words[0].word.id);
          setSelection({ anchor: first, focus: first + paragraph.words.length - 1, collapsed: false });
          setMessage(`Moved ${direction < 0 ? "up" : "down"}.`);
        }} />
      {prompt && <TePrompt who={names(prompt.who)} under={names(prompt.result.crosstalk.map((word) => word.speaker))} count={prompt.result.crosstalk.length}
        onEveryone={() => applyDelete(prompt.result, prompt.lift.size)} onKeep={() => { setPrompt(null); focusDoc(); }} />}
    </TeRecord>;
  };

  const tabsOf = (column: TeColumn): TeTab[] => {
    const own = dock[column].tabs.map((tab) => ({ id: tab, label: tabLabel(tab), closable: isClosable(tab), movable: tab !== TE_PINNED, home: column }));
    if (column !== "record") return own;
    return [...own, ...layout.folded.flatMap((folded) => dock[folded as TeColumn].tabs.map((tab) => ({ id: tab, label: tabLabel(tab), closable: isClosable(tab), movable: true, home: folded as TeColumn })))];
  };
  const activeIn = (column: TeColumn) => column === "record" && recordView && tabsOf("record").some((tab) => tab.id === recordView) ? recordView : dock[column].active;
  const columnView = (column: TeColumn) => {
    const tabs = tabsOf(column), active = activeIn(column);
    return <div className="cp-te-column" data-dock-column={column} data-drop={drag?.target?.column === column ? "" : undefined}>
      <TeTabBar column={column} tabs={tabs} active={active} panelId={`cp-te-panel-${column}`} dropIndex={drag?.target?.column === column ? drag.target.index : null}
        onActivate={(tab) => {
          const home = columnOf(dock, tab)!;
          setDock((state) => activate(state, tab));
          if (column === "record") setRecordView(home === "record" ? null : tab);
          if (isSourceTab(tab)) setFocusSource(tab.slice(7));
        }}
        onClose={(tab) => { setDock((state) => closeTab(state, tab)); setMessage(`Closed ${tabLabel(tab)}.`); }}
        onMove={moveTo}
        onDrag={(tab, x, y) => setDrag({ tab, x, y, target: dropTarget(x, y, tab) })}
        onDrop={(x, y) => { const target = drag ? dropTarget(x, y, drag.tab) : null; if (drag && target) moveTo(drag.tab, target.column, target.index); setDrag(null); }}
        onCancel={() => setDrag(null)} />
      <div className="cp-te-column-body" id={`cp-te-panel-${column}`} role="tabpanel" aria-label={active ? tabLabel(active) : teColumnNames[column]}>{active && panel(active)}</div>
    </div>;
  };

  const sourceIndex = placed.length ? programToSource(edit, playhead) : null;
  const sourceAtHead = sourceIndex && !isGap(edit.segments[sourceIndex.segment]) ? edit.segments[sourceIndex.segment].source : null;
  return <div ref={root} className={`cp-te${drag ? " is-dragging" : ""}`} data-testid="transcript-editor">
    <TeToolbar title="Kitchen Challenge, first pass" subtitle={`${sourceOf("mg3").name} · ${teScene.aaf}`}
      left={layout.shown.left} source={layout.shown.source} right={layout.shown.right}
      onLeft={() => toggle("left")} onSource={() => toggle("source")} onRight={() => toggle("right")} onAsk={openAsk} onHistory={() => showPanel("history", "right")}
      undo={undoLabel} redo={redoLabel} onUndo={() => step(true)} onRedo={() => step(false)}
      showRemoved={showRemoved} onShowRemoved={() => setShowRemoved((value) => !value)} />
    <div className="cp-te-panes">
      {(["left", "source"] as const).map((column) => layout.shown[column] && <div key={column} className="cp-te-pane-pair">
        <div className="cp-te-pane" style={{ width: layout.widths[column] }}>{columnView(column)}</div>
        <TeSplitter between="column" label={`${teColumnNames[column]} width`} value={layout.widths[column]} {...tePaneLimits[column]}
          onChange={(width) => setSizes((state) => ({ ...state, [column]: width }))} onReset={() => setSizes((state) => ({ ...state, [column]: tePaneLimits[column].ideal }))} />
      </div>)}
      <div className="cp-te-pane cp-te-pane-record">{columnView("record")}</div>
      {layout.shown.right && <div className="cp-te-pane-pair">
        <TeSplitter between="column" label="Right panel width" value={layout.widths.right} invert {...tePaneLimits.right}
          onChange={(width) => setSizes((state) => ({ ...state, right: width }))} onReset={() => setSizes((state) => ({ ...state, right: tePaneLimits.right.ideal }))} />
        <div className="cp-te-pane" style={{ width: layout.widths.right }}>{columnView("right")}</div>
      </div>}
    </div>
    {drag && <>
      {teColumns.filter((column) => column !== "record" && !layout.shown[pane(column)]).map((column) =>
        <div key={column} className={`cp-te-dropzone is-${column}`} data-dock-column={column} data-drop={drag.target?.column === column ? "" : undefined}>{teColumnNames[column]}</div>)}
      <div className="cp-te-drag-ghost" style={{ left: drag.x + 12, top: drag.y + 10 }} aria-hidden="true">{tabLabel(drag.tab)}</div>
    </>}
    <TeSplitter between="row" label="Timeline height" value={timelineHeight} invert min={teTimelineLimits.min} max={Math.max(teTimelineLimits.min, Math.floor(box.height / 2))}
      onChange={setTimeline} onReset={() => setTimeline(null)} />
    <div className="cp-te-lower" style={{ height: timelineHeight }}>
      <TeTransport playing={playback.playing === "record"} onToggle={() => playback.toggle("record")} onStart={() => seek(0)} playhead={playhead} total={total} fps={fps}
        source={sourceAtHead && sourceIndex ? sourceIndex.source : null} sourceBase={sourceAtHead ? sourceOf(sourceAtHead).startTc : "00:00:00:00"}
        sourceName={sourceAtHead ? sourceOf(sourceAtHead).short : ""} message={message} />
      <TeTimeline speakers={teSpeakers} edit={edit} seams={seams} placed={placed} selection={keys} playhead={playhead} fps={fps} colors={colors}
        solo={solo} mute={mute} onSeek={seek} seam={seam} onSeam={chooseSeam} sourceSpeakers={sourceSpeakers} sourceName={shortName}
        tracks={tracks} onTrack={(id, only) => setTracks((state) => { if (only) return new Set([id]); const next = new Set(state); if (!next.delete(id)) next.add(id); return next; })}
        dead={dead} onDeadSkip={(index) => setDead((state) => { if (!state) return state; const skip = new Set(state.skip); if (!skip.delete(index)) skip.add(index); return { ...state, skip }; })}
        onDeadPreset={findDead} onDeadApply={applyDead} onDeadCancel={() => setDead(null)}
        onScrubStart={playback.scrubStart} onScrubEnd={playback.scrubEnd} zoom={zoom} onZoom={setZoom} markers={markers}
        tools={{ marks, canMark: count > 0, snap, follow: followHead, loop: looping, hasPrevious: !!previousEdit, hasNext: !!nextEdit,
          onAddEdit: cutHere, onMarkIn: markIn, onMarkClip: markClip, onFindDead: () => (dead ? setDead(null) : findDead()), finding: !!dead, onMarkOut: markOut, onLift: () => takeMarked(false), onExtract: () => takeMarked(true), onMarker: addMarker,
          onSnap: () => setSnap((value) => !value), onFollow: () => setFollowHead((value) => !value), onLoop: () => setLooping((value) => !value),
          onPrevious: () => previousEdit && chooseSeam(previousEdit.index), onNext: () => nextEdit && chooseSeam(nextEdit.index) }}
        onSolo={(id) => setSolo((state) => { const next = new Set(state); if (!next.delete(id)) next.add(id); return next; })}
        onMute={(id) => setMute((state) => { const next = new Set(state); if (!next.delete(id)) next.add(id); return next; })} />
    </div>
  </div>;
}

function library(dock: ReturnType<typeof defaultDock>): TeLibraryGroup[] {
  const isOpen = (id: string) => !!columnOf(dock, sourceTab(id));
  const detail = (id: string) => { const source = sourceOf(id); return `${plural(source.speakers.length, "mic")} · ${secondsToTc(source.duration, fps).slice(3, 8)}${isOpen(id) ? " · open" : ""}`; };
  return [
    { title: "AAF Audio", items: ["mg3", "mg1"].map((id) => ({ id, name: sourceOf(id).name, detail: detail(id), ready: true, open: isOpen(id) })) },
    { title: "Library", items: [
      { id: "itm", name: sourceOf("itm").name, detail: detail("itm"), ready: true, open: isOpen("itm") },
      { id: "lib", name: "EP104 Kitchen walkthrough.mov", detail: "Transcript · 2 speakers · 8:15", ready: false },
    ] },
    { title: "Edits", items: [{ id: "edit", name: "Kitchen Challenge, first pass", detail: "Open", ready: true }] },
  ];
}
