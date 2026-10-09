import { memo } from "react";
import { editTc } from "../lib/edit-document";
import { placementKey, type Ghost, type TimelineParagraph as Paragraph, type PlacedWord, type TimelineLane } from "../lib/edit-model";
import { EditGhost } from "./EditGhost";

export type EditSeamInfo = { kind: "cut" | "through" | "jump" | "gap"; seconds: number | null };

type Props = {
  paragraph: Paragraph; speaker: TimelineLane; color: string; fps: number; recordStart: number;
  /** Shown when this paragraph comes from a different source than the one before it. */
  sourceLabel: string | null;
  /** Index in program order of this paragraph's first word. */
  offset: number; range: [number, number] | null; caret: number | null; caretAfter: boolean; current: string | null;
  seams: Record<number, EditSeamInfo>; seam: number | null; onSeam: (index: number) => void;
  /** Removed lines that belong between two segments, when removed lines are shown. */
  ghosts: (after: number, upTo: number) => Ghost[]; onRestore: (ghost: Ghost) => void; nameOf: (id: string) => string;
  corrections: Record<string, string>; editing: string | null; onCorrect: (id: string, text: string | null) => void;
  /** This paragraph's index, for onMove. */
  index: number; onMove: (paragraph: number, direction: -1 | 1) => void; first: boolean; last: boolean;
};

const dots = (gap: number) => gap >= 1.5 ? "•••" : gap >= 0.8 ? "••" : gap >= 0.35 ? "•" : "";

/**
 * One speaker's run of words. Words are plain spans, not a contenteditable:
 * the edit model owns the text and the spans only draw it. What a cut took
 * out stays in place, struck through, until you restore it or hide removed
 * lines; with them hidden, a ¦ still marks where the cut is.
 */
/**
 * Memoised, and that is measured rather than preemptive: playing a whole
 * 50-mic sequence (457,253 words) cost the page 58-90% of a core, because each
 * new word under the playhead re-rendered every word on the drawn pages. The
 * document hands each paragraph only what concerns it (the current word,
 * range and caret when they fall inside it, null otherwise) and stable
 * callbacks, so a playhead step re-renders the two paragraphs it leaves and
 * enters and nothing else.
 */
export const EditParagraph = memo(function EditParagraph(props: Props) {
  const { paragraph, speaker, color, fps, offset, range, caret, current } = props;
  const start = paragraph.words[0].programStart;
  const caretMark = <span className="cp-te-caret" aria-hidden="true" />;
  const mark = (index: number) => {
    const info = props.seams[index];
    if (!info || info.kind === "through") return null;
    const label = info.kind === "gap" ? "Gap" : info.kind === "jump" ? "Jump" : `Cut, ${(info.seconds ?? 0).toFixed(2)} s removed`;
    return <button type="button" className={`cp-te-cutmark${props.seam === index ? " is-selected" : ""}`} aria-label={label} title={label}
      onClick={() => props.onSeam(index)}>¦</button>;
  };
  const between = (previous: PlacedWord | null, item: PlacedWord) => {
    // A cut at the top of the paragraph: its removed lines are drawn above it by the document.
    if (!previous) return paragraph.cutBefore && !props.ghosts(item.segment - 1, item.segment).length ? mark(item.segment) : null;
    // A segment boundary this person's audio runs straight through (an edit
    // on someone else's track alone) is no cut in their line.
    if (previous.segment !== item.segment && previous.clip !== item.clip) {
      const ghosts = props.ghosts(previous.segment, item.segment);
      if (ghosts.length) return ghosts.map((ghost) => <EditGhost key={ghost.id} ghost={ghost} who={ghost.track !== paragraph.track ? props.nameOf(ghost.track) : null}
        color={color} onRestore={props.onRestore} />);
      return mark(item.segment);
    }
    const gap = item.programStart - previous.programEnd;
    return dots(gap) ? <span className="cp-te-pause" title={`${gap.toFixed(1)} s pause`}>{dots(gap)} </span> : null;
  };
  return <section className="cp-te-para" style={{ "--te-speaker": color } as React.CSSProperties} aria-label={`${speaker.name}, ${editTc(start, fps, props.recordStart)}`}>
    <header className="cp-te-para-head">
      <span className="cp-te-swatch" aria-hidden="true" />
      <span className="cp-te-para-name">{speaker.name}</span>
      <span className="cp-te-para-tc">{editTc(start, fps, props.recordStart)}</span>
      {props.sourceLabel && <span className="cp-te-para-source" title="Comes from this source">{props.sourceLabel}</span>}
      <span className="cp-te-para-moves">
        <button type="button" className="cp-te-para-move" disabled={props.first} aria-label={`Move ${speaker.name}'s paragraph up`} title="Move up (⌥↑)" onClick={() => props.onMove(props.index, -1)}>↑</button>
        <button type="button" className="cp-te-para-move" disabled={props.last} aria-label={`Move ${speaker.name}'s paragraph down`} title="Move down (⌥↓)" onClick={() => props.onMove(props.index, 1)}>↓</button>
      </span>
    </header>
    <p className="cp-te-para-text">
      {paragraph.words.map((item, position) => {
        const index = offset + position;
        const selected = range != null && index >= range[0] && index <= range[1];
        const text = props.corrections[item.word.id] ?? item.word.text;
        const className = `cp-te-word${selected ? " is-selected" : ""}${selected && index < range![1] ? " is-joined" : ""}${current === placementKey(item) ? " is-current" : ""}${item.muted ? " is-lifted" : ""}${props.corrections[item.word.id] ? " is-corrected" : ""}`;
        return <span key={placementKey(item)}>
          {between(position ? paragraph.words[position - 1] : null, item)}
          {caret === index && !props.caretAfter && caretMark}
          {props.editing === item.word.id
            ? <input className="cp-te-correct" autoFocus defaultValue={text} style={{ width: `${Math.max(4, text.length + 2)}ch` }} aria-label={`Correct the text of "${item.word.text}"`}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") props.onCorrect(item.word.id, event.currentTarget.value.trim() || null);
                if (event.key === "Escape") props.onCorrect(item.word.id, props.corrections[item.word.id] ?? null);
              }}
              onBlur={(event) => props.onCorrect(item.word.id, event.currentTarget.value.trim() || null)} />
            : <span className={className} data-index={index} title={item.muted ? `Muted (${speaker.name} only)` : undefined}>{text}</span>}
          {caret === index + 1 && props.caretAfter && caretMark}{" "}
        </span>;
      })}
      {props.last && caret === offset + paragraph.words.length && !props.caretAfter && caretMark}
    </p>
  </section>;
});
