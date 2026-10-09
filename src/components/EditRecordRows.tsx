import { useMemo } from "react";
import type { useEditWorkspace } from "../hooks/use-edit-workspace";
import { useRecordGestures, type RecordTool } from "../hooks/use-record-gestures";
import { layerClips, layerOf, phraseLabels, type PlacedWord } from "../lib/edit-model";
import type { EditRowsView } from "./EditSourceTimeline";
import { EditTimelineRow } from "./EditTimelineRow";

type Props = {
  view: EditRowsView; ws: ReturnType<typeof useEditWorkspace>;
  /** The record timeline's tool, Snap, and the playhead (read when a gesture needs it) and parking it. */
  tool: RecordTool; snap: boolean; playhead: () => number; seek: (seconds: number) => void;
  solo: ReadonlySet<number>; mute: ReadonlySet<number>; onSolo: (layer: number) => void; onMute: (layer: number) => void;
  nameOf: (lane: string) => string; colors: Record<string, string>; sourceName: (id: string) => string;
  peaksOf: (source: string, lane: string) => [number, number][] | undefined; durationOf: (source: string) => number;
  detail?: (pair: string, from: number, to: number) => Promise<[number, number][] | null>;
  /** Tracks whose own waveform is on (each header's W), and its switch. */
  waves: ReadonlySet<number>; onWave?: (layer: number, all: boolean) => void;
};

/** The id T uses for a record track. */
export const recordRowId = (layer: number) => `A${layer}`;

/**
 * The record's tracks, A1 down, as layers: each holds whatever was cut onto
 * it, and an empty one is filler from end to end, ready to be cut onto. A
 * string out shows at least four, as a new Avid sequence does. The pointer
 * works them as Neo's timeline does (use-record-gestures): select, lasso,
 * roll, trim, slip, slide, blade, drag and ⌥-drag to copy, each drag
 * previewed as it goes with its count of frames beside the pointer.
 */
export function EditRecordRows(props: Props) {
  const { view, ws } = props;
  const gestures = useRecordGestures({ ws, tool: props.tool, start: view.start, span: view.span, snap: props.snap, playhead: props.playhead, seek: props.seek, pan: view.pan });
  const edit = gestures.draft ?? ws.edit, layering = ws.layering;
  const clips = useMemo(() => new Map(Array.from({ length: ws.layerTotal }, (_, index) => [index + 1, layerClips(edit, index + 1, layering)])),
    [edit, layering, ws.layerTotal]);
  // Each word on the track its person sits on where it is said, for T.
  const onLayer = useMemo(() => {
    const out = new Map<number, PlacedWord[]>();
    for (const item of ws.placed) {
      const layer = layerOf(ws.edit.segments[item.segment], item.word.track, layering);
      if (layer == null) continue;
      const list = out.get(layer);
      if (list) list.push(item); else out.set(layer, [item]);
    }
    return out;
  }, [ws.placed, ws.edit, layering]);
  const mutes = useMemo(() => {
    const out: Record<string, [number, number][]> = {};
    for (const mute of edit.mutes) (out[`${mute.source}:${mute.track}`] ??= []).push([mute.srcIn, mute.srcOut]);
    return out;
  }, [edit.mutes]);
  return <>{Array.from({ length: ws.layerTotal }, (_, index) => index + 1).map((layer) => {
    const id = recordRowId(layer), shown = view.text.has(id);
    return <EditTimelineRow key={layer} layer={layer} clips={clips.get(layer) ?? []} selected={ws.onTracks.has(layer)} onTrack={ws.toggleTrack}
      picked={gestures.draft ? [] : ws.picks.filter((pick) => pick.layer === layer).map((pick) => pick.from)}
      rollers={gestures.draft ? [] : ws.rollers.filter((roller) => roller.layer === layer)} ripple={ws.rippleTrim}
      soloed={props.solo.has(layer)} quiet={props.solo.size > 0 && !props.solo.has(layer)} muted={props.mute.has(layer)} onSolo={props.onSolo} onMute={props.onMute}
      shown={shown} onText={() => view.onText(id)} cues={shown ? phraseLabels(onLayer.get(layer) ?? [], null, view.start, view.span, view.width) : []}
      start={view.start} span={view.span} x={view.x} w={view.w} nameOf={props.nameOf} colorOf={(lane) => props.colors[lane]} sourceName={props.sourceName}
      waveforms={view.waveforms || props.waves.has(layer)} onWave={props.onWave} peaksOf={props.peaksOf} durationOf={props.durationOf} detail={props.detail}
      mutes={mutes} marked={ws.marked ? [...ws.marked] : null} pointer={gestures.handlers(layer)} />;
  })}
    {gestures.lasso && <span className="cp-te-tl-lasso" aria-hidden="true" style={gestures.lasso} />}
    {gestures.readout && <span className="cp-te-tl-readout" aria-hidden="true" style={{ left: gestures.readout.left, top: gestures.readout.top }}>{gestures.readout.text}</span>}
  </>;
}
