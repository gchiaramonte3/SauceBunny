import { teTc } from "./transcript-editor-fixture";
import type { TePlacedWord, TeSpeaker, TeWord } from "./transcript-editor-model";

export type TeSeamDetail = { index: number; at: number; gap: number; kind: "cut" | "through" | "jump"; removed: number; clipped: string[] };
export type TeSummary = { running: number; scene: number; clips: number; cuts: number; lifted: number; corrections: number };

type Props = {
  speakers: TeSpeaker[]; colors: Record<string, string>; fps: number;
  selected: TePlacedWord[]; caretWord: TePlacedWord | null; crosstalk: TeWord[]; cutSeconds: number;
  onDelete: (lift: boolean) => void; onMatch: () => void;
  seam: TeSeamDetail | null; onRestoreSeam: () => void; onCloseSeam: () => void;
  summary: TeSummary; talk: Record<string, number>;
};

const tc = (seconds: number, fps: number) => teTc(seconds, fps);
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const names = (list: string[]) => list.length <= 2 ? list.join(" and ") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/**
 * The trailing inspector: details for whatever is selected, then the state of
 * the whole edit. Every button here has a key, and the inspector can be
 * closed without losing anything - it explains, it never holds the only copy
 * of a command.
 */
export function TeInspector(props: Props) {
  const { speakers, fps, selected, summary } = props;
  const nameOf = (id: string) => speakers.find((speaker) => speaker.id === id)?.name ?? id;
  const who = [...new Set(selected.map((item) => item.word.speaker))].map(nameOf);
  const allLifted = selected.length > 0 && selected.every((item) => item.muted);
  const under = [...new Set(props.crosstalk.map((word) => word.speaker))].map(nameOf);
  const longest = Math.max(1, ...Object.values(props.talk));
  return <aside className="cp-te-inspector" aria-label="Inspector">
    <section className="cp-te-insp-section" aria-labelledby="cp-te-insp-sel">
      <h3 id="cp-te-insp-sel" className="cp-te-insp-title">Selection</h3>
      {selected.length === 0 ? <p className="cp-te-insp-note">{props.caretWord
        ? <>Caret at {tc(props.caretWord.programStart, fps)}, before “{props.caretWord.word.text}”. Select words to cut or move them.</>
        : "Caret at the end of the edit."}</p>
        : <>
          <p className="cp-te-insp-lead">{plural(selected.length, "word")} · {names(who)}</p>
          <p className="cp-te-insp-meta">{tc(selected[0].programStart, fps)} to {tc(selected[selected.length - 1].programEnd, fps)} · {props.cutSeconds.toFixed(2)} s</p>
          <blockquote className="cp-te-insp-quote">{selected.slice(0, 14).map((item) => item.word.text).join(" ")}{selected.length > 14 ? " …" : ""}</blockquote>
          {under.length > 0 && <p className="cp-te-insp-warn" role="note">{names(under)} {under.length === 1 ? "is" : "are"} talking under this. Deleting takes {plural(props.crosstalk.length, "word")} of theirs too.</p>}
          <div className="cp-te-insp-actions">
            <button type="button" className="btn btn-ghost cp-te-btn" onClick={() => props.onDelete(false)} title="Cut this time from every track and close the gap (Delete)">
              Delete from all tracks<kbd className="cp-te-kbd">⌫</kbd></button>
            <button type="button" className="btn btn-ghost cp-te-btn" onClick={() => props.onDelete(true)}
              title={allLifted ? "Bring these words back on their speaker's track (Shift-Delete)" : "Silence only these words, on their speaker's track. Nothing moves (Shift-Delete)"}>
              {allLifted ? `Restore on ${names(who)}'s track` : `Remove from ${names(who)}'s track only`}<kbd className="cp-te-kbd">⇧⌫</kbd></button>
            <button type="button" className="btn btn-ghost cp-te-btn" onClick={props.onMatch} title="Show these words in the source transcript (F)">
              Find in source<kbd className="cp-te-kbd">F</kbd></button>
          </div>
        </>}
    </section>
    {props.seam && <section className="cp-te-insp-section" aria-labelledby="cp-te-insp-seam">
      <h3 id="cp-te-insp-seam" className="cp-te-insp-title">Edit point</h3>
      <p className="cp-te-insp-lead">{props.seam.kind === "cut" ? "Cut" : props.seam.kind === "through" ? "Through edit" : "Jump"} at {tc(props.seam.at, fps)}</p>
      <p className="cp-te-insp-meta">{props.seam.kind === "cut" ? `${props.seam.gap.toFixed(2)} s removed · ${plural(props.seam.removed, "word")}`
        : props.seam.kind === "through" ? "Nothing removed. The two clips play straight through."
        : `Goes ${props.seam.gap < 0 ? "back" : "ahead"} ${Math.abs(props.seam.gap).toFixed(1)} s in the scene. What it skips still plays elsewhere in the edit, so there is nothing to restore.`}</p>
      {props.seam.clipped.length > 0 && <p className="cp-te-insp-warn" role="note">This edit cuts into a word on {names(props.seam.clipped)}'s track.</p>}
      <div className="cp-te-insp-actions">
        <button type="button" className="btn btn-ghost cp-te-btn" disabled={props.seam.kind !== "cut"} onClick={props.onRestoreSeam}>Restore what was cut</button>
        <button type="button" className="btn btn-ghost cp-te-btn" onClick={props.onCloseSeam}>Done</button>
      </div>
    </section>}
    <section className="cp-te-insp-section" aria-labelledby="cp-te-insp-edit">
      <h3 id="cp-te-insp-edit" className="cp-te-insp-title">This edit</h3>
      <dl className="cp-te-insp-facts">
        <div><dt>Running time</dt><dd>{clock(summary.running)} of {clock(summary.scene)}</dd></div>
        <div><dt>Removed</dt><dd>{(summary.scene - summary.running).toFixed(1)} s</dd></div>
        <div><dt>Clips per track</dt><dd>{summary.clips}</dd></div>
        <div><dt>Edit points</dt><dd>{summary.cuts}</dd></div>
        <div><dt>Silenced on one track</dt><dd>{plural(summary.lifted, "word")}</dd></div>
        <div><dt>Text corrections</dt><dd>{summary.corrections}</dd></div>
      </dl>
    </section>
    <section className="cp-te-insp-section" aria-labelledby="cp-te-insp-talk">
      <h3 id="cp-te-insp-talk" className="cp-te-insp-title">Talk time in the edit</h3>
      <ul className="cp-te-insp-talk">{speakers.map((speaker) => <li key={speaker.id} style={{ "--te-speaker": props.colors[speaker.id], "--te-share": `${(props.talk[speaker.id] ?? 0) / longest * 100}%` } as React.CSSProperties}>
        <span className="cp-te-swatch" aria-hidden="true" /><span className="cp-te-insp-talk-name">{speaker.name}</span>
        <span className="cp-te-insp-talk-bar" aria-hidden="true" /><span className="cp-te-insp-talk-time">{(props.talk[speaker.id] ?? 0).toFixed(1)} s</span>
      </li>)}</ul>
    </section>
    <section className="cp-te-insp-section" aria-labelledby="cp-te-insp-export">
      <h3 id="cp-te-insp-export" className="cp-te-insp-title">Send to Avid</h3>
      <button type="button" className="btn cp-te-btn" disabled aria-describedby="cp-te-insp-export-note">Export sequence as AAF…</button>
      <p id="cp-te-insp-export-note" className="cp-te-insp-note">Phase 1. Writes a new sequence that relinks to the same mic media, one track per speaker, cuts on frame boundaries.</p>
    </section>
  </aside>;
}
