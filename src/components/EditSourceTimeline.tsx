import type { AafDocument } from "../bindings/AafDocument";
import type { EditSourceSide } from "../hooks/use-edit-source-side";
import { phraseLabels } from "../lib/edit-model";
import { audioTrackLabel, trackOwner } from "../lib/multitrack";
import { laneMetadata, laneStatus, visibleLanes } from "../lib/multitrack-graph";
import { EditSourceTrack } from "./EditSourceTrack";

/** What the timeline hands its rows: where the view is, and the switches it owns. */
export type EditRowsView = {
  start: number; span: number; width: number; x: (t: number) => string; w: (d: number) => string;
  scrub: Pick<React.HTMLAttributes<HTMLElement>, "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel">;
  waveforms: boolean; text: Set<string>; onText: (id: string) => void;
};

type Props = {
  side: EditSourceSide; aaf: AafDocument; colors: Record<string, string>; fps: number; view: EditRowsView;
  peaksOf: (source: string, lane: string) => [number, number][] | undefined; duration: number;
};

/** The source sequence's tracks in the order AAF Audio shows them: each track, then its alternates when opened. */
export const sourceRows = (aaf: AafDocument, expanded: Set<string>) => visibleLanes(aaf, expanded);

/**
 * The timeline's SOURCE view: every mic of the loaded sequence, with its group
 * alternates under a disclosure exactly as AAF Audio lays them out (the same
 * visibleLanes), drawn in String Outs' lanes. Names belong here, on the source
 * side; the record side is tracks.
 */
export function EditSourceTimeline({ side, aaf, colors, fps, view, peaksOf, duration }: Props) {
  const source = side.source!;
  const seconds = (frames: number) => frames / fps;
  const graph = aaf.manifest.graph?.lanes ?? [];
  const soloed = new Set([...side.solo]);
  return <>{sourceRows(aaf, side.expanded).map((track) => {
    const lane = side.laneOf.get(track.id), meta = laneMetadata(aaf, track.id);
    const owner = trackOwner(aaf, track.id);
    return <EditSourceTrack key={track.id} id={track.id} label={audioTrackLabel(aaf, track.id)} owner={owner} color={lane ? colors[lane] : undefined}
      alternates={graph.filter((item) => item.parent_track_id === track.id).length} open={side.expanded.has(track.id)} onOpen={(all) => side.toggleExpanded(track.id, all)}
      group={meta?.parent_track_id ? meta.group_name || "Group audio" : null} status={laneStatus(aaf, track.id)} unread={!lane}
      selected={side.selected.has(track.id)} onSelect={(only) => side.toggleSelector(track.id, only)}
      soloed={!!lane && soloed.has(lane)} quiet={soloed.size > 0 && !(lane && soloed.has(lane))} onSolo={() => lane && side.toggleSolo(lane)}
      shown={view.text.has(track.id)} onText={() => view.onText(track.id)}
      clips={track.clips} seconds={seconds} start={view.start} span={view.span} x={view.x} w={view.w}
      waveforms={view.waveforms} peaks={lane ? peaksOf(source.id, lane) : undefined} duration={duration}
      cues={lane && view.text.has(track.id) ? phraseLabels(side.own, lane, view.start, view.span, view.width) : []} scrub={view.scrub} />;
  })}</>;
}
