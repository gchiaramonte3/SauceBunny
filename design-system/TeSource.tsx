import { useEffect, useMemo, useRef } from "react";
import { teTc } from "./transcript-editor-fixture";
import { paragraphs, placeWords, type TeEdit, type TeSpeaker, type TeWord } from "./transcript-editor-model";

type Props = {
  speakers: TeSpeaker[]; colors: Record<string, string>; fps: number; sourceBase: string;
  words: TeWord[]; scene: TeEdit; used: Set<string>; corrections: Record<string, string>;
  range: [number, number] | null; onRange: (range: [number, number] | null) => void;
  match: string | null; onInsert: () => void; onAppend: () => void;
  sequence: string;
};

/**
 * The SOURCE side of source/record: the whole scene, read-only. Words already
 * in the edit read at full strength and the rest are dimmed, so what the cut
 * left behind is visible at a glance. Select a line here and press V to put it
 * in the edit at the caret, the way a splice-in works in Media Composer.
 */
export function TeSource(props: Props) {
  const { speakers, colors, fps, words, scene, used, range } = props;
  const placed = useMemo(() => placeWords(words, scene), [words, scene]);
  const paras = useMemo(() => paragraphs(placed), [placed]);
  const anchor = useRef<number | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const count = placed.length;
  const inEdit = placed.filter((item) => used.has(item.word.id)).length;
  useEffect(() => {
    if (!props.match) return;
    body.current?.querySelector(".cp-te-src-word.is-match")?.scrollIntoView({ block: "center" });
  }, [props.match]);
  const indexOf = (target: EventTarget | null) => {
    const found = (target as HTMLElement | null)?.closest?.("[data-src-index]");
    return found ? Number(found.getAttribute("data-src-index")) : null;
  };
  const extend = (to: number) => props.onRange([Math.min(anchor.current ?? to, to), Math.max(anchor.current ?? to, to)]);
  let offset = 0;
  return <section className="cp-te-source" aria-labelledby="cp-te-source-title">
    <header className="cp-te-pane-head">
      <h2 id="cp-te-source-title" className="cp-te-pane-title">Source</h2>
      <span className="cp-te-pane-note" title={props.sequence}>{inEdit} of {count} words in the edit</span>
    </header>
    <div ref={body} className="cp-te-src-body" role="region" aria-label="Source transcript, read only" tabIndex={0}
      onPointerDown={(event) => {
        const index = indexOf(event.target);
        if (index == null || event.button !== 0) return;
        if (!event.shiftKey || anchor.current == null) anchor.current = index;
        extend(index);
      }}
      onPointerMove={(event) => {
        if (!(event.buttons & 1) || anchor.current == null) return;
        const index = indexOf(event.target);
        if (index != null) extend(index);
      }}
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
        const speaker = speakers.find((item) => item.id === paragraph.speaker)!;
        return <div key={paragraph.id} className="cp-te-src-para" style={{ "--te-speaker": colors[speaker.id] } as React.CSSProperties}>
          <div className="cp-te-src-head"><span className="cp-te-swatch" aria-hidden="true" />{speaker.name}
            <span className="cp-te-para-tc">{teTc(paragraph.words[0].word.start, fps, props.sourceBase)}</span></div>
          <p className="cp-te-src-text">{paragraph.words.map((item, position) => {
            const index = first + position;
            const chosen = range != null && index >= range[0] && index <= range[1];
            return <span key={item.word.id}><span data-src-index={index}
              className={`cp-te-src-word${used.has(item.word.id) ? " is-used" : ""}${chosen ? " is-selected" : ""}${props.match === item.word.id ? " is-match" : ""}`}>
              {props.corrections[item.word.id] ?? item.word.text}</span>{" "}</span>;
          })}</p>
        </div>;
      })}
    </div>
    <footer className="cp-te-src-foot">
      <span className="cp-te-pane-note" aria-live="polite">{range ? `${range[1] - range[0] + 1} words selected` : "Select words to use them in the edit."}</span>
      <div className="cp-te-src-actions">
        <button type="button" className="btn btn-ghost cp-te-btn" disabled={!range} onClick={props.onInsert}
          title="Insert the selected words at the edit's caret (V)">Insert at caret<kbd className="cp-te-kbd">V</kbd></button>
        <button type="button" className="btn btn-ghost cp-te-btn" disabled={!range} onClick={props.onAppend}
          title="Add the selected words to the end of the edit">Add to end</button>
      </div>
    </footer>
  </section>;
}
