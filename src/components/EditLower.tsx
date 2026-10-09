import { useMemo } from "react";
import type { EditSourceSide } from "../hooks/use-edit-source-side";
import { useFrame } from "../hooks/use-frame";
import type { FrameStore } from "../lib/frame-store";
import type { useEditWorkspace } from "../hooks/use-edit-workspace";
import { firstAbove } from "../lib/edit-model";
import type { RecordTool } from "../hooks/use-record-gestures";
import { EditRecordRows, recordRowId } from "./EditRecordRows";
import { EditSourceTimeline, sourceRows } from "./EditSourceTimeline";
import { EditTimeline } from "./EditTimeline";
import { EditTimelineMode } from "./EditTimelineMode";

type Workspace = ReturnType<typeof useEditWorkspace>;
type Props = {
  ws: Workspace; side: EditSourceSide;
  /** Record tracks soloed and muted, as track numbers (1 for A1). */
  solo: ReadonlySet<number>; mute: ReadonlySet<number>; onSolo: (layer: number) => void; onMute: (layer: number) => void;
  nameOf: (lane: string) => string; colors: Record<string, string>; fps: number; recordStart: number;
  /** A marker clicked on the ruler: select it, park on it, and show it in the Inspector. */
  onMarker: (id: string) => void;
  /** Audio ▸ Strip Silence…: Media Composer's, on the selected record tracks. */
  onStripSilence: () => void;
  /** Audio ▸ Stack Conversations. */
  onStackConversations: () => void;
  /** Audio ▸ Focus on Marked Lines. */
  onFocusMarked: () => void;
  /** Match Frame (⇧F), from the toolbar. */
  onMatchFrame: () => void;
  /** The record playhead, in frames. */
  frames: FrameStore; onSeek: (seconds: number) => void; onScrubStart: () => void; onScrubEnd: () => void;
  sourceName: (id: string) => string;
  /** The corner's Source/Record switch. Showing the source here also shows its pane, where its Play and timecode are. */
  onMode: (mode: "source" | "record") => void;
  sourceLanes: Record<string, string[]>; peaksOf: (source: string, lane: string) => [number, number][] | undefined; durationOf: (source: string) => number;
  /** Finer peaks for a `source:lane` range when a zoomed clip needs them. */
  detail?: (pair: string, from: number, to: number) => Promise<[number, number][] | null>;
  waveforms: boolean; onWaveforms: (on: boolean) => void;
  /** Record tracks whose own waveform is on, and each header's W (⌥: every track). */
  waves: ReadonlySet<number>; onWave: (layer: number, all: boolean) => void;
  /** Every mic's waveform is measured, so silence found between words is real. */
  measured: boolean; measuring: boolean;
  /** Waveforms are on and nothing is building, yet a mic is still unmeasured: its build failed. */
  stalled?: boolean;
  /** View ▸ Audio: crossfade at cuts, which playback uses too. */
  audio: React.ComponentProps<typeof EditTimeline>["audio"]; onAudio: (audio: React.ComponentProps<typeof EditTimeline>["audio"]) => void;
  /** This view's scale in pixels per frame (0 fits it), its zoom, and its scroll. */
  /** The record timeline's tool (Neo's: Selection, Blade, Roll, Slip, Slide). */
  tool: RecordTool; onTool: (tool: RecordTool) => void;
  zoom: number; onZoom: (direction: -1 | 0 | 1) => void; fit: React.MutableRefObject<() => number>; pan: number; onPan: (seconds: number) => void; snap: boolean; onSnap: () => void; follow: boolean; onFollow: () => void; loop: boolean; onLoop: () => void;
};

const none = new Set<string>();

/** The first index whose time is at or past `value`, in times sorted ascending. */
function atOrAbove(sorted: number[], value: number): number {
  let low = 0, high = sorted.length;
  while (low < high) { const middle = (low + high) >> 1; if (sorted[middle] >= value) high = middle; else low = middle + 1; }
  return low;
}

/**
 * The magnetic timeline and its tool row: the bottom of the editor. The corner
 * switches the timeline between Record (the string out) and Source (the
 * loaded sequence, every mic), as Avid's Toggle Source/Record in Timeline
 * does; the tool row is the same in both, and its record-only edits rest
 * while the source is showing.
 */
export function EditLower(props: Props) {
  const { ws, side, fps } = props;
  // The edit points either side of the playhead: this redraws when it crosses one, not on every frame.
  // Found by binary search over their times: the selector runs on every frame while playing.
  const seamTimes = useMemo(() => ws.seams.map((item) => item.at), [ws.seams]);
  const previous = useFrame(props.frames, (frame) => ws.seams[atOrAbove(seamTimes, frame / fps - 1e-3) - 1]?.index ?? -1);
  const next = useFrame(props.frames, (frame) => ws.seams[firstAbove(seamTimes, frame / fps + 1e-3)]?.index ?? -1);
  const corner = <EditTimelineMode mode={side.mode} onMode={props.onMode} />;
  const shown = side.mode === "source" ? side.source : null, aaf = side.aaf;
  const tools = { marks: shown ? side.marks : ws.marks, canMark: ws.edit.segments.length > 0, snap: props.snap, follow: props.follow, loop: props.loop,
    hasPrevious: previous >= 0, hasNext: next >= 0, sourceSide: !!shown,
    onAddEdit: ws.cutHere, onMarkIn: shown ? side.markIn : ws.markIn, onMarkClip: ws.markClip, onMatchFrame: props.onMatchFrame, onFindDead: () => (ws.dead ? ws.setDead(null) : ws.findDead()), finding: !!ws.dead,
    // Dead space is where no mic is audible. A mic with no waveform has no
    // audible spans at all, which would read as silence and cut a laugh.
    deadHint: props.measured ? undefined : props.measuring ? "Waiting for every mic's waveform"
      : props.stalled ? "A mic could not be measured. The reason is shown above the editor" : "Turn on View ▸ Waveforms to measure each mic first",
    onMarkOut: shown ? side.markOut : ws.markOut, onClearMarks: shown ? side.clearMarks : () => ws.setMarks({ in: null, out: null }), onStripSilence: props.onStripSilence, onStackConversations: props.onStackConversations, onFocusMarked: props.onFocusMarked, onLift: () => ws.takeMarked(false), onExtract: () => ws.takeMarked(true), onMarker: ws.addMarker,
    onSnap: props.onSnap, onFollow: props.onFollow, onLoop: props.onLoop,
    tool: props.tool, onTool: props.onTool, trimming: ws.rollers.length > 0, onTrim: ws.enterTrim, ripple: ws.rippleTrim, onRipple: ws.toggleRipple,
    onPrevious: () => previous >= 0 && ws.chooseSeam(previous), onNext: () => next >= 0 && ws.chooseSeam(next) };
  const shared = { fps, sources: Object.keys(props.sourceLanes),
    waveforms: props.waveforms, onWaveforms: props.onWaveforms, measuring: props.measuring, zoom: props.zoom, onZoom: props.onZoom, fit: props.fit, pan: props.pan, onPan: props.onPan, audio: props.audio, onAudio: props.onAudio, tools, corner };
  // Until its sequence is read the source has no tracks to draw; it says so rather than showing the record's.
  if (shown) return <div className="cp-te-lower is-source">
    <EditTimeline {...shared} rowIds={aaf ? sourceRows(aaf, side.expanded).map((track) => track.id) : []}
      edit={{ segments: [{ id: "whole", source: shown.id, srcIn: 0, srcOut: shown.duration }], mutes: [] }} seams={[]} placed={[]} selection={none}
      frames={side.playback.frames} recordStart={shown.startFrames} onSeek={(seconds) => void side.playback.seek(Math.round(seconds * fps))}
      dead={null} onDeadSkip={() => undefined} onDeadPreset={() => undefined}
      onDeadApply={() => undefined} onDeadCancel={() => undefined} onScrubStart={side.playback.pause} onScrubEnd={() => undefined} markers={{ list: [] }}
      rows={(view) => aaf ? <EditSourceTimeline side={side} aaf={aaf} colors={props.colors} fps={fps} view={view} peaksOf={props.peaksOf} duration={shown.duration} recordTracks={ws.layerTotal} />
        : <div className="cp-te-tl-empty"><p className="cp-te-tl-empty-card" role="status">Opening {shown.short}…</p></div>} />
  </div>;
  const layers = Array.from({ length: ws.layerTotal }, (_, index) => recordRowId(index + 1));
  return <div className="cp-te-lower" data-tool={props.tool}>
    <EditTimeline {...shared} rowIds={layers} edit={ws.edit} seams={ws.seams} placed={ws.placed} selection={ws.keys} frames={props.frames} recordStart={props.recordStart}
      onSeek={props.onSeek}
      dead={ws.dead} onDeadSkip={ws.skipDead} onDeadPreset={ws.findDead} onDeadApply={ws.applyDead} onDeadCancel={() => ws.setDead(null)}
      onScrubStart={props.onScrubStart} onScrubEnd={props.onScrubEnd} markers={{ list: ws.markers, selected: ws.marker?.id, onSelect: props.onMarker, onRemove: ws.removeMarker }}
      rows={(view) => <EditRecordRows view={view} ws={ws} tool={props.tool} snap={props.snap} playhead={() => props.frames.get() / fps} seek={props.onSeek}
        solo={props.solo} mute={props.mute} onSolo={props.onSolo} onMute={props.onMute}
        nameOf={props.nameOf} colors={props.colors} sourceName={props.sourceName} peaksOf={props.peaksOf} durationOf={props.durationOf} detail={props.detail}
        waves={props.waves} onWave={props.onWave} />} />
  </div>;
}
