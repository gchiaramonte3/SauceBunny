import { useMemo, useRef } from "react";
import { paragraphHolding, paragraphStarts, placementKey, type Ghost, type TimelineParagraph as Paragraph, type PlacedWord, type TimelineLane } from "../lib/edit-model";
import { EditGhostLine } from "./EditGhostLine";
import { EditParagraph, type EditSeamInfo } from "./EditParagraph";
import { EditWindowedParagraphs } from "./EditWindowedParagraphs";

/**
 * A caret sits BEFORE word `anchor` when collapsed, or right after word
 * `anchor - 1` when `after` is set (where a deletion leaves it: at the end of
 * the line you were on, not the start of the next one). Otherwise words
 * anchor..focus are selected.
 */
export type EditSelection = { anchor: number; focus: number; collapsed: boolean; after?: boolean };

type Props = {
  speakers: TimelineLane[]; colors: Record<string, string>; fps: number; recordStart: number;
  paragraphs: Paragraph[]; placed: PlacedWord[]; selection: EditSelection; current: string | null;
  /** Some source time is cut in, whether or not any of it has words. */
  hasCut?: boolean;
  sourceLabel: (source: string) => string;
  seams: Record<number, EditSeamInfo>; seam: number | null; onSeam: (index: number) => void;
  /** Removed lines to show in place, or null while they are hidden. */
  ghosts: Ghost[] | null; onRestore: (ghost: Ghost) => void;
  corrections: Record<string, string>; editing: string | null; onCorrect: (id: string, text: string | null) => void;
  onSelect: (selection: EditSelection, seek: boolean) => void; onDelete: (lift: boolean, words?: [number, number]) => void; onScrub: (program: number) => void;
  onMove: (paragraph: number, direction: -1 | 1) => void; onEdit: (id: string) => void;
};

const ends = (text: string) => /[.!?]["”']?$/.test(text);

/**
 * The edit, as text. A click puts the caret (and the playhead) before a word;
 * a drag or ⇧-arrow selects; a double-click selects that line and a triple
 * click the whole paragraph. ⌫ cuts the time from every track, ⇧⌫ silences
 * one speaker's words, and ⌥-drag scrubs the playhead through the text.
 */
export function EditTranscript(props: Props) {
  const { placed, selection } = props;
  const drag = useRef<{ index: number; scrub: boolean } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // Drawn a page at a time (EditWindowedParagraphs): a real 20-mic sequence cut in whole is 146k words.
  const firsts = useMemo(() => paragraphStarts(props.paragraphs), [props.paragraphs]);
  const sizes = useMemo(() => props.paragraphs.map((paragraph) => paragraph.words.length), [props.paragraphs]);
  const playing = props.current == null ? null : placed.findIndex((item) => placementKey(item) === props.current);
  const count = placed.length;
  const range: [number, number] | null = selection.collapsed ? null
    : [Math.min(selection.anchor, selection.focus), Math.max(selection.anchor, selection.focus)];
  const caret = selection.collapsed ? selection.anchor : null;
  const nameOf = (id: string) => props.speakers.find((speaker) => speaker.id === id)?.name ?? id;
  const ghostsBetween = (after: number, upTo: number) => props.ghosts?.filter((ghost) => ghost.at > after && ghost.at <= upTo) ?? [];
  const indexOf = (target: EventTarget | null) => {
    const found = (target as HTMLElement | null)?.closest?.("[data-index]");
    return found ? Number(found.getAttribute("data-index")) : null;
  };
  const paragraphOf = (index: number) => paragraphHolding(firsts, index) ?? -1;
  const lineAround = (index: number): [number, number] => {
    const paragraph = paragraphOf(index);
    const first = firsts[paragraph], last = first + props.paragraphs[paragraph].words.length - 1;
    let from = index, to = index;
    while (from > first && !ends(placed[from - 1].word.text)) from--;
    while (to < last && !ends(placed[to].word.text)) to++;
    return [from, to];
  };
  const keys = (event: React.KeyboardEvent) => {
    const at = range ? (event.key === "ArrowLeft" ? range[0] : range[1] + 1) : selection.anchor;
    const move = (to: number, extend: boolean) => {
      event.preventDefault();
      const clamped = Math.max(0, Math.min(count, to));
      if (!extend) return props.onSelect({ anchor: clamped, focus: clamped, collapsed: true }, true);
      const anchor = selection.collapsed ? (to < selection.anchor ? selection.anchor - 1 : selection.anchor) : selection.anchor;
      const focus = selection.collapsed ? Math.max(0, Math.min(count - 1, to < selection.anchor ? to : selection.anchor)) : Math.max(0, Math.min(count - 1, selection.focus + (to > at - 1 ? 1 : -1)));
      props.onSelect({ anchor: Math.max(0, Math.min(count - 1, anchor)), focus, collapsed: false }, false);
    };
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const step = event.key === "ArrowLeft" ? -1 : 1;
      if (event.shiftKey) return move(selection.collapsed ? selection.anchor + step : selection.focus + step, true);
      return move(range ? at : selection.anchor + step, false);
    }
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && event.altKey) {
      event.preventDefault();
      return props.onMove(paragraphOf(range ? range[0] : Math.min(selection.anchor, count - 1)), event.key === "ArrowUp" ? -1 : 1);
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      if (!range) {
        const target = event.key === "Backspace" ? selection.anchor - 1 : selection.anchor;
        if (target < 0 || target >= count) return;
        props.onSelect({ anchor: target, focus: target, collapsed: false }, false);
        // The selection above lands on the next render; name the word outright.
        return props.onDelete(event.shiftKey, [target, target]);
      }
      return props.onDelete(event.shiftKey);
    }
    if (event.key === "Enter" && range && range[0] === range[1]) { event.preventDefault(); return props.onEdit(placed[range[0]].word.id); }
    if (event.key === "Escape" && range) { event.preventDefault(); return props.onSelect({ anchor: range[0], focus: range[0], collapsed: true }, false); }
    if (event.key.toLowerCase() === "a" && event.metaKey && count) { event.preventDefault(); return props.onSelect({ anchor: 0, focus: count - 1, collapsed: false }, false); }
  };
  const ghostLine = (ghost: Ghost) => <EditGhostLine key={ghost.id} ghost={ghost} color={props.colors[ghost.track]} name={nameOf(ghost.track)} onRestore={props.onRestore} />;
  const lastSegment = placed.length ? placed[placed.length - 1].segment : -1;
  return <div ref={root} className="cp-te-doc" role="region" aria-label="Edit transcript" aria-describedby="cp-te-doc-help" tabIndex={0} onKeyDown={keys}
    onPointerDown={(event) => {
      const index = indexOf(event.target);
      if (index == null || event.button !== 0) return;
      if (event.altKey) { drag.current = { index, scrub: true }; return props.onScrub(placed[index].programStart); }
      if (event.shiftKey) return props.onSelect({ anchor: selection.anchor, focus: index, collapsed: false }, false);
      drag.current = { index, scrub: false };
      props.onSelect({ anchor: index, focus: index, collapsed: true }, true);
    }}
    onPointerMove={(event) => {
      if (drag.current == null || !(event.buttons & 1)) return;
      const index = indexOf(event.target);
      if (index == null) return;
      if (drag.current.scrub) return props.onScrub(placed[index].programStart);
      if (index !== drag.current.index || !selection.collapsed) props.onSelect({ anchor: drag.current.index, focus: index, collapsed: false }, false);
    }}
    onPointerUp={() => { drag.current = null; }}
    onClick={(event) => {
      const index = indexOf(event.target);
      if (index == null || event.altKey) return;
      if (event.detail === 2) { const [from, to] = lineAround(index); props.onSelect({ anchor: from, focus: to, collapsed: false }, false); }
      if (event.detail === 3) {
        const paragraph = paragraphOf(index), first = firsts[paragraph];
        props.onSelect({ anchor: first, focus: first + props.paragraphs[paragraph].words.length - 1, collapsed: false }, false);
      }
    }}>
    <p id="cp-te-doc-help" className="cp-visually-hidden">Arrows move by word. Double-click a line, triple-click a paragraph. Delete cuts all tracks; Shift-Delete one speaker. Option-drag scrubs. Option-Up/Down moves a paragraph. Return corrects a word.</p>
    <EditWindowedParagraphs root={root} sizes={sizes}
      keep={[playing, selection.anchor, selection.focus].map((index) => paragraphHolding(firsts, index))}
      render={(index) => {
      const paragraph = props.paragraphs[index], first = firsts[index];
      const speaker = props.speakers.find((item) => item.id === paragraph.track)!;
      const previous = index ? props.paragraphs[index - 1] : null;
      const previousWord = previous?.words[previous.words.length - 1];
      const source = paragraph.words[0].word.source;
      return <div key={paragraph.id} className="cp-te-para-wrap">
        {ghostsBetween(previousWord?.segment ?? -1, previousWord && previousWord.segment === paragraph.words[0].segment ? -1 : paragraph.words[0].segment).map(ghostLine)}
        <EditParagraph paragraph={paragraph} speaker={speaker} color={props.colors[speaker.id]} fps={props.fps} recordStart={props.recordStart}
          sourceLabel={!previousWord || previousWord.word.source !== source ? props.sourceLabel(source) : null}
          offset={first} range={range} caret={caret} caretAfter={!!selection.after} current={props.current} seams={props.seams}
          seam={props.seam} onSeam={props.onSeam} ghosts={ghostsBetween} onRestore={props.onRestore} nameOf={nameOf}
          corrections={props.corrections} editing={props.editing} onCorrect={props.onCorrect}
          first={index === 0} last={index === props.paragraphs.length - 1} onMove={(direction) => props.onMove(index, direction)} />
      </div>;
    }} />
    {ghostsBetween(lastSegment, Infinity).map(ghostLine)}
    {!props.paragraphs.length && <p className="cp-te-doc-empty">{props.hasCut
      ? "Nothing cut in here has words: its mics are not transcribed yet, or are off a track. Transcribe them in AAF Audio."
      : "Empty. Select lines in a source, then Insert (V) or Append."}</p>}
  </div>;
}
