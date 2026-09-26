import { useRef } from "react";
import type { TeParagraph as Paragraph, TePlacedWord, TeSpeaker } from "./transcript-editor-model";
import { TeParagraph, type TeSeamInfo } from "./TeParagraph";

/** A caret sits BEFORE word `anchor` when collapsed; otherwise words anchor..focus are selected. */
export type TeSelection = { anchor: number; focus: number; collapsed: boolean };

type Props = {
  speakers: TeSpeaker[]; colors: Record<string, string>; fps: number;
  paragraphs: Paragraph[]; placed: TePlacedWord[]; selection: TeSelection; current: string | null;
  seams: Record<number, TeSeamInfo>; showRemoved: boolean; seam: number | null; onSeam: (index: number) => void;
  corrections: Record<string, string>; editing: string | null; onCorrect: (id: string, text: string | null) => void;
  onSelect: (selection: TeSelection, seek: boolean) => void; onDelete: (lift: boolean) => void;
  onMove: (paragraph: number, direction: -1 | 1) => void; onEdit: (id: string) => void;
};

/**
 * The edit, as text. Selection snaps to whole words; a click puts the caret
 * (and the playhead) before a word, a drag or ⇧-arrow selects, ⌫ deletes as a
 * ripple on every track and ⇧⌫ removes from that speaker's track only.
 */
export function TeDocument(props: Props) {
  const { placed, selection } = props;
  const drag = useRef<number | null>(null);
  const count = placed.length;
  const range: [number, number] | null = selection.collapsed ? null
    : [Math.min(selection.anchor, selection.focus), Math.max(selection.anchor, selection.focus)];
  const caret = selection.collapsed ? selection.anchor : null;
  const indexOf = (target: EventTarget | null) => {
    const found = (target as HTMLElement | null)?.closest?.("[data-index]");
    return found ? Number(found.getAttribute("data-index")) : null;
  };
  const paragraphOf = (index: number) => {
    let seen = 0;
    return props.paragraphs.findIndex((paragraph) => (seen += paragraph.words.length) > index);
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
      }
      return props.onDelete(event.shiftKey);
    }
    if (event.key === "Enter" && range && range[0] === range[1]) { event.preventDefault(); return props.onEdit(placed[range[0]].word.id); }
    if (event.key === "Escape" && range) { event.preventDefault(); return props.onSelect({ anchor: range[0], focus: range[0], collapsed: true }, false); }
    if (event.key.toLowerCase() === "a" && event.metaKey && count) { event.preventDefault(); return props.onSelect({ anchor: 0, focus: count - 1, collapsed: false }, false); }
  };
  let offset = 0;
  return <div className="cp-te-doc" role="region" aria-label="Edit transcript" aria-describedby="cp-te-doc-help" tabIndex={0} onKeyDown={keys}
    onPointerDown={(event) => {
      const index = indexOf(event.target);
      if (index == null || event.button !== 0) return;
      if (event.shiftKey) return props.onSelect({ anchor: selection.collapsed ? selection.anchor : selection.anchor, focus: index, collapsed: false }, false);
      drag.current = index;
      props.onSelect({ anchor: index, focus: index, collapsed: true }, true);
    }}
    onPointerMove={(event) => {
      if (drag.current == null || !(event.buttons & 1)) return;
      const index = indexOf(event.target);
      if (index != null && (index !== drag.current || !selection.collapsed)) props.onSelect({ anchor: drag.current, focus: index, collapsed: false }, false);
    }}
    onPointerUp={() => { drag.current = null; }}
    onDoubleClick={(event) => { const index = indexOf(event.target); if (index != null) props.onSelect({ anchor: index, focus: index, collapsed: false }, false); }}>
    <p id="cp-te-doc-help" className="cp-visually-hidden">Arrow keys move by word, Shift extends, Delete removes from every track, Shift-Delete removes from one speaker's track, Option-Up and Option-Down move a paragraph, Return corrects a word's text.</p>
    {props.paragraphs.map((paragraph, index) => {
      const first = offset;
      offset += paragraph.words.length;
      const speaker = props.speakers.find((item) => item.id === paragraph.speaker)!;
      return <TeParagraph key={paragraph.id} paragraph={paragraph} speaker={speaker} color={props.colors[speaker.id]} fps={props.fps}
        offset={first} range={range} caret={caret} current={props.current} seams={props.seams} showRemoved={props.showRemoved}
        seam={props.seam} onSeam={props.onSeam} corrections={props.corrections} editing={props.editing} onCorrect={props.onCorrect}
        first={index === 0} last={index === props.paragraphs.length - 1} onMove={(direction) => props.onMove(index, direction)} />;
    })}
  </div>;
}
