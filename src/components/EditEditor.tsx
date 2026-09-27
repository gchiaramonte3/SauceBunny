import { useEffect, useMemo, useRef, useState } from "react";
import type { EditHead } from "../bindings/EditHead";
import type { EditHistory } from "../bindings/EditHistory";
import { useEditKeys } from "../hooks/use-edit-keys";
import { useEditPlayback } from "../hooks/use-edit-playback";
import type { EditChange } from "../hooks/use-edit-session";
import type { EditSourceData } from "../hooks/use-edit-sources";
import { useEditWorkspace } from "../hooks/use-edit-workspace";
import { editTc, fps as rateOf, type OpenEdit } from "../lib/edit-document";
import type { TimelineLane } from "../lib/edit-model";
import { SPEAKER_PALETTE } from "./transcript/helpers";
import { EditExportButton } from "./EditExportButton";
import { EditHistoryPanel } from "./EditHistoryPanel";
import { EditLower } from "./EditLower";
import { EditOvertalkPrompt } from "./EditOvertalkPrompt";
import { EditRecordPane } from "./EditRecordPane";
import { EditSendTo } from "./EditSendTo";
import { EditSourceHost } from "./EditSourceHost";
import type { EditTextStyle } from "./EditTextSettings";
import { EditToolbar } from "./EditToolbar";
import { EditTranscript } from "./EditTranscript";

type Props = {
  editId: string; head: EditHead; open: OpenEdit; history: EditHistory | null; data: EditSourceData; active: boolean;
  commit: (label: string, change: (open: OpenEdit) => EditChange, group?: string | null) => Promise<unknown>;
  undo: () => void; redo: () => void; jump: (state: number) => void; pin: (state: number, name: string | null) => void; onClose: () => void; addSource: React.ReactNode;
};

/** Well-separated hues from the transcript palette, in lane order. */
const HUES = [0, 2, 5, 8, 10, 4, 11, 1, 6, 9, 3, 7];
const toggled = (set: Set<string>, item: string) => { const next = new Set(set); if (!next.delete(item)) next.add(item); return next; };

/** The Transcript Editor on one open edit: source, record, history and timeline. */
export function EditEditor({ editId, head, open, history, data, active, commit, undo, redo, jump, pin, onClose, addSource }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const document = open.document, fps = rateOf(document.edit_rate), recordStart = document.start_timecode_frames;
  const lanes: TimelineLane[] = useMemo(() => document.tracks.filter((track) => track.kind === "sound").map((track, index) => ({ id: track.id, name: track.name, track: index + 1 })), [document.tracks]);
  const colors = useMemo(() => Object.fromEntries(lanes.map((lane, index) => [lane.id, SPEAKER_PALETTE[HUES[index % HUES.length]]])), [lanes]);
  const sourceLanes = useMemo(() => Object.fromEntries(document.sources.map((source) => [source.id, document.tracks.filter((track) => track.source_tracks[source.id]).map((track) => track.id)])), [document]);
  const infos = useMemo(() => document.sources.map((source) => ({ id: source.id, short: source.name, duration: data.durations[source.id] ?? 0,
    startFrames: data.documents.get(source.id)?.manifest.start_frame ?? 0 })), [document.sources, data]);
  const [showSource, setShowSource] = useState(true), [showHistory, setShowHistory] = useState(false), [showRemoved, setShowRemoved] = useState(true);
  const [zoom, setZoom] = useState(1), [snap, setSnap] = useState(true), [follow, setFollow] = useState(true), [loop, setLoop] = useState(false);
  const [text, setText] = useState<Record<"source" | "edit", EditTextStyle>>({ source: { family: "sans", size: 13, leading: "normal" }, edit: { family: "sans", size: 15, leading: "normal" } });
  const [solo, setSolo] = useState<Set<string>>(new Set()), [mute, setMute] = useState<Set<string>>(new Set());
  const sourceFrames = useMemo(() => Object.fromEntries(Object.entries(data.durations).map(([id, seconds]) => [id, Math.round(seconds * fps)])), [data.durations, fps]);
  const audible = lanes.filter((lane) => (solo.size ? solo.has(lane.id) : !mute.has(lane.id))).map((lane) => lane.id);
  const playback = useEditPlayback({ document: head.document, audible, active, sourceFrames });
  const playhead = playback.frame / fps;
  const seek = (seconds: number) => void playback.seek(Math.max(0, Math.round(seconds * fps)));
  const tc = (seconds: number) => editTc(seconds, fps, recordStart);
  const nameOf = (id: string) => lanes.find((lane) => lane.id === id)?.name ?? id;
  const sourceName = (id: string) => document.sources.find((source) => source.id === id)?.name ?? "Gap";
  const ws = useEditWorkspace({ open, words: data.words, lanes, sourceLanes, durations: data.durations, audible: data.audible, playhead, seek, commit, nameOf, tc });
  const used = useMemo(() => new Set(ws.placed.map((item) => item.word.id)), [ws.placed]);
  const current = ws.placed.find((item) => item.programStart <= playhead && playhead < item.programEnd);
  const focusDoc = () => requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(".cp-te-doc")?.focus());
  const previous = [...ws.seams].reverse().find((item) => item.at < playhead - 1e-3), next = ws.seams.find((item) => item.at > playhead + 1e-3);

  // Loop: in to out when marked, else the whole edit, by seeking back at the end.
  const [loopFrom, loopTo] = ws.marked ?? [0, ws.total];
  useEffect(() => { if (loop && playback.playing && playhead >= loopTo - 1 / fps) void playback.seek(Math.round(loopFrom * fps), true); }, [loop, playback, playhead, loopFrom, loopTo, fps]);

  useEditKeys(root, active, {
    toggle: () => void playback.toggle(), undo, redo, history: () => setShowHistory((value) => !value), start: () => seek(0),
    cutHere: ws.cutHere, loop: () => setLoop((value) => !value), zoomIn: () => setZoom((z) => Math.min(32, z * 2)), zoomOut: () => setZoom((z) => Math.max(1, z / 2)), zoomFit: () => setZoom(1),
    clearMarks: () => ws.setMarks({ in: null, out: null }),
    escape: () => { if (ws.dead) { ws.setDead(null); return true; } if (ws.prompt) { ws.setPrompt(null); return true; } return false; },
    markIn: ws.markIn, markOut: ws.markOut, lift: () => ws.takeMarked(false), extract: () => ws.takeMarked(true), marker: ws.addMarker, markClip: ws.markClip,
    snap: () => setSnap((value) => !value), previous: () => previous && ws.chooseSeam(previous.index), next: () => next && ws.chooseSeam(next.index),
    insert: () => root.current?.querySelector<HTMLButtonElement>(".cp-te-src-actions button")?.click(),
  });

  const pictureOf = useMemo(() => {
    const bySource = new Map(document.sources.map((source) => {
      const tracks = data.documents.get(source.id)?.manifest.graph?.picture_tracks ?? [];
      const v1 = tracks.find((track) => track.physical_track_number === 1 && track.clips.length) ?? tracks.find((track) => track.clips.length);
      return [source.id, (v1?.clips ?? []).map((clip) => ({ from: clip.start_frame / fps, to: (clip.start_frame + clip.duration_frames) / fps, clip }))];
    }));
    return (source: string) => bySource.get(source) ?? [];
  }, [document.sources, data.documents, fps]);
  const seamInfo = Object.fromEntries(ws.seams.map((item) => [item.index, { kind: item.kind, seconds: item.kind === "cut" ? item.gap : null }]));
  const sources = document.sources.map((source) => source.name).join(" · ");
  return <div ref={root} className="cp-te" data-testid="transcript-editor">
    <EditToolbar title={document.title} subtitle={sources || "Empty edit"} source={showSource} onSource={() => setShowSource((value) => !value)}
      history={showHistory} onHistory={() => setShowHistory((value) => !value)} showRemoved={showRemoved} onShowRemoved={() => setShowRemoved((value) => !value)}
      undo={head.undo} redo={head.redo} onUndo={undo} onRedo={redo} onClose={onClose}>
      <EditSendTo editId={editId} selected={ws.selected.map((item) => item.word)} sequenceOf={(source) => data.documents.get(source)} onDone={ws.setMessage} />
      {addSource}
      <EditExportButton editId={editId} title={document.title} disabled={!document.segments.some((segment) => segment.kind === "source")} onDone={ws.setMessage} />
    </EditToolbar>
    {data.errors.length > 0 && <p className="cp-te-errors" role="alert">{data.errors.join(" · ")}</p>}
    <div className="cp-te-panes">
      {showSource && <div className="cp-te-pane cp-te-pane-source">
        <EditSourceHost document={head.document} sources={infos} lanes={lanes} colors={colors} fps={fps} words={data.words} used={used} active={active}
          text={text.source} onText={(style) => setText((state) => ({ ...state, source: style }))} onInsert={(source, words, atEnd) => { ws.insert(source, words, atEnd); focusDoc(); }} />
      </div>}
      <div className="cp-te-pane cp-te-pane-record">
        <EditRecordPane playhead={playhead} total={ws.total} tc={tc(playhead)} totalTc={tc(ws.total)} marks={ws.seams.map((item) => item.at)}
          onScrub={seek} onScrubStart={playback.pause} onScrubEnd={() => undefined} text={text.edit} onText={(style) => setText((state) => ({ ...state, edit: style }))}>
          {data.loading && !ws.placed.length ? <p className="cp-te-doc-empty" role="status">Reading each microphone's words…</p>
            : <EditTranscript speakers={lanes} colors={colors} fps={fps} recordStart={recordStart} paragraphs={ws.paras} placed={ws.placed} selection={ws.selection} current={current ? `${current.segment}:${current.word.id}` : null}
              sourceLabel={sourceName} seams={seamInfo} seam={ws.seam} onSeam={ws.chooseSeam} ghosts={showRemoved ? ws.ghosts : null} onRestore={ws.restore}
              corrections={{}} editing={null} onCorrect={() => undefined}
              onSelect={(selection, seekTo) => { ws.setSelection(selection); if (seekTo) seek(selection.anchor < ws.count ? ws.placed[selection.anchor].programStart : ws.total); }}
              onDelete={ws.remove} onScrub={seek} onMove={ws.move} onEdit={() => ws.setMessage("Correct words in AAF Audio's transcript; the edit follows it.")} />}
          {ws.prompt && <EditOvertalkPrompt who={ws.names(ws.prompt.who)} under={ws.names(ws.prompt.result.crosstalk.map((word) => word.track))} count={ws.prompt.result.crosstalk.length}
            onEveryone={() => ws.prompt && ws.applyDelete(ws.prompt.result, ws.prompt.count)} onKeep={() => { ws.setPrompt(null); focusDoc(); }} />}
        </EditRecordPane>
      </div>
      {showHistory && history && <div className="cp-te-pane cp-te-pane-history"><EditHistoryPanel history={history} onJump={jump} onPin={pin} /></div>}
    </div>
    <EditLower ws={ws} solo={solo} mute={mute} onSolo={(id) => setSolo((state) => toggled(state, id))} onMute={(id) => setMute((state) => toggled(state, id))} lanes={lanes} colors={colors} fps={fps} recordStart={recordStart} playhead={playhead} playing={playback.playing} busy={playback.busy}
      onToggle={() => void playback.toggle()} onSeek={seek} onScrubStart={playback.pause} onScrubEnd={() => undefined}
      tc={tc} sourceTc={(source, seconds) => editTc(seconds, fps, infos.find((info) => info.id === source)?.startFrames ?? 0)} sourceName={sourceName} nameOf={nameOf}
      sourceLanes={sourceLanes} peaksOf={(source, lane) => data.peaks.get(`${source}:${lane}`)} durationOf={(source) => data.durations[source] ?? 0} pictureOf={pictureOf}
      zoom={zoom} onZoom={setZoom} snap={snap} onSnap={() => setSnap((value) => !value)} follow={follow} onFollow={() => setFollow((value) => !value)} loop={loop} onLoop={() => setLoop((value) => !value)} />
  </div>;
}
