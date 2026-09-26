import { teTc } from "./transcript-editor-fixture";
import { placementKey, type TeParagraph as Paragraph, type TePlacedWord, type TeSpeaker, type TeWord } from "./transcript-editor-model";

export type TeSeamInfo = { seconds: number | null; removed: TeWord[] };

type Props = {
  paragraph: Paragraph; speaker: TeSpeaker; color: string; fps: number;
  /** Index in program order of this paragraph's first word. */
  offset: number; range: [number, number] | null; caret: number | null; current: string | null;
  seams: Record<number, TeSeamInfo>; showRemoved: boolean; seam: number | null; onSeam: (index: number) => void;
  corrections: Record<string, string>; editing: string | null; onCorrect: (id: string, text: string | null) => void;
  onMove: (direction: -1 | 1) => void; first: boolean; last: boolean;
};

const dots = (gap: number) => gap >= 1.5 ? "•••" : gap >= 0.8 ? "••" : gap >= 0.35 ? "•" : "";

/**
 * One speaker's run of words. Words are plain spans, not a contenteditable:
 * the edit model owns the text and the spans only show it. A cut is drawn
 * inline where it happened, so no edit is ever invisible, and a pause shows
 * as dots scaled to its length.
 */
export function TeParagraph(props: Props) {
  const { paragraph, speaker, color, fps, offset, range, caret, current } = props;
  const start = paragraph.words[0].programStart;
  const between = (previous: TePlacedWord | null, item: TePlacedWord) => {
    if (previous ? previous.segment !== item.segment : paragraph.cutBefore) {
      const info = props.seams[item.segment];
      const label = info?.seconds == null ? "Edit point, a jump to another part of the scene"
        : info.seconds > 0 ? `Cut, ${info.seconds.toFixed(2)} s removed` : "Through edit, nothing removed";
      return <>
        <button type="button" className={`cp-te-cutmark${props.seam === item.segment ? " is-selected" : ""}`} aria-label={label} title={`${label}. Select to restore.`} onClick={() => props.onSeam(item.segment)}>¦</button>
        {props.showRemoved && info?.removed.map((word) => <span key={word.id} className="cp-te-word is-removed" title="Removed. Select the cut to restore it.">{word.text} </span>)}
      </>;
    }
    const gap = previous ? item.programStart - previous.programEnd : 0;
    return dots(gap) ? <span className="cp-te-pause" title={`${gap.toFixed(1)} s pause`}>{dots(gap)} </span> : null;
  };
  return <section className="cp-te-para" style={{ "--te-speaker": color } as React.CSSProperties} aria-label={`${speaker.name}, ${teTc(start, fps)}`}>
    <header className="cp-te-para-head">
      <span className="cp-te-swatch" aria-hidden="true" />
      <span className="cp-te-para-name">{speaker.name}</span>
      <span className="cp-te-para-tc">{teTc(start, fps)}</span>
      <span className="cp-te-para-moves">
        <button type="button" className="cp-te-para-move" disabled={props.first} aria-label={`Move ${speaker.name}'s paragraph up`} title="Move up (⌥↑)" onClick={() => props.onMove(-1)}>↑</button>
        <button type="button" className="cp-te-para-move" disabled={props.last} aria-label={`Move ${speaker.name}'s paragraph down`} title="Move down (⌥↓)" onClick={() => props.onMove(1)}>↓</button>
      </span>
    </header>
    <p className="cp-te-para-text">
      {paragraph.words.map((item, position) => {
        const index = offset + position;
        const selected = range != null && index >= range[0] && index <= range[1];
        const text = props.corrections[item.word.id] ?? item.word.text;
        const className = `cp-te-word${selected ? " is-selected" : ""}${current === placementKey(item) ? " is-current" : ""}${item.muted ? " is-lifted" : ""}${props.corrections[item.word.id] ? " is-corrected" : ""}`;
        return <span key={placementKey(item)}>
          {between(position ? paragraph.words[position - 1] : null, item)}
          {caret === index && <span className="cp-te-caret" aria-hidden="true" />}
          {props.editing === item.word.id
            ? <input className="cp-te-correct" autoFocus defaultValue={text} style={{ width: `${Math.max(4, text.length + 2)}ch` }} aria-label={`Correct the text of "${item.word.text}"`}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") props.onCorrect(item.word.id, event.currentTarget.value.trim() || null);
                if (event.key === "Escape") props.onCorrect(item.word.id, props.corrections[item.word.id] ?? null);
              }}
              onBlur={(event) => props.onCorrect(item.word.id, event.currentTarget.value.trim() || null)} />
            : <span className={className} data-index={index} title={item.muted ? `Removed from ${speaker.name}'s track only` : undefined}>{text}</span>}{" "}
        </span>;
      })}
      {props.last && caret === offset + paragraph.words.length && <span className="cp-te-caret" aria-hidden="true" />}
    </p>
  </section>;
}
