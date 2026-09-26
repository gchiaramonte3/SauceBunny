import { useEffect, useMemo, useRef, useState } from "react";
import { secondsToTc } from "../src/lib/timecode";
import { teScene, teSourceDuration, teSpeakers, teTc, teWholeScene, teWords } from "./transcript-editor-fixture";
import {
  cutRange, deleteWords, healSeam, moveParagraph, muteWords, paragraphs, placeWords, placementKey, programDuration,
  programToSource, seamList, segmentStarts, spliceIn, unmuteWords, type TeDeleteResult, type TeEdit,
} from "./transcript-editor-model";
import { clampTimeline, layoutPanes, tePaneLimits, teTimelineLimits, type TePane } from "./transcript-editor-layout";
import { TeDocument, type TeSelection } from "./TeDocument";
import type { TeSeamInfo } from "./TeParagraph";
import { TeInspector } from "./TeInspector";
import { TePrompt } from "./TePrompt";
import { TeSidebar, type TeLibraryGroup } from "./TeSidebar";
import { TeSource } from "./TeSource";
import { TeSplitter } from "./TeSplitter";
import { TeTimeline } from "./TeTimeline";
import { TeToolbar } from "./TeToolbar";
import { TeTransport } from "./TeTransport";

/** Five well-separated hues from the production SPEAKER_SOLIDS palette
 *  (src/components/transcript/helpers.tsx), which the catalog may not import. */
const colors: Record<string, string> = Object.fromEntries(teSpeakers.map((speaker, index) =>
  [speaker.id, ["#FD8A8C", "#EB9A04", "#0AF2CD", "#75B0FF", "#E887FE"][index]]));
const scene = teWholeScene();
const sourcePlaced = placeWords(teWords, scene);
const fps = teScene.fps;
const library: TeLibraryGroup[] = [
  { title: "AAF Audio", items: [
    { id: "mg3", name: teScene.sequence, detail: "5 mics · 2:02 · transcribed", ready: true },
    { id: "mg1", name: "EP104 Judges Table · MG 1", detail: "4 mics · 6:40 · transcribed", ready: false },
    { id: "itm", name: "EP104 ITM Rosa", detail: "1 mic · 11:12 · not transcribed", ready: false },
  ] },
  { title: "Library", items: [
    { id: "lib", name: "EP104 Kitchen walkthrough.mov", detail: "Transcript · 2 speakers · 8:15", ready: false },
  ] },
  { title: "Edits", items: [{ id: "edit", name: "Kitchen Challenge, first pass", detail: "From MG 3 · open", ready: true }] },
];

type Snapshot = { edit: TeEdit; corrections: Record<string, string> };
type History = { past: { snapshot: Snapshot; label: string }[]; present: Snapshot; future: { snapshot: Snapshot; label: string }[] };
const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;
const tc = (seconds: number) => teTc(seconds, fps);
const nameOf = (id: string) => teSpeakers.find((speaker) => speaker.id === id)?.name ?? id;
const names = (ids: string[]) => { const list = [...new Set(ids)].map(nameOf); return list.length < 3 ? list.join(" and ") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`; };

/**
 * Transcript Editor, as a clickable prototype. Nothing here reads a file or
 * plays sound: the scene is generated, and the playhead runs on a clock. What
 * IS real is the edit model, so every deletion, move, splice and undo does to
 * the timeline exactly what it says.
 */
export function TranscriptEditorPrototype() {
  const root = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 1680, height: 1020 });
  const [history, setHistory] = useState<History>(() => ({ past: [], present: { edit: scene, corrections: {} }, future: [] }));
  const { edit, corrections } = history.present;
  const [selection, setSelection] = useState<TeSelection>({ anchor: 0, focus: 0, collapsed: true });
  const [playhead, setPlayhead] = useState(0);
  const [play, setPlay] = useState<{ from: number; at: number } | null>(null);
  const [solo, setSolo] = useState<Set<string>>(new Set());
  const [mute, setMute] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState({ sidebar: true, source: true, inspector: true });
  const [sizes, setSizes] = useState({ sidebar: 220, source: 320, inspector: 270 });
  const [priority, setPriority] = useState<TePane[]>(["source", "inspector", "sidebar"]);
  const [timelineWanted, setTimeline] = useState<number | null>(null);
  const [view, setView] = useState<"source" | "edit">("edit");
  const [showRemoved, setShowRemoved] = useState(false);
  const [seam, setSeam] = useState<number | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [sourceRange, setSourceRange] = useState<[number, number] | null>(null);
  const [match, setMatch] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<{ result: TeDeleteResult; lift: Set<string>; who: string[] } | null>(null);
  const [message, setMessage] = useState("");

  const placed = useMemo(() => placeWords(teWords, edit), [edit]);
  const paras = useMemo(() => paragraphs(placed), [placed]);
  const seams = useMemo(() => seamList(edit, teWords), [edit]);
  const used = useMemo(() => new Set(placed.map((item) => item.word.id)), [placed]);
  const total = programDuration(edit);
  const count = placed.length;
  const starts = segmentStarts(edit);
  const range: [number, number] | null = selection.collapsed || !count ? null
    : [Math.min(selection.anchor, selection.focus, count - 1), Math.min(Math.max(selection.anchor, selection.focus), count - 1)];
  const caret = Math.min(selection.anchor, count);
  const selected = range ? placed.slice(range[0], range[1] + 1) : [];
  const keys = new Set(selected.map(placementKey));
  const dryRun = selected.length ? deleteWords(teWords, edit, keys) : null;
  const current = placed.find((item) => item.programStart <= playhead && playhead < item.programEnd) ?? null;
  const speaking = [...new Set(placed.filter((item) => !item.muted && item.programStart <= playhead && playhead < item.programEnd).map((item) => item.word.speaker))];
  const layout = layoutPanes(box.width, open, sizes, priority);
  const timelineHeight = clampTimeline(timelineWanted ?? Math.min(teTimelineLimits.ideal, Math.round(box.height * 0.3)), box.height);
  const seamInfo: Record<number, TeSeamInfo> = Object.fromEntries(seams.map((item) => [item.index, { seconds: item.kind === "jump" ? null : item.gap, removed: item.removed }]));
  const talk: Record<string, number> = {};
  for (const item of placed) if (!item.muted) talk[item.word.speaker] = (talk[item.word.speaker] ?? 0) + item.programEnd - item.programStart;

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setBox({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!play) return;
    let frame = 0;
    const tick = (now: number) => {
      const position = play.from + Math.max(0, now - play.at) / 1000;
      if (position >= total) { setPlayhead(total); setPlay(null); return; }
      setPlayhead(position);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [play, total]);
  const currentKey = current ? placementKey(current) : null;
  useEffect(() => {
    if (play && currentKey) root.current?.querySelector(".cp-te-doc .cp-te-word.is-current")?.scrollIntoView({ block: "nearest" });
  }, [currentKey, play]);

  const focusDoc = () => requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(".cp-te-doc")?.focus());
  const seek = (position: number) => {
    const at = Math.max(0, Math.min(total, position));
    setPlayhead(at);
    if (play) setPlay({ from: at, at: performance.now() });
  };
  const commit = (label: string, change: (present: Snapshot) => Partial<Snapshot> | null) => setHistory((h) => {
    const next = change(h.present);
    return next ? { past: [...h.past, { snapshot: h.present, label }].slice(-200), present: { ...h.present, ...next }, future: [] } : h;
  });
  const step = (back: boolean) => {
    const entry = back ? history.past[history.past.length - 1] : history.future[0];
    if (!entry) return;
    setHistory(back
      ? { past: history.past.slice(0, -1), present: entry.snapshot, future: [{ snapshot: history.present, label: entry.label }, ...history.future] }
      : { past: [...history.past, { snapshot: history.present, label: entry.label }], present: entry.snapshot, future: history.future.slice(1) });
    setSeam(null); setPrompt(null);
    setMessage(`${back ? "Undo" : "Redo"}: ${entry.label}.`);
  };
  const applyDelete = (result: TeDeleteResult, words: number) => {
    const at = range ? range[0] : caret;
    commit(`Delete ${plural(words, "Word")}`, () => ({ edit: result.edit }));
    setSelection({ anchor: at, focus: at, collapsed: true });
    setPrompt(null); setSeam(null);
    seek(placeWords(teWords, result.edit)[at]?.programStart ?? programDuration(result.edit));
    setMessage(`Deleted ${plural(words, "word")}, ${result.seconds.toFixed(2)} s. Every track closed up.`);
    focusDoc();
  };
  const lift = (ids: Set<string>, who: string[]) => {
    const restoring = selected.every((item) => item.muted);
    commit(restoring ? "Restore on Track" : `Remove from ${names(who)}'s Track`, (present) =>
      ({ edit: restoring ? unmuteWords(teWords, present.edit, ids) : muteWords(teWords, present.edit, ids) }));
    setPrompt(null);
    setMessage(restoring ? `Restored ${plural(ids.size, "word")} on ${names(who)}'s track.` : `Silenced ${plural(ids.size, "word")} on ${names(who)}'s track. Nothing moved.`);
    focusDoc();
  };
  const remove = (speakerOnly: boolean) => {
    if (!dryRun || !selected.length) return;
    const ids = new Set(selected.map((item) => item.word.id));
    const who = selected.map((item) => item.word.speaker);
    if (speakerOnly) return lift(ids, who);
    if (dryRun.crosstalk.length) return setPrompt({ result: dryRun, lift: ids, who });
    applyDelete(dryRun, selected.length);
  };
  const insertionPoint = (index: number) => {
    if (index >= count) return total;
    if (index <= 0) return 0;
    const [before, after] = [placed[index - 1], placed[index]];
    return before.segment !== after.segment ? starts[after.segment] : (before.programEnd + after.programStart) / 2;
  };
  const insert = (atEnd: boolean) => {
    if (!sourceRange) return;
    const chosen = sourcePlaced.slice(sourceRange[0], sourceRange[1] + 1).map((item) => item.word);
    const [srcIn, srcOut] = cutRange(teWords, chosen, scene.segments[0]);
    const position = atEnd ? total : insertionPoint(range ? range[0] : caret);
    const next = spliceIn(edit, srcIn, srcOut, position);
    const fresh = next.segments.findIndex((segment) => !edit.segments.some((old) => old.id === segment.id) && segment.srcIn === srcIn);
    const indexes = placeWords(teWords, next).flatMap((item, index) => item.segment === fresh ? [index] : []);
    commit(`Insert ${plural(chosen.length, "Word")}`, () => ({ edit: next }));
    if (indexes.length) setSelection({ anchor: indexes[0], focus: indexes[indexes.length - 1], collapsed: false });
    setMessage(`Inserted ${plural(chosen.length, "word")} at ${tc(position)}. Everything after it moved down on every track.`);
    focusDoc();
  };
  const findInSource = () => {
    const targets = selected.length ? selected : placed[caret] ? [placed[caret]] : [];
    if (!targets.length) return;
    const indexes = targets.map((item) => sourcePlaced.findIndex((other) => other.word.id === item.word.id));
    setSourceRange([Math.min(...indexes), Math.max(...indexes)]);
    setMatch(targets[0].word.id);
    if (layout.folded) setView("source");
    else if (!layout.shown.source) toggle("source");
    setMessage(`Found in the source at ${teTc(targets[0].word.start, fps, teScene.startTc)}.`);
  };
  const findInEdit = () => {
    if (!sourceRange) return;
    const word = sourcePlaced[sourceRange[0]].word;
    const index = placed.findIndex((item) => item.word.id === word.id);
    if (index < 0) return setMessage(`“${word.text}” is not in the edit. Press V to insert it at the caret.`);
    setSelection({ anchor: index, focus: index, collapsed: true });
    seek(placed[index].programStart);
    if (layout.folded) setView("edit");
    setMessage(`Found in the edit at ${tc(placed[index].programStart)}.`);
    focusDoc();
  };
  const toggle = (pane: TePane) => {
    if (layout.shown[pane]) return setOpen((state) => ({ ...state, [pane]: false }));
    setOpen((state) => ({ ...state, [pane]: true }));
    setPriority((order) => [pane, ...order.filter((item) => item !== pane)]);
  };
  const togglePlay = () => {
    if (play) return setPlay(null);
    const from = playhead >= total - 0.01 ? 0 : playhead;
    setPlayhead(from);
    setPlay({ from, at: performance.now() });
  };
  const chooseSeam = (index: number) => {
    setSeam(index);
    seek(starts[index] ?? 0);
    const info = seams.find((item) => item.index === index);
    if (info && !layout.shown.inspector) setMessage(info.kind === "cut" ? `Cut at ${tc(info.at)}, ${info.gap.toFixed(2)} s removed. Open the inspector to restore it.` : `Edit point at ${tc(info.at)}.`);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [role=alertdialog]")) return;
    const key = event.key.toLowerCase();
    if (event.key === " " && !target.closest("button, [role=separator]")) { event.preventDefault(); return togglePlay(); }
    if (event.metaKey && !event.ctrlKey && key === "z") { event.preventDefault(); return step(!event.shiftKey); }
    if (event.metaKey && event.ctrlKey && (key === "s" || key === "i")) { event.preventDefault(); return toggle(key === "s" ? "sidebar" : "inspector"); }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (key === "v") { event.preventDefault(); return insert(false); }
    if (key === "f") { event.preventDefault(); return event.shiftKey ? findInEdit() : findInSource(); }
    if (event.key === "Home" && !target.closest(".cp-te-doc, [role=separator]")) { event.preventDefault(); seek(0); }
  };

  const source = <TeSource speakers={teSpeakers} colors={colors} fps={fps} sourceBase={teScene.startTc} words={teWords} scene={scene} used={used}
    corrections={corrections} range={sourceRange} onRange={(next) => { setSourceRange(next); setMatch(null); }} match={match}
    onInsert={() => insert(false)} onAppend={() => insert(true)} sequence={teScene.sequence} />;
  const sourceIndex = placed.length ? programToSource(edit, playhead) : null;
  return <div ref={root} className="cp-te" data-testid="transcript-editor" onKeyDown={onKeyDown}>
    <TeToolbar title="Kitchen Challenge, first pass" subtitle={`From ${teScene.sequence} · ${teScene.aaf}`}
      sidebar={layout.shown.sidebar} inspector={layout.shown.inspector} source={layout.shown.source} folded={layout.folded} view={view}
      onSidebar={() => toggle("sidebar")} onInspector={() => toggle("inspector")} onSource={() => toggle("source")} onView={setView}
      undo={history.past[history.past.length - 1]?.label ?? null} redo={history.future[0]?.label ?? null} onUndo={() => step(true)} onRedo={() => step(false)}
      showRemoved={showRemoved} onShowRemoved={() => setShowRemoved((value) => !value)} />
    <div className="cp-te-panes">
      {layout.shown.sidebar && <>
        <div className="cp-te-pane" style={{ width: layout.widths.sidebar }}>
          <TeSidebar groups={library} current="edit" onNew={() => { commit("New Edit", () => ({ edit: teWholeScene() })); setSelection({ anchor: 0, focus: 0, collapsed: true }); seek(0); setMessage("Started again from the whole scene. Undo brings the last edit back."); }}
            onOpen={(item) => setMessage(item.id === "edit" ? "This edit is open." : item.ready ? `This edit is cut from ${item.name}. The whole scene is in the Source pane.` : `${item.name} is a placeholder in this prototype.`)} />
        </div>
        <TeSplitter between="column" label="Sidebar width" value={layout.widths.sidebar} {...tePaneLimits.sidebar}
          onChange={(width) => setSizes((state) => ({ ...state, sidebar: width }))} onReset={() => setSizes((state) => ({ ...state, sidebar: tePaneLimits.sidebar.ideal }))} />
      </>}
      {layout.shown.source && <>
        <div className="cp-te-pane" style={{ width: layout.widths.source }}>{source}</div>
        <TeSplitter between="column" label="Source width" value={layout.widths.source} {...tePaneLimits.source}
          onChange={(width) => setSizes((state) => ({ ...state, source: width }))} onReset={() => setSizes((state) => ({ ...state, source: tePaneLimits.source.ideal }))} />
      </>}
      <div className="cp-te-pane cp-te-pane-record">
        {layout.folded && view === "source" ? source : <section className="cp-te-record" aria-labelledby="cp-te-record-title">
          <header className="cp-te-pane-head">
            <h2 id="cp-te-record-title" className="cp-te-pane-title">Edit</h2>
            <span className="cp-te-pane-note">{plural(count, "word")} · {secondsToTc(total, fps)} · {plural(seams.length, "edit point")}</span>
          </header>
          <TeDocument speakers={teSpeakers} colors={colors} fps={fps} paragraphs={paras} placed={placed} selection={selection} current={currentKey}
            seams={seamInfo} showRemoved={showRemoved} seam={seam} onSeam={chooseSeam} corrections={corrections} editing={editing}
            onCorrect={(id, text) => {
              setEditing(null);
              const original = teWords.find((word) => word.id === id)?.text;
              commit("Correct Text", (present) => {
                const same = (present.corrections[id] ?? null) === (text === original ? null : text);
                if (same) return null;
                const next = { ...present.corrections };
                if (!text || text === original) delete next[id]; else next[id] = text;
                return { corrections: next };
              });
              focusDoc();
            }}
            onSelect={(next, seekTo) => { setSelection(next); if (seekTo) seek(next.anchor < count ? placed[next.anchor].programStart : total); }}
            onDelete={remove} onEdit={setEditing}
            onMove={(index, direction) => {
              const paragraph = paras[index];
              if (!paragraph || !paras[index + direction]) return;
              const next = moveParagraph(teWords, edit, paragraph, direction < 0 ? paras[index - 1] : paras[index + 2] ?? null);
              if (next === edit) return;
              commit("Move Paragraph", () => ({ edit: next }));
              const first = placeWords(teWords, next).findIndex((item) => item.word.id === paragraph.words[0].word.id);
              setSelection({ anchor: first, focus: first + paragraph.words.length - 1, collapsed: false });
              setMessage(`Moved ${nameOf(paragraph.speaker)}'s paragraph ${direction < 0 ? "up" : "down"}. Its clips moved with it on every track.`);
            }} />
          {prompt && <TePrompt who={names(prompt.who)} under={names(prompt.result.crosstalk.map((word) => word.speaker))} count={prompt.result.crosstalk.length}
            onEveryone={() => applyDelete(prompt.result, prompt.lift.size)} onOnly={() => lift(prompt.lift, prompt.who)} onCancel={() => { setPrompt(null); focusDoc(); }} />}
        </section>}
      </div>
      {layout.shown.inspector && <>
        <TeSplitter between="column" label="Inspector width" value={layout.widths.inspector} invert {...tePaneLimits.inspector}
          onChange={(width) => setSizes((state) => ({ ...state, inspector: width }))} onReset={() => setSizes((state) => ({ ...state, inspector: tePaneLimits.inspector.ideal }))} />
        <div className="cp-te-pane" style={{ width: layout.widths.inspector }}>
          <TeInspector speakers={teSpeakers} colors={colors} fps={fps} selected={selected} caretWord={placed[caret] ?? null}
            crosstalk={dryRun?.crosstalk ?? []} cutSeconds={dryRun?.seconds ?? 0} onDelete={remove} onMatch={findInSource}
            seam={seam == null ? null : (() => { const info = seams.find((item) => item.index === seam); return info ? { index: info.index, at: info.at, gap: info.gap, kind: info.kind, removed: info.removed.length, clipped: [...info.clipped].map(nameOf) } : null; })()}
            onRestoreSeam={() => {
              const info = seams.find((item) => item.index === seam);
              if (seam == null || !info || info.kind !== "cut") return;
              commit("Restore Cut", (present) => ({ edit: healSeam(present.edit, seam) }));
              setSeam(null);
              setMessage(`Restored ${info.gap.toFixed(2)} s and ${plural(info.removed.length, "word")}. Every track opened up again.`);
            }}
            onCloseSeam={() => setSeam(null)}
            summary={{ running: total, scene: teSourceDuration, clips: edit.segments.length, cuts: seams.length, lifted: placed.filter((item) => item.muted).length, corrections: Object.keys(corrections).length }}
            talk={talk} />
        </div>
      </>}
    </div>
    <TeSplitter between="row" label="Timeline height" value={timelineHeight} invert min={teTimelineLimits.min} max={Math.max(teTimelineLimits.min, Math.floor(box.height / 2))}
      onChange={setTimeline} onReset={() => setTimeline(null)} />
    <div className="cp-te-lower" style={{ height: timelineHeight }}>
      <TeTransport playing={play != null} onToggle={togglePlay} onStart={() => seek(0)} playhead={playhead} total={total} fps={fps}
        source={sourceIndex ? sourceIndex.source : null} sourceBase={teScene.startTc}
        speaking={speaking.map((id) => ({ id, name: nameOf(id), color: colors[id] }))} message={message} />
      <TeTimeline speakers={teSpeakers} edit={edit} seams={seams} placed={placed} selection={keys} playhead={playhead} fps={fps} colors={colors}
        solo={solo} mute={mute} onSeek={seek} seam={seam} onSeam={chooseSeam}
        onSolo={(id) => setSolo((state) => { const next = new Set(state); if (!next.delete(id)) next.add(id); return next; })}
        onMute={(id) => setMute((state) => { const next = new Set(state); if (!next.delete(id)) next.add(id); return next; })} />
    </div>
  </div>;
}
