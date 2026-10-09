import { useCallback, useMemo, useRef, useState } from "react";
import { useFrame } from "../hooks/use-frame";
import { firstAbove, paragraphHolding, sentenceAround, paragraphStarts, placementKey, runningEnds, wordUnder, type Ghost, type TimelineParagraph as Paragraph, type PlacedWord, type TimelineLane } from "../lib/edit-model";
import type { FrameStore } from "../lib/frame-store";
import { ghostsAbove, ghostsIn, indexGhosts, paragraphSizes } from "../lib/edit-ghost-index";
import { EditGhost } from "./EditGhost";
import { EditParagraph, type EditSeamInfo } from "./EditParagraph";
import { EditWindowedParagraphs } from "./EditWindowedParagraphs";
import { EditWordMenu } from "./EditWordMenu";

/**
 * A caret sits BEFORE word `anchor` when collapsed, or right after word
 * `anchor - 1` when `after` is set (where a deletion leaves it: at the end of
 * the line you were on, not the start of the next one). Otherwise words
 * anchor..focus are selected.
 */
export type EditSelection = { anchor: number; focus: number; collapsed: boolean; after?: boolean };

type Props = {
  speakers: TimelineLane[]; colors: Record<string, string>; fps: number; recordStart: number;
  paragraphs: Paragraph[]; placed: PlacedWord[]; selection: EditSelection;
  /** The record playhead, in frames: the text redraws when it crosses a word, to mark the word and move the caret. */
  frames: FrameStore;
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

/**
 * The edit, as text. A click puts the caret (and the playhead) before a word;
 * a drag or ⇧-arrow selects; a double-click selects that line and a triple
 * click the whole paragraph. ⌫ cuts the time from every track, ⇧⌫ mutes
 * one speaker's words (or unmutes them), and ⌥-drag scrubs the playhead
 * through the text. A right-click on a line offers the same Mute or Unmute.
 */
export function EditTranscript(props: Props) {
  const { placed } = props;
  const latestEnds = useMemo(() => runningEnds(placed), [placed]), at = (frame: number) => frame / props.fps;
  const parked = useFrame(props.frames, (frame) => firstAbove(latestEnds, at(frame) + 1e-6)), playingIndex = useFrame(props.frames, (frame) => wordUnder(placed, latestEnds, at(frame)));
  // With no range chosen the caret is wherever the playhead is, as the workspace's is; this one is live.
  const selection = props.selection.collapsed && props.selection.anchor !== parked ? { anchor: parked, focus: parked, collapsed: true } : props.selection;
  const current = playingIndex < 0 ? null : placementKey(placed[playingIndex]);
  const drag = useRef<{ index: number; scrub: boolean } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // Drawn a page at a time (EditWindowedParagraphs), removed lines included: a real 20-mic sequence cut in whole is 146k words.
  const firsts = useMemo(() => paragraphStarts(props.paragraphs), [props.paragraphs]), ghosts = useMemo(() => indexGhosts(props.ghosts), [props.ghosts]);
  // A paragraph nobody hears (every word muted, as Focus on Marked Lines
  // leaves the rest of a crowd) is out of the cut like a removed line, and is
  // shown only with them, so the record reads as what plays.
  const unheard = useMemo(() => props.paragraphs.map((paragraph) => props.ghosts === null && paragraph.words.every((item) => item.muted)), [props.paragraphs, props.ghosts]);
  const sizes = useMemo(() => paragraphSizes(props.paragraphs, ghosts).map((size, index) => unheard[index] ? 0 : size), [props.paragraphs, ghosts, unheard]);
  const playing = playingIndex < 0 ? null : playingIndex, count = placed.length;
  const range: [number, number] | null = selection.collapsed ? null
    : [Math.min(selection.anchor, selection.focus), Math.max(selection.anchor, selection.focus)];
  const caret = selection.collapsed ? selection.anchor : null;
  const nameOf = useCallback((id: string) => props.speakers.find((speaker) => speaker.id === id)?.name ?? id, [props.speakers]);
  const ghostsBetween = useCallback((after: number, upTo: number) => ghostsIn(ghosts, after, upTo), [ghosts]);
  // Paragraphs are memoised (EditParagraph), so what they are handed must not
  // change identity on every render. The latest props are read at call time.
  const latest = useRef(props); latest.current = props;
  const onSeam = useCallback((index: number) => latest.current.onSeam(index), []);
  const onRestore = useCallback((ghost: Ghost) => latest.current.onRestore(ghost), []);
  const onCorrect = useCallback((id: string, text: string | null) => latest.current.onCorrect(id, text), []);
  const onMove = useCallback((paragraph: number, direction: -1 | 1) => latest.current.onMove(paragraph, direction), []);
  const indexOf = (target: EventTarget | null) => {
    const found = (target as HTMLElement | null)?.closest?.("[data-index]");
    return found ? Number(found.getAttribute("data-index")) : null;
  };
  const paragraphOf = (index: number) => paragraphHolding(firsts, index) ?? -1;
  // Right-click: Mute or Unmute the line under the pointer, or the selection
  // when the pointer is inside it, as ⇧⌫ would.
  const [menu, setMenu] = useState<{ x: number; y: number; words: [number, number] } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const lineAround = (index: number): [number, number] => {
    if (range && index >= range[0] && index <= range[1]) return range;
    const paragraph = paragraphOf(index), first = firsts[paragraph], last = first + props.paragraphs[paragraph].words.length - 1;
    const same = (other: number) => placed[other].word.track === placed[index].word.track && placed[other].muted === placed[index].muted
      && placed[other].word.cue === placed[index].word.cue;
    let from = index, to = index;
    while (from > first && same(from - 1)) from--;
    while (to < last && same(to + 1)) to++;
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
  const ghostLine = (ghost: Ghost) => <EditGhost key={ghost.id} ghost={ghost} who={nameOf(ghost.track)} color={props.colors[ghost.track]} onRestore={props.onRestore} line />;
  const lastSegment = placed.length ? placed[placed.length - 1].segment : -1;
  return <div ref={root} className="cp-te-doc" role="region" aria-label="Edit transcript" aria-describedby="cp-te-doc-help" tabIndex={0} onKeyDown={keys}
    onContextMenu={(event) => {
      const index = indexOf(event.target);
      if (index == null) return;
      event.preventDefault();
      setMenu({ x: event.clientX, y: event.clientY, words: lineAround(index) });
    }}
    onPointerDown={(event) => {
      const index = indexOf(event.target);
      // A Control-click is the Mac's right-click: it opens the menu and leaves the selection as it is.
      if (index == null || event.button !== 0 || event.ctrlKey) return;
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
      if (event.detail === 2) { const [from, to] = sentenceAround(placed, firsts, props.paragraphs, index); props.onSelect({ anchor: from, focus: to, collapsed: false }, false); }
      if (event.detail === 3) {
        const paragraph = paragraphOf(index), first = firsts[paragraph];
        props.onSelect({ anchor: first, focus: first + props.paragraphs[paragraph].words.length - 1, collapsed: false }, false);
      }
    }}>
    <p id="cp-te-doc-help" className="cp-visually-hidden">Arrows move by word. Double-click a line, triple-click a paragraph. Delete cuts all tracks; Shift-Delete one speaker. Option-drag scrubs. Option-Up/Down moves a paragraph. Words are corrected in AAF Audio's transcript.</p>
    <EditWindowedParagraphs root={root} sizes={sizes}
      keep={[playing, selection.anchor, selection.focus].map((index) => paragraphHolding(firsts, index))}
      render={(index) => {
      if (unheard[index]) return null;
      const paragraph = props.paragraphs[index], first = firsts[index];
      const speaker = props.speakers.find((item) => item.id === paragraph.track)!;
      const previous = index ? props.paragraphs[index - 1] : null;
      const previousWord = previous?.words[previous.words.length - 1];
      const source = paragraph.words[0].word.source;
      // Only what falls inside this paragraph, so the rest skip re-rendering.
      const end = first + paragraph.words.length;
      const inside = (at: number | null) => at != null && at >= first && at <= end ? at : null;
      const mine = range && range[0] < end && range[1] >= first ? range : null;
      const playingHere = playing != null && playing >= first && playing < end ? current : null;
      return <div key={paragraph.id} className="cp-te-para-wrap">
        {ghostsAbove(props.paragraphs, ghosts, index).map(ghostLine)}
        <EditParagraph paragraph={paragraph} speaker={speaker} color={props.colors[speaker.id]} fps={props.fps} recordStart={props.recordStart}
          sourceLabel={!previousWord || previousWord.word.source !== source ? props.sourceLabel(source) : null}
          offset={first} range={mine} caret={inside(caret)} caretAfter={!!selection.after} current={playingHere} seams={props.seams}
          seam={props.seam} onSeam={onSeam} ghosts={ghostsBetween} onRestore={onRestore} nameOf={nameOf}
          corrections={props.corrections} editing={props.editing} onCorrect={onCorrect}
          index={index} first={index === 0} last={index === props.paragraphs.length - 1} onMove={onMove} />
      </div>;
    }} />
    {ghostsBetween(lastSegment, Infinity).map(ghostLine)}
    {menu && placed[menu.words[0]] && <EditWordMenu at={menu} who={nameOf(placed[menu.words[0]].word.track)} onClose={closeMenu}
      muted={placed.slice(menu.words[0], menu.words[1] + 1).every((item) => item.muted)}
      onToggle={() => {
        props.onSelect({ anchor: menu.words[0], focus: menu.words[1], collapsed: false }, false);
        props.onDelete(true, menu.words);
      }} />}
    {!props.paragraphs.length && <p className="cp-te-doc-empty">{props.hasCut
      ? "Nothing cut in here has words: its mics are not transcribed yet, or are off a track. Transcribe them in AAF Audio."
      : "Empty. Select lines in a source, then Insert (V) or Append."}</p>}
  </div>;
}
