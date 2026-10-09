import { useMemo, useRef, useState } from "react";
import type { EditHead } from "../bindings/EditHead";
import type { EditHistory } from "../bindings/EditHistory";
import { useEditEditorKeys } from "../hooks/use-edit-editor-keys";
import { useEditPlayback } from "../hooks/use-edit-playback";
import { useEditPipeline } from "../hooks/use-edit-pipeline";
import { useEditSourceSide, type EditSourceMarks } from "../hooks/use-edit-source-side";
import type { EditChange } from "../hooks/use-edit-session";
import type { EditSourceData } from "../hooks/use-edit-sources";
import { useEditWorkspace } from "../hooks/use-edit-workspace";
import type { RecordTool } from "../hooks/use-record-gestures";
import { editTc, fps as rateOf, fromDocument, toDocument, type OpenEdit } from "../lib/edit-document";
import { stackConversations } from "../lib/edit-exchanges";
import { focusOnMarkers } from "../lib/edit-focus";
import { stringoutDefaults } from "../lib/edit-stringout";
import type { AskCitation } from "../lib/edit-ask";
import { layerClips, type TimelineLane } from "../lib/edit-model";
import { onTrack, peopleOf } from "../lib/edit-new";
import { laneColors } from "../lib/edit-source-view";
import { SPEAKER_PALETTE } from "./transcript/helpers";
import { EditExportButton } from "./EditExportButton";
import { EditLower } from "./EditLower";
import { EditRecordPane } from "./EditRecordPane";
import { EditRecordPrompts } from "./EditRecordPrompts";
import { EditSendTo } from "./EditSendTo";
import { EditSidePanel, type EditSideTab } from "./EditSidePanel";
import { EditSourceHost } from "./EditSourceHost";
import { EditSplits } from "./EditSplits";
import { EditStripSilence } from "./EditStripSilence";
import type { EditTextStyle } from "./EditTextSettings";
import type { EditTimelineAudio } from "./EditTimelineTools";
import { EditToolbar } from "./EditToolbar";
import { EditTranscript } from "./EditTranscript";
import { TIMELINE_MAX_PX_PER_FRAME, TIMELINE_MIN_PX_PER_FRAME, TIMELINE_PX_PER_FRAME } from "../lib/edit-timeline-scale";

type Props = {
  editId: string; head: EditHead; open: OpenEdit; history: EditHistory | null; data: EditSourceData; active: boolean;
  /** View ▸ Waveforms: the sources hook builds a mic's waveform only while this is on. */
  waveforms: boolean; onWaveforms: (on: boolean) => void;
  /** People whose waveform is on, and the switch for some (all: every track, as ⌥-click in Avid). */
  waveLanes: ReadonlySet<string>; onWave: (lanes: string[], all: boolean) => void;
  commit: (label: string, change: (open: OpenEdit) => EditChange, group?: string | null) => Promise<boolean>;
  undo: () => void; redo: () => void; jump: (state: number) => void; pin: (state: number, name: string | null) => void; onClose: () => void; addSource: React.ReactNode;
  onOpenEdit: (id: string) => void; onSettings: () => void; appLocalModelId: string | null | undefined;
  /** AAF Audio's In and Out, carried by "Open in String Outs" into the source made from that sequence. */
  sourceMarks?: EditSourceMarks | null;
};

/** Well-separated hues from the transcript palette, in lane order. */
const HUES = [0, 2, 5, 8, 10, 4, 11, 1, 6, 9, 3, 7];
const toggled = <T,>(set: ReadonlySet<T>, item: T) => { const next = new Set(set); if (!next.delete(item)) next.add(item); return next; };

/** The Transcript Editor on one open edit: source, record, history and timeline. */
export function EditEditor({ editId, head, open, history, data, active, waveforms, onWaveforms, waveLanes, onWave, commit, undo, redo, jump, pin, onClose, addSource, onOpenEdit, onSettings, appLocalModelId, sourceMarks }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const document = open.document, fps = rateOf(document.edit_rate), recordStart = document.start_timecode_frames;
  // Everyone, for Ask and the source pane; the people on a track (all but a
  // group angle not yet given one) for what plays, shows and exports.
  const people: TimelineLane[] = useMemo(() => peopleOf(document.tracks), [document.tracks]);
  const lanes = useMemo(() => people.filter((lane) => lane.track > 0), [people]);
  const colors = useMemo(() => laneColors(document.tracks.filter((track) => track.kind === "sound"), document.sources, data.documents, (index) => SPEAKER_PALETTE[HUES[index % HUES.length]]), [document.tracks, document.sources, data.documents]);
  const sourceLanes = useMemo(() => Object.fromEntries(document.sources.map((source) => [source.id, document.tracks.filter((track) => onTrack(track) && track.source_tracks[source.id]).map((track) => track.id)])), [document]);
  const heard = useMemo(() => new Set(lanes.map((lane) => lane.id)), [lanes]);
  const trackWords = useMemo(() => data.words.filter((word) => heard.has(word.track)), [data.words, heard]);
  const infos = useMemo(() => document.sources.map((source) => ({ id: source.id, short: source.name, duration: data.durations[source.id] ?? 0,
    startFrames: data.documents.get(source.id)?.manifest.start_frame ?? 0 })), [document.sources, data]);
  const [showSource, setShowSource] = useState(true), [showSide, setShowSide] = useState(true), [sideTab, setSideTab] = useState<EditSideTab>("ask"), [showRemoved, setShowRemoved] = useState(true);
  const [snap, setSnap] = useState(true), [follow, setFollow] = useState(true), [loop, setLoop] = useState(false);
  /** The record timeline's tool in hand, as Neo's palette (⇧A, C, N, Y, R). */
  const [tool, setTool] = useState<RecordTool>("select");
  // The timeline's scale and scroll, kept for Record and Source apart as Avid and Neo keep them: showing the
  // source and coming back leaves the record where it was. The source opens fitted (0) until zoomed.
  const [zooms, setZooms] = useState<Record<"record" | "source", number>>({ record: TIMELINE_PX_PER_FRAME, source: 0 });
  const [pans, setPans] = useState<Record<"record" | "source", number>>({ record: 0, source: 0 });
  const fit = useRef(() => TIMELINE_PX_PER_FRAME);
  const zoomBy = (direction: -1 | 0 | 1) => setZooms((state) => {
    const now = state[side.mode] > 0 ? state[side.mode] : fit.current();
    return { ...state, [side.mode]: direction === 0 ? fit.current() : Math.max(TIMELINE_MIN_PX_PER_FRAME, Math.min(TIMELINE_MAX_PX_PER_FRAME, direction > 0 ? now * 2 : now / 2)) };
  });
  const [audio, setAudio] = useState<EditTimelineAudio>({ crossfade: 2 }), [inSource, setInSource] = useState(false), [stripping, setStripping] = useState(false);
  const [text, setText] = useState<Record<"source" | "edit", EditTextStyle>>({ source: { family: "sans", size: 13, leading: "normal" }, edit: { family: "sans", size: 15, leading: "normal" } });
  // Solo and mute are record tracks (1 for A1), as in Avid: they silence whoever is on the track, where they are on it.
  const [solo, setSolo] = useState<ReadonlySet<number>>(new Set()), [mute, setMute] = useState<ReadonlySet<number>>(new Set());
  const sourceFrames = useMemo(() => Object.fromEntries(Object.entries(data.durations).map(([id, seconds]) => [id, Math.round(seconds * fps)])), [data.durations, fps]);
  const audible = lanes.map((lane) => lane.id);
  // Every track a record can have (Media Composer's 64), so a solo silences the tracks made after it too.
  const quiet = useMemo(() => Array.from({ length: 64 }, (_, index) => index + 1).filter((layer) => solo.size ? !solo.has(layer) : mute.has(layer)), [solo, mute]);
  const playback = useEditPlayback({ document: head.document, audible, quiet, active, sourceFrames, joinFade: audio.crossfade / fps });
  useEditPipeline({ editId, head, history, data, waveforms, inSource, playback });
  // The playhead is `playback.frames`, read by what draws it: playing does not re-render the editor.
  const seek = (seconds: number) => void playback.seek(Math.max(0, Math.round(seconds * fps)));
  const tc = (seconds: number) => editTc(seconds, fps, recordStart);
  const sourceTc = (source: string, seconds: number) => editTc(seconds, fps, infos.find((info) => info.id === source)?.startFrames ?? 0);
  const nameOf = (id: string) => people.find((lane) => lane.id === id)?.name ?? id, sourceName = (id: string) => document.sources.find((source) => source.id === id)?.name ?? "Gap";
  const ws = useEditWorkspace({ open, words: trackWords, everyone: data.words, lanes, sourceLanes, durations: data.durations, audible: data.audible, frames: playback.frames, seek, commit, nameOf, tc, snap, fps });
  /** Audio ▸ Stack Conversations, as one undo step. */
  const stack = async () => {
    let stacked = 0;
    const done = await commit("Stack Conversations", (state) => {
      const result = stackConversations(toDocument(state.document, state.timeline, state.markers), data.words, data.durations, stringoutDefaults.join);
      stacked = result.stacked;
      if (!stacked) return null;
      const opened = fromDocument(result.document);
      return { document: result.document, timeline: opened.timeline, markers: opened.markers };
    });
    if (!stacked) ws.setMessage("Nothing to stack: no two clips here run on from each other in one source, and nobody else talks inside one.");
    else if (done) ws.setMessage(`Stacked ${stacked} ${stacked === 1 ? "conversation" : "conversations"}: everyone in each one plays on their own track, in sync. ⌘Z undoes it.`);
  };
  /** Audio ▸ Focus on Marked Lines, as one undo step. */
  const focus = async () => {
    let clips = 0;
    const done = await commit("Focus on Marked Lines", (state) => {
      const result = focusOnMarkers(toDocument(state.document, state.timeline, state.markers));
      clips = result.clips;
      if (!clips) return null;
      const opened = fromDocument(result.document);
      return { document: result.document, timeline: opened.timeline, markers: opened.markers };
    });
    if (!clips) ws.setMessage("Nothing to focus: no clip here has a marker on a person and anyone else open beside them.");
    else if (done) ws.setMessage(`Focused ${clips} ${clips === 1 ? "clip" : "clips"} on the people their markers name. Everyone else in them is muted; right-click a muted line and choose Unmute to bring it back, and ⌘Z undoes it.`);
  };
  const side = useEditSourceSide({ document: head.document, sources: infos, documents: data.documents, words: data.words, colors, fps, active, request: sourceMarks });
  /** Insert, Append or Overwrite what the source has marked, text or In to Out, with the mics its track selectors allow. */
  // Who is on each record track anywhere in the edit: W draws their waveforms, and Strip Silence works on them.
  const lanesOn = useMemo(() => {
    const out = new Map<number, string[]>();
    for (let layer = 1; layer <= ws.layerTotal; layer++) out.set(layer, [...new Set(layerClips(ws.edit, layer, ws.layering).map((clip) => clip.lane))]);
    return out;
  }, [ws.edit, ws.layering, ws.layerTotal]);
  const waves = useMemo(() => new Set([...lanesOn].filter(([, on]) => on.length > 0 && on.every((lane) => waveLanes.has(lane))).map(([layer]) => layer)), [lanesOn, waveLanes]);
  const waveOn = (layer: number, all: boolean) => onWave(lanesOn.get(layer) ?? [], all);
  const placeFromSource = (how: "insert" | "append" | "overwrite") => { const take = side.take(); if (!take) return;
    if (how === "overwrite") ws.overwrite(take.source, take.words, take); else ws.insert(take.source, take.words, how === "append", take); focusDoc(); };
  const used = useMemo(() => new Set(ws.placed.map((item) => item.word.id)), [ws.placed]);
  const focusDoc = () => requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(".cp-te-doc")?.focus());
  // The source's Play and timecode are in its pane, so showing the source in the timeline shows the pane too.
  const switchMode = (mode: "source" | "record") => { if (mode === "source") setShowSource(true); side.setMode(mode); };
  /** Match Frame (⇧F): the record clip under the playhead, opened in the source on the same frame with an In there. */
  const matchFrame = () => {
    const target = ws.matchTarget();
    if (!target) return;
    if (!side.match(target)) return ws.setMessage(`${sourceName(target.source)} is not loaded as a source here.`);
    setShowSource(true);
    ws.setMessage(`Matched ${nameOf(target.lane)} in ${sourceName(target.source)}, with an In on that frame. V or B cuts more of it onto A${target.layer}.`);
  };
  useEditEditorKeys({ root, active, fps, ws, side, playback, undo, redo, onHistory: () => { setShowSide(true); setSideTab("history"); }, loop, onLoop: () => setLoop((value) => !value),
    onZoom: zoomBy, place: placeFromSource, onMode: switchMode, onTool: setTool, onMatchFrame: matchFrame });
  /** A cited line: selected and played in the string out when it is there, otherwise opened in the source, ready to cut in. */
  const jumpTo = (line: AskCitation) => {
    const indexes = ws.placed.flatMap((item, index) => line.wordIds.includes(item.word.id) ? [index] : []);
    if (!indexes.length && side.reveal(line)) { setShowSource(true); return ws.setMessage(`${nameOf(line.track)}'s line is selected in the source. Insert (V) cuts it in.`); }
    if (!indexes.length) return ws.setMessage(`Not in this string out. ${nameOf(line.track)} says it in ${sourceName(line.source)}.`);
    ws.setSelection({ anchor: indexes[0], focus: indexes[indexes.length - 1], collapsed: false });
    seek(ws.placed[indexes[0]].programStart);
    focusDoc();
  };
  const seamInfo = Object.fromEntries(ws.seams.map((item) => [item.index, { kind: item.kind, seconds: item.kind === "cut" ? item.gap : null }]));
  const sources = document.sources.map((source) => source.name).join(" · ");
  return <div ref={root} className="cp-te" data-testid="transcript-editor">
    <EditToolbar title={document.title} subtitle={sources || "Empty string out"} source={showSource} onSource={() => setShowSource((value) => !value)}
      side={showSide} onSide={() => setShowSide((value) => !value)} showRemoved={showRemoved} onShowRemoved={() => setShowRemoved((value) => !value)}
      undo={head.undo} redo={head.redo} onUndo={undo} onRedo={redo} onClose={onClose}>
      <EditSendTo editId={editId} selected={ws.selected} sequenceOf={(source) => data.documents.get(source)} onDone={ws.setMessage} />
      {addSource}
      <EditExportButton editId={editId} title={document.title} disabled={!document.segments.some((segment) => segment.kind === "source")} onDone={ws.setMessage} />
    </EditToolbar>
    {data.errors.length > 0 && <p className="cp-te-errors" role="alert">{data.errors.join(" · ")}</p>}
    <div className="cp-te-panes">
      {/* Hidden rather than unmounted: an Ask answer in flight keeps going. */}
      <div className="cp-te-pane cp-te-pane-side" hidden={!showSide}>
        <EditSidePanel editId={editId} document={head.document} words={data.words} used={used} lengths={data.durations} lanes={people} colors={colors} ws={ws}
          tab={sideTab} onTab={setSideTab} history={history} jump={jump} pin={pin} commit={commit} tc={tc} sourceName={sourceName} nameOf={nameOf}
          where={(line) => `${sourceName(line.source)} · ${nameOf(line.track)} · ${sourceTc(line.source, line.from)}`} sourceTc={sourceTc}
          onJump={jumpTo} onOpenEdit={onOpenEdit} onSettings={onSettings} appLocalModelId={appLocalModelId} />
      </div>
      {/* The side Space, I, O and the marks act on is lifted, as Avid lights the active monitor. */}
      {showSource && <div className={`cp-te-pane cp-te-pane-source${inSource || side.mode === "source" ? " is-active" : " is-idle"}`}
        onFocus={() => setInSource(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setInSource(false); }}>
        <EditSourceHost side={side} lanes={people} colors={colors} fps={fps} used={used} reading={data.read}
          text={text.source} onText={(style) => setText((state) => ({ ...state, source: style }))} onPlace={placeFromSource} />
      </div>}
      <div className={`cp-te-pane cp-te-pane-record${showSource && (inSource || side.mode === "source") ? " is-idle" : " is-active"}`}>
        <EditRecordPane frames={playback.frames} fps={fps} total={ws.total} tc={tc} totalTc={tc(ws.total)} marks={ws.seams.map((item) => item.at)}
          playing={playback.playing} busy={playback.busy} onToggle={() => void playback.toggle()} onStart={() => seek(0)} status={ws.message}
          onScrub={seek} onScrubStart={playback.pause} onScrubEnd={() => undefined} text={text.edit} onText={(style) => setText((state) => ({ ...state, edit: style }))}>
          {data.loading && !ws.placed.length ? <p className="cp-te-doc-empty" role="status">Reading each microphone's words…</p>
            : <EditTranscript hasCut={ws.total > 0} speakers={lanes} colors={colors} fps={fps} recordStart={recordStart} paragraphs={ws.paras} placed={ws.placed} selection={ws.selection} frames={playback.frames}
              sourceLabel={sourceName} seams={seamInfo} seam={ws.seam} onSeam={ws.chooseSeam} ghosts={showRemoved ? ws.ghosts : null} onRestore={ws.restore}
              corrections={{}} editing={null} onCorrect={() => undefined}
              onSelect={(selection, seekTo) => { ws.setSelection(selection); if (seekTo) seek(selection.anchor < ws.count ? ws.placed[selection.anchor].programStart : ws.total); }}
              onDelete={ws.remove} onScrub={seek} onMove={ws.move} onEdit={() => ws.setMessage("Correct words in AAF Audio's transcript; the string out follows it.")} />}
          <EditRecordPrompts ws={ws} onDone={focusDoc} />
        </EditRecordPane>
      </div>
      <EditSplits side={showSide} source={showSource} />
    </div>
    <EditLower ws={ws} side={side} nameOf={nameOf} solo={solo} mute={mute} onSolo={(layer) => setSolo((state) => toggled(state, layer))} onMute={(layer) => setMute((state) => toggled(state, layer))} onMarker={(id) => { ws.setMarker(id); const at = ws.markers.find((item) => item.id === id)?.at; if (at != null) seek(at); setShowSide(true); setSideTab("inspector"); }} colors={colors} fps={fps} recordStart={recordStart} frames={playback.frames}
      onSeek={seek} onScrubStart={playback.pause} onScrubEnd={() => undefined}
      sourceName={sourceName} onMode={switchMode} onStripSilence={() => setStripping(true)} onStackConversations={() => void stack()} onFocusMarked={() => void focus()} onMatchFrame={matchFrame}
      sourceLanes={sourceLanes} peaksOf={(source, lane) => data.peaks.get(`${source}:${lane}`)} detail={data.detail} durationOf={(source) => data.durations[source] ?? 0}
      waveforms={waveforms} onWaveforms={onWaveforms} waves={waves} onWave={waveOn} measured={data.measured} measuring={data.measuring} stalled={waveforms && !data.loading && !data.measuring && !data.measured}
      tool={tool} onTool={setTool} audio={audio} onAudio={setAudio} zoom={zooms[side.mode]} onZoom={zoomBy} fit={fit} pan={pans[side.mode]} onPan={(pan) => setPans((state) => ({ ...state, [side.mode]: pan }))} snap={snap} onSnap={() => setSnap((value) => !value)} follow={follow} onFollow={() => setFollow((value) => !value)} loop={loop} onLoop={() => setLoop((value) => !value)} />
    {stripping && <EditStripSilence open={open} documents={data.documents} words={data.words} commit={commit} nameOf={nameOf} onDone={ws.setMessage} onClose={() => setStripping(false)}
      request={{ from: ws.marked?.[0] ?? 0, to: ws.marked?.[1] ?? ws.total, layers: [...ws.onTracks], layering: ws.layering }}
      scope={`${[...ws.onTracks].sort((a, b) => a - b).map((layer) => `A${layer}`).join(", ") || "No track selected"} · ${ws.marked ? `${tc(ws.marked[0])} to ${tc(ws.marked[1])}` : "the whole string out"}`}
      hint={data.measured ? undefined : data.measuring ? "Waiting for every mic's waveform" : "Turn on View ▸ Waveforms to measure each mic first"} />}
  </div>;
}
