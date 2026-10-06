import type { EditSourceSide } from "../hooks/use-edit-source-side";
import type { TimelineLane } from "../lib/edit-model";
import { EditSourcePane } from "./EditSourcePane";
import type { EditTextStyle } from "./EditTextSettings";

type Props = {
  side: EditSourceSide; lanes: TimelineLane[]; colors: Record<string, string>; fps: number; used: Set<string>;
  /** Mics read so far while the words are still arriving, else null. */
  reading: { done: number; total: number } | null;
  text: EditTextStyle; onText: (style: EditTextStyle) => void;
  /** Insert, Append or Overwrite what the source has marked. */
  onPlace: (how: "insert" | "append" | "overwrite") => void;
};

/**
 * The source side's text, one sequence at a time. What it shows, where it is
 * parked and what is marked live in useEditSourceSide, which the timeline's
 * Source view reads too: select a line here and the same In to Out is on the
 * source timeline, mark I and O there and Insert takes it from here.
 */
export function EditSourceHost({ side, lanes, colors, fps, used, reading, text, onText, onPlace }: Props) {
  const { source, playback } = side;
  if (!source) return <section className="cp-te-source cp-te-doc-empty" aria-label="Source"><p>Add an AAF Audio sequence to this string out to cut from it.</p></section>;
  return <div className="cp-te-source-host" data-source-id={source.id}>
    {side.sources.length > 1 && <select className="cp-select cp-te-source-pick" aria-label="Source sequence" value={source.id}
      onChange={(event) => side.choose(event.target.value)}>
      {side.sources.map((item) => <option key={item.id} value={item.id}>{item.short}</option>)}
    </select>}
    <EditSourcePane source={source} speakers={lanes} colors={colors} fps={fps} placed={side.shown} used={used} corrections={{}}
      people={side.people} tab={side.tab} onTab={side.setTab} reading={reading} range={side.range} onRange={side.setRange} match={null}
      canInsert={side.take() != null} marks={side.marks} frames={playback.frames} playing={playback.playing} onPlay={() => void playback.toggle()}
      onScrub={(seconds) => void playback.seek(Math.round(seconds * fps))} onScrubStart={playback.pause} onScrubEnd={() => undefined}
      text={text} onText={onText} onPlace={onPlace} />
  </div>;
}
