import { useEffect, useMemo, useRef } from "react";
import { editTc } from "../lib/edit-document";
import { paragraphs, placeWords, type TimelineLane, type TimelineWord } from "../lib/edit-model";
import { EditScrubber } from "./EditScrubber";
import { EditTextSettings, editTextVars, type EditTextStyle } from "./EditTextSettings";
import { IconPause, IconPlay } from "./Icons";

/** A source as the pane needs it: its name, length in seconds, and start timecode in frames. */
export type EditSourceInfo = { id: string; short: string; duration: number; startFrames: number };

type Props = {
  source: EditSourceInfo; speakers: TimelineLane[]; colors: Record<string, string>; fps: number;
  words: TimelineWord[]; used: Set<string>; corrections: Record<string, string>;
  range: [number, number] | null; onRange: (range: [number, number] | null) => void; match: string | null;
  playhead: number; playing: boolean; onPlay: () => void; onScrub: (seconds: number) => void; onScrubStart: () => void; onScrubEnd: () => void;
  text: EditTextStyle; onText: (style: EditTextStyle) => void; onInsert: () => void; onAppend: () => void;
};

/**
 * The SOURCE side of source/record: one source, read-only, with its own
 * playhead. Words already in the edit read at full strength and the rest are
 * dimmed, so what the cut left behind shows at a glance. Click a word to park
 * the source there, ⌥-drag to scrub, select a line and press V to put it in
 * the edit at the caret, the way a splice-in works in Media Composer.
 */
export function EditSourcePane(props: Props) {
  const { source, speakers, colors, fps, used, range } = props;
  const placed = useMemo(() => placeWords(props.words, { segments: [{ id: "whole", source: source.id, srcIn: 0, srcOut: source.duration }], mutes: [] }), [props.words, source.id, source.duration]);
  const paras = useMemo(() => paragraphs(placed), [placed]);
  const anchor = useRef<number | null>(null);
  const scrubbing = useRef(false);
  const body = useRef<HTMLDivElement>(null);
  const count = placed.length;
  const inEdit = placed.filter((item) => used.has(item.word.id)).length;
  const current = placed.find((item) => item.word.start <= props.playhead && props.playhead < item.word.end)?.word.id ?? null;
  useEffect(() => {
    if (props.match) body.current?.querySelector(".cp-te-src-word.is-match")?.scrollIntoView({ block: "center" });
  }, [props.match]);
  useEffect(() => {
    if (props.playing && current) body.current?.querySelector(".cp-te-src-word.is-current")?.scrollIntoView({ block: "nearest" });
  }, [current, props.playing]);
  const indexOf = (target: EventTarget | null) => {
    const found = (target as HTMLElement | null)?.closest?.("[data-src-index]");
    return found ? Number(found.getAttribute("data-src-index")) : null;
  };
  const extend = (to: number) => props.onRange([Math.min(anchor.current ?? to, to), Math.max(anchor.current ?? to, to)]);
  let offset = 0;
  return <section className="cp-te-source" aria-label={`Source: ${source.short}`} style={editTextVars(props.text)}>
    <div className="cp-te-tools">
      <button type="button" className="cp-icon-btn cp-te-play" aria-label={props.playing ? `Pause ${source.short}` : `Play ${source.short}`}
        title={props.playing ? "Pause the source (Space)" : "Play the source (Space)"} onClick={props.onPlay}>{props.playing ? <IconPause size={14} /> : <IconPlay size={14} />}</button>
      <EditScrubber label={`${source.short} position`} value={props.playhead} max={source.duration} text={editTc(props.playhead, fps, source.startFrames)}
        onScrub={props.onScrub} onScrubStart={props.onScrubStart} onScrubEnd={props.onScrubEnd} />
      <span className="cp-te-tools-tc">{editTc(props.playhead, fps, source.startFrames)}</span>
      <EditTextSettings pane="Source" style={props.text} onChange={props.onText} />
    </div>
    <div ref={body} className="cp-te-src-body" role="region" aria-label={`${source.short} transcript, read only`} tabIndex={0}
      onPointerDown={(event) => {
        const index = indexOf(event.target);
        if (index == null || event.button !== 0) return;
        props.onScrub(placed[index].word.start);
        if (event.altKey) { scrubbing.current = true; return; }
        if (!event.shiftKey || anchor.current == null) anchor.current = index;
        extend(index);
      }}
      onPointerMove={(event) => {
        if (!(event.buttons & 1)) return;
        const index = indexOf(event.target);
        if (index == null) return;
        if (scrubbing.current) return props.onScrub(placed[index].word.start);
        if (anchor.current != null) extend(index);
      }}
      onPointerUp={() => { scrubbing.current = false; }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && range) { event.preventDefault(); event.stopPropagation(); props.onRange(null); return; }
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const step = event.key === "ArrowLeft" ? -1 : 1;
        const from = range ? (anchor.current === range[0] ? range[1] : range[0]) : -1;
        const to = Math.max(0, Math.min(count - 1, from + step));
        if (!event.shiftKey || anchor.current == null) anchor.current = to;
        extend(to);
      }}>
      {paras.map((paragraph) => {
        const first = offset;
        offset += paragraph.words.length;
        const speaker = speakers.find((item) => item.id === paragraph.track)!;
        return <div key={paragraph.id} className="cp-te-src-para" style={{ "--te-speaker": colors[speaker.id] } as React.CSSProperties}>
          <div className="cp-te-src-head"><span className="cp-te-swatch" aria-hidden="true" />{speaker.name}
            <span className="cp-te-para-tc">{editTc(paragraph.words[0].word.start, fps, source.startFrames)}</span></div>
          <p className="cp-te-src-text">{paragraph.words.map((item, position) => {
            const index = first + position;
            const chosen = range != null && index >= range[0] && index <= range[1];
            return <span key={item.word.id}><span data-src-index={index}
              className={`cp-te-src-word${used.has(item.word.id) ? " is-used" : ""}${chosen ? " is-selected" : ""}${props.match === item.word.id ? " is-match" : ""}${current === item.word.id ? " is-current" : ""}`}>
              {props.corrections[item.word.id] ?? item.word.text}</span>{" "}</span>;
          })}</p>
        </div>;
      })}
    </div>
    <footer className="cp-te-src-foot">
      <span className="cp-te-pane-note" aria-live="polite">{range ? `${range[1] - range[0] + 1} selected` : `${inEdit}/${count} used`}</span>
      <div className="cp-te-src-actions">
        <button type="button" className="btn btn-ghost cp-te-btn" disabled={!range} onClick={props.onInsert}
          title="Insert at the edit's caret (V)">Insert<kbd className="cp-te-kbd">V</kbd></button>
        <button type="button" className="btn btn-ghost cp-te-btn" disabled={!range} onClick={props.onAppend}
          title="Append to the edit">Append</button>
      </div>
    </footer>
  </section>;
}
