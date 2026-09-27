import { useMemo, useState } from "react";
import type { EditDocument } from "../bindings/EditDocument";
import { useEditPlayback } from "../hooks/use-edit-playback";
import { placeWords, type TimelineLane, type TimelineWord } from "../lib/edit-model";
import { EditSourcePane, type EditSourceInfo } from "./EditSourcePane";
import type { EditTextStyle } from "./EditTextSettings";

type Props = {
  document: EditDocument; sources: EditSourceInfo[]; lanes: TimelineLane[]; colors: Record<string, string>; fps: number;
  words: TimelineWord[]; used: Set<string>; active: boolean;
  text: EditTextStyle; onText: (style: EditTextStyle) => void;
  onInsert: (source: string, words: TimelineWord[], atEnd: boolean) => void;
};

/**
 * The source side, one sequence at a time. It plays the whole source through
 * the same edit-list engine as the record side, as a one-segment edit, so
 * what you hear here is exactly what an insert will put in the edit.
 */
export function EditSourceHost({ document, sources, lanes, colors, fps, words, used, active, text, onText, onInsert }: Props) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [ranges, setRanges] = useState<Record<string, [number, number] | null>>({});
  const source = sources.find((item) => item.id === chosen) ?? sources[0] ?? null;
  const frames = source ? Math.round(source.duration * fps) : 0;
  const whole: EditDocument = useMemo(() => ({ ...document, segments: source && frames > 0 ? [{ kind: "source", id: "whole", source: source.id, in_frame: 0, out_frame: frames }] : [], mutes: [], markers: [] }),
    [document, source, frames]);
  const playback = useEditPlayback({ document: whole, audible: lanes.map((lane) => lane.id), active: active && !!source });
  const own = useMemo(() => source ? placeWords(words, { segments: [{ id: "whole", source: source.id, srcIn: 0, srcOut: source.duration }], mutes: [] }) : [], [words, source]);
  if (!source) return <section className="cp-te-source cp-te-doc-empty" aria-label="Source"><p>Add an AAF Audio sequence to this edit to cut from it.</p></section>;
  const range = ranges[source.id] ?? null;
  const take = (atEnd: boolean) => { if (range) onInsert(source.id, own.slice(range[0], range[1] + 1).map((item) => item.word), atEnd); };
  return <div className="cp-te-source-host" data-source-id={source.id}>
    {sources.length > 1 && <select className="cp-select cp-te-source-pick" aria-label="Source sequence" value={source.id}
      onChange={(event) => { playback.pause(); setChosen(event.target.value); }}>
      {sources.map((item) => <option key={item.id} value={item.id}>{item.short}</option>)}
    </select>}
    <EditSourcePane source={source} speakers={lanes} colors={colors} fps={fps} words={words} used={used} corrections={{}}
      range={range} onRange={(next) => setRanges((state) => ({ ...state, [source.id]: next }))} match={null}
      playhead={playback.frame / fps} playing={playback.playing} onPlay={() => void playback.toggle()}
      onScrub={(seconds) => void playback.seek(Math.round(seconds * fps))} onScrubStart={playback.pause} onScrubEnd={() => undefined}
      text={text} onText={onText} onInsert={() => take(false)} onAppend={() => take(true)} />
  </div>;
}
