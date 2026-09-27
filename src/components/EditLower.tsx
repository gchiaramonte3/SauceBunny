import type { useEditWorkspace } from "../hooks/use-edit-workspace";
import { isGap, programToSource, type TimelineLane } from "../lib/edit-model";
import { EditTimeline } from "./EditTimeline";
import { EditTransport } from "./EditTransport";

type Workspace = ReturnType<typeof useEditWorkspace>;
type Props = {
  ws: Workspace; solo: Set<string>; mute: Set<string>; onSolo: (lane: string) => void; onMute: (lane: string) => void; lanes: TimelineLane[]; colors: Record<string, string>; fps: number; recordStart: number;
  playhead: number; playing: boolean; busy: boolean; onToggle: () => void; onSeek: (seconds: number) => void; onScrubStart: () => void; onScrubEnd: () => void;
  tc: (seconds: number) => string; sourceTc: (source: string, seconds: number) => string; sourceName: (id: string) => string; nameOf: (lane: string) => string;
  sourceLanes: Record<string, string[]>; peaksOf: (source: string, lane: string) => [number, number][] | undefined; durationOf: (source: string) => number;
  zoom: number; onZoom: (zoom: number) => void; snap: boolean; onSnap: () => void; follow: boolean; onFollow: () => void; loop: boolean; onLoop: () => void;
};

/** Transport over the magnetic timeline: the bottom of the editor. */
export function EditLower(props: Props) {
  const { ws, playhead, fps } = props;
  const at = ws.placed.length || ws.edit.segments.length ? programToSource(ws.edit, playhead) : null;
  const segment = at ? ws.edit.segments[at.segment] : null;
  const source = segment && !isGap(segment) ? segment.source : null;
  const speaking = [...new Set(ws.placed.filter((item) => !item.muted && item.programStart <= playhead && playhead < item.programEnd).map((item) => item.word.track))];
  const previous = [...ws.seams].reverse().find((item) => item.at < playhead - 1e-3) ?? null;
  const next = ws.seams.find((item) => item.at > playhead + 1e-3) ?? null;
  return <div className="cp-te-lower">
    <EditTransport playing={props.playing} busy={props.busy} onToggle={props.onToggle} onStart={() => props.onSeek(0)}
      record={props.tc(playhead)} total={props.tc(ws.total)} source={source && at ? props.sourceTc(source, at.source) : null} sourceName={source ? props.sourceName(source) : ""}
      speaking={speaking.map((id) => ({ id, name: props.nameOf(id), color: props.colors[id] }))} message={ws.message} />
    <EditTimeline speakers={props.lanes} edit={ws.edit} seams={ws.seams} placed={ws.placed} selection={ws.keys} playhead={playhead} fps={fps} recordStart={props.recordStart}
      colors={props.colors} solo={props.solo} mute={props.mute} onSeek={props.onSeek} seam={ws.seam} onSeam={ws.chooseSeam}
      sourceSpeakers={props.sourceLanes} sourceName={props.sourceName} peaksOf={props.peaksOf} durationOf={props.durationOf}
      tracks={ws.onTracks} onTrack={ws.toggleTrack} dead={ws.dead} onDeadSkip={ws.skipDead} onDeadPreset={ws.findDead} onDeadApply={ws.applyDead} onDeadCancel={() => ws.setDead(null)}
      onScrubStart={props.onScrubStart} onScrubEnd={props.onScrubEnd} zoom={props.zoom} onZoom={props.onZoom} markers={ws.markers.map((marker) => marker.at)}
      tools={{ marks: ws.marks, canMark: ws.edit.segments.length > 0, snap: props.snap, follow: props.follow, loop: props.loop, hasPrevious: !!previous, hasNext: !!next,
        onAddEdit: ws.cutHere, onMarkIn: ws.markIn, onMarkClip: ws.markClip, onFindDead: () => (ws.dead ? ws.setDead(null) : ws.findDead()), finding: !!ws.dead,
        onMarkOut: ws.markOut, onLift: () => ws.takeMarked(false), onExtract: () => ws.takeMarked(true), onMarker: ws.addMarker,
        onSnap: props.onSnap, onFollow: props.onFollow, onLoop: props.onLoop,
        onPrevious: () => previous && ws.chooseSeam(previous.index), onNext: () => next && ws.chooseSeam(next.index) }}
      onSolo={props.onSolo} onMute={props.onMute} />
  </div>;
}
