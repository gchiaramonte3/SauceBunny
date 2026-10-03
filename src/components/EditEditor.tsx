import { useMemo, useRef, useState } from "react";
import type { EditHead } from "../bindings/EditHead";
import type { EditHistory } from "../bindings/EditHistory";
import { useEditEditorKeys } from "../hooks/use-edit-editor-keys";
import { useEditPlayback } from "../hooks/use-edit-playback";
import { useEditSourceSide, type EditSourceMarks } from "../hooks/use-edit-source-side";
import type { EditChange } from "../hooks/use-edit-session";
import type { EditSourceData } from "../hooks/use-edit-sources";
import { useEditWorkspace } from "../hooks/use-edit-workspace";
import { editTc, fps as rateOf, type OpenEdit } from "../lib/edit-document";
import type { AskCitation } from "../lib/edit-ask";
import type { TimelineLane } from "../lib/edit-model";
import { onTrack, peopleOf } from "../lib/edit-new";
import { laneColors, pictureBlocks } from "../lib/edit-source-view";
import { SPEAKER_PALETTE } from "./transcript/helpers";
import { EditExportButton } from "./EditExportButton";
import { EditLower } from "./EditLower";
import { EditOvertalkPrompt } from "./EditOvertalkPrompt";
import { EditRecordPane } from "./EditRecordPane";
import { EditSendTo } from "./EditSendTo";
import { EditSidePanel, type EditSideTab } from "./EditSidePanel";
import { EditSourceHost } from "./EditSourceHost";
import { EditStripSilence } from "./EditStripSilence";
import type { EditTextStyle } from "./EditTextSettings";
import type { EditTimelineAudio } from "./EditTimelineTools";
import { EditToolbar } from "./EditToolbar";
import { EditTranscript } from "./EditTranscript";

type Props = {
  editId: string; head: EditHead; open: OpenEdit; history: EditHistory | null; data: EditSourceData; active: boolean;
  /** View ▸ Waveforms: the sources hook builds a mic's waveform only while this is on. */
  waveforms: boolean; onWaveforms: (on: boolean) => void;
  commit: (label: string, change: (open: OpenEdit) => EditChange, group?: string | null) => Promise<boolean>;
  undo: () => void; redo: () => void; jump: (state: number) => void; pin: (state: number, name: string | null) => void; onClose: () => void; addSource: React.ReactNode;
  onOpenEdit: (id: string) => void; onSettings: () => void; appLocalModelId: string | null | undefined;
  /** AAF Audio's In and Out, carried by "Open in String Outs" into the source made from that sequence. */
  sourceMarks?: EditSourceMarks | null;
};

/** Well-separated hues from the transcript palette, in lane order. */
const HUES = [0, 2, 5, 8, 10, 4, 11, 1, 6, 9, 3, 7];
const toggled = (set: Set<string>, item: string) => { const next = new Set(set); if (!next.delete(item)) next.add(item); return next; };

/** The Transcript Editor on one open edit: source, record, history and timeline. */
export function EditEditor({ editId, head, open, history, data, active, waveforms, onWaveforms, commit, undo, redo, jump, pin, onClose, addSource, onOpenEdit, onSettings, appLocalModelId, sourceMarks }: Props) {
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
  const [zoom, setZoom] = useState(1), [snap, setSnap] = useState(true), [follow, setFollow] = useState(true), [loop, setLoop] = useState(false);
  const [audio, setAudio] = useState<EditTimelineAudio>({ crossfade: 2 }), [inSource, setInSource] = useState(false), [stripping, setStripping] = useState(false);
  const [text, setText] = useState<Record<"source" | "edit", EditTextStyle>>({ source: { family: "sans", size: 13, leading: "normal" }, edit: { family: "sans", size: 15, leading: "normal" } });
  const [solo, setSolo] = useState<Set<string>>(new Set()), [mute, setMute] = useState<Set<string>>(new Set());
  const sourceFrames = useMemo(() => Object.fromEntries(Object.entries(data.durations).map(([id, seconds]) => [id, Math.round(seconds * fps)])), [data.durations, fps]);
  // Only people with a track can be soloed: one who loses theirs takes their solo with them.
  const soloed = useMemo(() => new Set([...solo].filter((id) => heard.has(id))), [solo, heard]);
  const audible = lanes.filter((lane) => (soloed.size ? soloed.has(lane.id) : !mute.has(lane.id))).map((lane) => lane.id);
  const playback = useEditPlayback({ document: head.document, audible, active, sourceFrames, joinFade: audio.crossfade / fps });
  const playhead = playback.frame / fps, seek = (seconds: number) => void playback.seek(Math.max(0, Math.round(seconds * fps)));
  const tc = (seconds: number) => editTc(seconds, fps, recordStart);
  const sourceTc = (source: string, seconds: number) => editTc(seconds, fps, infos.find((info) => info.id === source)?.startFrames ?? 0);
  const nameOf = (id: string) => people.find((lane) => lane.id === id)?.name ?? id, sourceName = (id: string) => document.sources.find((source) => source.id === id)?.name ?? "Gap";
  const ws = useEditWorkspace({ open, words: trackWords, everyone: data.words, lanes, sourceLanes, durations: data.durations, audible: data.audible, playhead, seek, commit, nameOf, tc, documents: data.documents, snap, fps });
  const side = useEditSourceSide({ document: head.document, sources: infos, documents: data.documents, words: data.words, colors, fps, active, request: sourceMarks });
  /** Insert, Append or Overwrite what the source has marked, text or In to Out, with the mics its track selectors allow. */
  const placeFromSource = (how: "insert" | "append" | "overwrite") => { const take = side.take(); if (!take) return;
    if (how === "overwrite") ws.overwrite(take.source, take.words, take); else ws.insert(take.source, take.words, how === "append", take); focusDoc(); };
  const used = useMemo(() => new Set(ws.placed.map((item) => item.word.id)), [ws.placed]);
  const current = ws.placed.find((item) => item.programStart <= playhead && playhead < item.programEnd);
  const focusDoc = () => requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(".cp-te-doc")?.focus());
  const previous = [...ws.seams].reverse().find((item) => item.at < playhead - 1e-3), next = ws.seams.find((item) => item.at > playhead + 1e-3);
  useEditEditorKeys({ root, active, fps, ws, side, playback, undo, redo, onHistory: () => { setShowSide(true); setSideTab("history"); }, loop, onLoop: () => setLoop((value) => !value),
    onZoom: setZoom, onSnap: () => setSnap((value) => !value), place: placeFromSource, previous: previous?.index ?? null, next: next?.index ?? null });
  const pictureOf = useMemo(() => pictureBlocks(document.sources, data.documents, fps), [document.sources, data.documents, fps]);
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
        <EditRecordPane playhead={playhead} total={ws.total} tc={tc(playhead)} totalTc={tc(ws.total)} marks={ws.seams.map((item) => item.at)}
          onScrub={seek} onScrubStart={playback.pause} onScrubEnd={() => undefined} text={text.edit} onText={(style) => setText((state) => ({ ...state, edit: style }))}>
          {data.loading && !ws.placed.length ? <p className="cp-te-doc-empty" role="status">Reading each microphone's words…</p>
            : <EditTranscript hasCut={ws.total > 0} speakers={lanes} colors={colors} fps={fps} recordStart={recordStart} paragraphs={ws.paras} placed={ws.placed} selection={ws.selection} current={current ? `${current.segment}:${current.word.id}` : null}
              sourceLabel={sourceName} seams={seamInfo} seam={ws.seam} onSeam={ws.chooseSeam} ghosts={showRemoved ? ws.ghosts : null} onRestore={ws.restore}
              corrections={{}} editing={null} onCorrect={() => undefined}
              onSelect={(selection, seekTo) => { ws.setSelection(selection); if (seekTo) seek(selection.anchor < ws.count ? ws.placed[selection.anchor].programStart : ws.total); }}
              onDelete={ws.remove} onScrub={seek} onMove={ws.move} onEdit={() => ws.setMessage("Correct words in AAF Audio's transcript; the string out follows it.")} />}
          {ws.prompt && <EditOvertalkPrompt title={`${ws.names(ws.prompt.result.crosstalk.map((word) => word.track))} talks under this.`}
            body={`Silenced ${ws.names(ws.prompt.who)} only. Cutting for everyone also removes ${ws.prompt.result.crosstalk.length === 1 ? "one word" : `${ws.prompt.result.crosstalk.length} words`} of ${ws.names(ws.prompt.result.crosstalk.map((word) => word.track))}'s.`}
            keep="Keep" other="Cut for everyone" onKeep={() => { ws.setPrompt(null); focusDoc(); }} onDismiss={() => { ws.setPrompt(null); focusDoc(); }} onOther={() => ws.prompt && ws.applyDelete(ws.prompt.keys, ws.prompt.count)} />}
          {ws.extractGuard && <EditOvertalkPrompt title={`${ws.names(ws.extractGuard.who)} ${ws.extractGuard.who.length > 1 ? "talk" : "talks"} in this range.`}
            body={`Extract closes the range up on every track, so ${ws.extractGuard.count === 1 ? "one word" : `${ws.extractGuard.count} words`} on a track that is not selected would go too. Lift takes it off the selected tracks only.`}
            keep="Lift selected tracks" other="Extract anyway" onKeep={() => ws.takeMarked(false)} onDismiss={() => { ws.setExtractGuard(null); focusDoc(); }} onOther={() => ws.takeMarked(true, true)} />}
        </EditRecordPane>
      </div>
    </div>
    <EditLower ws={ws} side={side} people={people} solo={soloed} mute={mute} onSolo={(id) => setSolo((state) => toggled(state, id))} onMute={(id) => setMute((state) => toggled(state, id))} onUntrack={ws.untrack} onMarker={(id) => { ws.setMarker(id); const at = ws.markers.find((item) => item.id === id)?.at; if (at != null) seek(at); setShowSide(true); setSideTab("inspector"); }} lanes={lanes} colors={colors} fps={fps} recordStart={recordStart} playhead={playhead} playing={playback.playing} busy={playback.busy}
      onToggle={() => void playback.toggle()} onSeek={seek} onScrubStart={playback.pause} onScrubEnd={() => undefined}
      tc={tc} sourceTc={sourceTc} sourceName={sourceName} onStripSilence={() => setStripping(true)}
      sourceLanes={sourceLanes} peaksOf={(source, lane) => data.peaks.get(`${source}:${lane}`)} durationOf={(source) => data.durations[source] ?? 0} pictureOf={pictureOf}
      waveforms={waveforms} onWaveforms={onWaveforms} measured={data.measured} measuring={data.measuring} stalled={waveforms && !data.loading && !data.measuring && !data.measured}
      audio={audio} onAudio={setAudio} zoom={zoom} onZoom={setZoom} snap={snap} onSnap={() => setSnap((value) => !value)} follow={follow} onFollow={() => setFollow((value) => !value)} loop={loop} onLoop={() => setLoop((value) => !value)} />
    {stripping && <EditStripSilence open={open} documents={data.documents} words={data.words} commit={commit} nameOf={nameOf} onDone={ws.setMessage} onClose={() => setStripping(false)}
      request={{ from: ws.marked?.[0] ?? 0, to: ws.marked?.[1] ?? ws.total, lanes: lanes.filter((lane) => ws.onTracks.has(lane.id)).map((lane) => lane.id), sourceLanes }}
      scope={`${lanes.filter((lane) => ws.onTracks.has(lane.id)).map((lane) => `A${lane.track} ${lane.name}`).join(", ") || "No track selected"} · ${ws.marked ? `${tc(ws.marked[0])} to ${tc(ws.marked[1])}` : "the whole string out"}`}
      hint={data.measured ? undefined : data.measuring ? "Waiting for every mic's waveform" : "Turn on View ▸ Waveforms to measure each mic first"} />}
  </div>;
}
