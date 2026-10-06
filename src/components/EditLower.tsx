import type { EditSourceSide } from "../hooks/use-edit-source-side";
import type { useEditWorkspace } from "../hooks/use-edit-workspace";
import type { TimelineLane } from "../lib/edit-model";
import { trackOwner } from "../lib/multitrack";
import { EditSourceTimeline, sourceRows } from "./EditSourceTimeline";
import { EditTimeline } from "./EditTimeline";
import { EditTimelineMode } from "./EditTimelineMode";

type Workspace = ReturnType<typeof useEditWorkspace>;
type Props = {
  ws: Workspace; side: EditSourceSide; solo: Set<string>; mute: Set<string>; onSolo: (lane: string) => void; onMute: (lane: string) => void;
  /** Take a group angle off the track they were given. */
  onUntrack?: (lane: string) => void; lanes: TimelineLane[]; colors: Record<string, string>; fps: number; recordStart: number;
  /** Everyone in the string out, patched or not: what the record track headers' patch panel offers. */
  people: TimelineLane[];
  /** A marker clicked on the ruler: select it, park on it, and show it in the Inspector. */
  onMarker: (id: string) => void;
  /** Audio ▸ Strip Silence…: Media Composer's, on the selected record tracks. */
  onStripSilence: () => void;
  playhead: number; onSeek: (seconds: number) => void; onScrubStart: () => void; onScrubEnd: () => void;
  sourceName: (id: string) => string;
  /** The corner's Source/Record switch. Showing the source here also shows its pane, where its Play and timecode are. */
  onMode: (mode: "source" | "record") => void;
  sourceLanes: Record<string, string[]>; peaksOf: (source: string, lane: string) => [number, number][] | undefined; durationOf: (source: string) => number;
  pictureOf?: React.ComponentProps<typeof EditTimeline>["pictureOf"];
  waveforms: boolean; onWaveforms: (on: boolean) => void;
  /** Every mic's waveform is measured, so silence found between words is real. */
  measured: boolean; measuring: boolean;
  /** Waveforms are on and nothing is building, yet a mic is still unmeasured: its build failed. */
  stalled?: boolean;
  /** View ▸ Audio: crossfade at cuts, which playback uses too. */
  audio: React.ComponentProps<typeof EditTimeline>["audio"]; onAudio: (audio: React.ComponentProps<typeof EditTimeline>["audio"]) => void;
  zoom: number; onZoom: (zoom: number) => void; snap: boolean; onSnap: () => void; follow: boolean; onFollow: () => void; loop: boolean; onLoop: () => void;
};

const none = new Set<string>();

/**
 * The magnetic timeline and its tool row: the bottom of the editor. The corner
 * switches the timeline between Record (the string out) and Source (the
 * loaded sequence, every mic), as Avid's Toggle Source/Record in Timeline
 * does; the tool row is the same in both, and its record-only edits rest
 * while the source is showing.
 */
export function EditLower(props: Props) {
  const { ws, side, playhead, fps } = props;
  const previous = [...ws.seams].reverse().find((item) => item.at < playhead - 1e-3) ?? null;
  const next = ws.seams.find((item) => item.at > playhead + 1e-3) ?? null;
  const corner = <EditTimelineMode mode={side.mode} onMode={props.onMode} />;
  const shown = side.mode === "source" ? side.source : null, aaf = side.aaf;
  const tools = { marks: shown ? side.marks : ws.marks, canMark: ws.edit.segments.length > 0, snap: props.snap, follow: props.follow, loop: props.loop,
    hasPrevious: !!previous, hasNext: !!next, sourceSide: !!shown,
    onAddEdit: ws.cutHere, onMarkIn: shown ? side.markIn : ws.markIn, onMarkClip: ws.markClip, onFindDead: () => (ws.dead ? ws.setDead(null) : ws.findDead()), finding: !!ws.dead,
    // Dead space is where no mic is audible. A mic with no waveform has no
    // audible spans at all, which would read as silence and cut a laugh.
    deadHint: props.measured ? undefined : props.measuring ? "Waiting for every mic's waveform"
      : props.stalled ? "A mic could not be measured. The reason is shown above the editor" : "Turn on View ▸ Waveforms to measure each mic first",
    onMarkOut: shown ? side.markOut : ws.markOut, onClearMarks: shown ? side.clearMarks : () => ws.setMarks({ in: null, out: null }), onStripSilence: props.onStripSilence, onLift: () => ws.takeMarked(false), onExtract: () => ws.takeMarked(true), onMarker: ws.addMarker,
    onSnap: props.onSnap, onFollow: props.onFollow, onLoop: props.onLoop,
    onPrevious: () => previous && ws.chooseSeam(previous.index), onNext: () => next && ws.chooseSeam(next.index) };
  const shared = { fps, colors: props.colors, sourceName: props.sourceName, peaksOf: props.peaksOf, durationOf: props.durationOf, pictureOf: props.pictureOf,
    waveforms: props.waveforms, onWaveforms: props.onWaveforms, measuring: props.measuring, zoom: props.zoom, onZoom: props.onZoom, audio: props.audio, onAudio: props.onAudio, tools, corner };
  // Until its sequence is read the source has no tracks to draw; it says so rather than showing the record's.
  if (shown) return <div className="cp-te-lower is-source">
    <EditTimeline {...shared} speakers={aaf ? sourceRows(aaf, side.expanded).map((track) => ({ id: track.id, name: trackOwner(aaf, track.id), track: 0 })) : []}
      edit={{ segments: [{ id: "whole", source: shown.id, srcIn: 0, srcOut: shown.duration }], mutes: [] }} seams={[]} placed={[]} selection={none}
      playhead={side.playhead} recordStart={shown.startFrames} solo={none} mute={none} onSeek={(seconds) => void side.playback.seek(Math.round(seconds * fps))}
      seam={null} onSeam={() => undefined} sourceSpeakers={{}} tracks={none} onTrack={() => undefined} dead={null} onDeadSkip={() => undefined} onDeadPreset={() => undefined}
      onDeadApply={() => undefined} onDeadCancel={() => undefined} onScrubStart={side.playback.pause} onScrubEnd={() => undefined} markers={{ list: [] }}
      onSolo={() => undefined} onMute={() => undefined}
      rows={(view) => aaf ? <EditSourceTimeline side={side} aaf={aaf} colors={props.colors} fps={fps} view={view} peaksOf={props.peaksOf} duration={shown.duration} />
        : <div className="cp-te-tl-empty"><p className="cp-te-tl-empty-card" role="status">Opening {shown.short}…</p></div>} />
  </div>;
  return <div className="cp-te-lower">
    <EditTimeline {...shared} speakers={props.lanes} edit={ws.edit} seams={ws.seams} placed={ws.placed} selection={ws.keys} playhead={playhead} recordStart={props.recordStart}
      solo={props.solo} mute={props.mute} onSeek={props.onSeek} seam={ws.seam} onSeam={ws.chooseSeam}
      sourceSpeakers={props.sourceLanes} tracks={ws.onTracks} onTrack={ws.toggleTrack} dead={ws.dead} onDeadSkip={ws.skipDead} onDeadPreset={ws.findDead} onDeadApply={ws.applyDead} onDeadCancel={() => ws.setDead(null)}
      onScrubStart={props.onScrubStart} onScrubEnd={props.onScrubEnd} markers={{ list: ws.markers, selected: ws.marker?.id, onSelect: props.onMarker, onRemove: ws.removeMarker }} onAddWhole={ws.addWhole}
      onSolo={props.onSolo} onMute={props.onMute} onUntrack={props.onUntrack} patch={{ people: props.people, onPatch: ws.patch }} />
  </div>;
}
