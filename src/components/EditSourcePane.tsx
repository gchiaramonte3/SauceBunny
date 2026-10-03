import { useEffect, useId, useMemo, useRef } from "react";
import { editTc } from "../lib/edit-document";
import { paragraphHolding, paragraphs, paragraphStarts, type PlacedWord, type TimelineLane } from "../lib/edit-model";
import { ALL_VOICES } from "../lib/edit-source-view";
import type { MultitrackPerson } from "../lib/multitrack-person";
import { EditScrubber } from "./EditScrubber";
import { MultitrackTranscriptTabs } from "./MultitrackTranscriptTabs";
import { EditWindowedParagraphs } from "./EditWindowedParagraphs";
import { EditTextSettings, editTextVars, type EditTextStyle } from "./EditTextSettings";
import { IconPause, IconPlay } from "./Icons";

/** A source as the pane needs it: its name, length in seconds, and start timecode in frames. */
export type EditSourceInfo = { id: string; short: string; duration: number; startFrames: number };

type Props = {
  source: EditSourceInfo; speakers: TimelineLane[]; colors: Record<string, string>; fps: number;
  /** What the chosen tab shows, in the order it shows it: range indexes count into this. */
  placed: PlacedWord[]; used: Set<string>; corrections: Record<string, string>;
  /** AAF Audio's transcript tabs: All voices, then everyone with a mic in this source. */
  people: MultitrackPerson[]; tab: string; onTab: (tab: string) => void;
  /** Words still being read, as mics done of mics in all; null once every mic is read. */
  reading: { done: number; total: number } | null;
  range: [number, number] | null; onRange: (range: [number, number] | null) => void; match: string | null;
  /** Something is marked, as text or as In and Out on the source timeline. */
  canInsert: boolean;
  playhead: number; playing: boolean; onPlay: () => void; onScrub: (seconds: number) => void; onScrubStart: () => void; onScrubEnd: () => void;
  text: EditTextStyle; onText: (style: EditTextStyle) => void; onPlace: (how: "insert" | "append" | "overwrite") => void;
};

/**
 * The SOURCE side of source/record: one source, read-only, with its own
 * playhead, read a person at a time through AAF Audio's transcript tabs.
 * Words already in the edit read at full strength and the rest are dimmed,
 * so what the cut left behind shows at a glance. Click a word to park the
 * source there, ⌥-drag to scrub, select a line and press V to splice it in
 * at the record playhead, or B to overwrite there, as in Media Composer.
 */
export function EditSourcePane(props: Props) {
  const { source, speakers, colors, fps, used, range, placed } = props;
  // A person's tab reads one line per cue, as AAF Audio lists them.
  const paras = useMemo(() => paragraphs(placed, props.tab !== ALL_VOICES), [placed, props.tab]);
  const panelId = useId();
  const person = props.people.find((item) => item.id === props.tab);
  const anchor = useRef<number | null>(null);
  const scrubbing = useRef(false);
  const body = useRef<HTMLDivElement>(null);
  const count = placed.length;
  const inEdit = placed.filter((item) => used.has(item.word.id)).length;
  const current = placed.find((item) => item.word.start <= props.playhead && props.playhead < item.word.end)?.word.id ?? null;
  // Where each paragraph's words start, and which paragraph holds a word: the
  // pane draws only the pages near the view, and these must be drawn anyway.
  const firsts = useMemo(() => paragraphStarts(paras), [paras]);
  const sizes = useMemo(() => paras.map((paragraph) => paragraph.words.length), [paras]);
  const paragraphOf = (index: number | null) => paragraphHolding(firsts, index);
  const indexOfWord = (id: string | null) => id == null ? null : placed.findIndex((item) => item.word.id === id);
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
  return <section className="cp-te-source" aria-label={`Source: ${source.short}`} style={editTextVars(props.text)}>
    <div className="cp-te-tools">
      <button type="button" className="cp-icon-btn cp-te-play" aria-label={props.playing ? `Pause ${source.short}` : `Play ${source.short}`}
        title={props.playing ? "Pause the source (Space)" : "Play the source (Space)"} onClick={props.onPlay}>{props.playing ? <IconPause size={14} /> : <IconPlay size={14} />}</button>
      <EditScrubber label={`${source.short} position`} value={props.playhead} max={source.duration} text={editTc(props.playhead, fps, source.startFrames)}
        onScrub={props.onScrub} onScrubStart={props.onScrubStart} onScrubEnd={props.onScrubEnd} />
      <span className="cp-te-tools-tc">{editTc(props.playhead, fps, source.startFrames)}</span>
      <EditTextSettings pane="Source" style={props.text} onChange={props.onText} />
    </div>
    <MultitrackTranscriptTabs people={props.people} selected={props.tab} panelId={panelId} onSelect={props.onTab} />
    <div ref={body} id={panelId} className="cp-te-src-body" role="tabpanel" aria-label={`${person?.name ?? "All voices"} in ${source.short}, read only`} tabIndex={0}
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
      {/* Words arrive a mic at a time; only once every mic is read does an empty pane mean nobody was transcribed. */}
      {!count && (props.reading ? <p className="cp-te-doc-empty" role="status">{props.reading.total ? `Reading each microphone's words… ${props.reading.done} of ${props.reading.total}` : `Opening ${source.short}…`}</p>
        : person ? <p className="cp-te-doc-empty">{person.name} says nothing in {source.short} that was transcribed.</p>
        : <p className="cp-te-doc-empty">No transcripts in {source.short} yet. Generate them in AAF Audio, then its words appear here.</p>)}
      <EditWindowedParagraphs root={body} sizes={sizes}
        keep={[paragraphOf(indexOfWord(current)), paragraphOf(indexOfWord(props.match)), paragraphOf(range?.[0] ?? null), paragraphOf(range?.[1] ?? null)]}
        render={(paragraphIndex) => {
        const paragraph = paras[paragraphIndex], first = firsts[paragraphIndex];
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
      }} />
    </div>
    <footer className="cp-te-src-foot">
      <span className="cp-te-pane-note" aria-live="polite">{range ? `${(range[1] - range[0] + 1).toLocaleString()} selected`
        : `${inEdit.toLocaleString()}/${count.toLocaleString()}${person ? ` of ${person.name}'s words` : ""} used`}</span>
      <div className="cp-te-src-actions">
        {([["insert", "Insert", "V", "Insert at the record playhead (V)"], ["overwrite", "Overwrite", "B", "Overwrite at the record playhead (B)"], ["append", "Append", null, "Append to the end of the record"]] as const).map(([how, label, key, title]) =>
          <button key={how} type="button" className="btn btn-ghost cp-te-btn" disabled={!props.canInsert} onClick={() => props.onPlace(how)}
            title={props.canInsert ? title : "Select words or mark In and Out in the source first"}>{label}{key && <kbd className="cp-te-kbd">{key}</kbd>}</button>)}
      </div>
    </footer>
  </section>;
}
