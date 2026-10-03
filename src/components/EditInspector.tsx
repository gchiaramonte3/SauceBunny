import type { useEditWorkspace } from "../hooks/use-edit-workspace";
import { deleteWords, isGap, type TimelineLane, type TimelineWord } from "../lib/edit-model";
import { EditMarkerInspector } from "./EditMarkerInspector";

type Props = {
  ws: ReturnType<typeof useEditWorkspace>; words: TimelineWord[]; lanes: TimelineLane[]; colors: Record<string, string>;
  tc: (seconds: number) => string; sourceName: (source: string) => string;
};

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const names = (list: string[]) => list.length <= 2 ? list.join(" and ") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/**
 * Details for whatever is selected, then the state of the whole string out.
 * It explains; its word actions also have keys (⌫, ⇧⌫), so closing it loses nothing there.
 */
export function EditInspector({ ws, words, lanes, colors, tc, sourceName }: Props) {
  const nameOf = (id: string) => lanes.find((lane) => lane.id === id)?.name ?? id;
  const selected = ws.selected;
  const who = [...new Set(selected.map((item) => item.word.track))].map(nameOf);
  const dry = selected.length ? deleteWords(words, ws.edit, ws.keys) : null;
  const under = [...new Set((dry?.crosstalk ?? []).map((word) => word.track))].map(nameOf);
  const allSilenced = selected.length > 0 && selected.every((item) => item.muted);
  const seam = ws.seam == null ? null : ws.seams.find((item) => item.index === ws.seam) ?? null;
  const talk: Record<string, number> = {};
  for (const item of ws.placed) if (!item.muted) talk[item.word.track] = (talk[item.word.track] ?? 0) + item.programEnd - item.programStart;
  const longest = Math.max(1, ...Object.values(talk));
  const caret = ws.placed[ws.caret];
  return <aside className="cp-te-inspector" aria-label="Inspector">
    <section className="cp-te-insp-section" aria-labelledby="cp-te-insp-sel">
      <h3 id="cp-te-insp-sel" className="cp-te-insp-title">Selection</h3>
      {selected.length === 0 ? <p className="cp-te-insp-note">{caret ? <>Caret at {tc(caret.programStart)}, before “{caret.word.text}”. Select words to cut or move them.</> : "Caret at the end."}</p>
        : <>
          <p className="cp-te-insp-lead">{plural(selected.length, "word")} · {names(who)}</p>
          <p className="cp-te-insp-meta">{tc(selected[0].programStart)} to {tc(selected[selected.length - 1].programEnd)} · {(dry?.seconds ?? 0).toFixed(2)} s</p>
          <blockquote className="cp-te-insp-quote">{selected.slice(0, 14).map((item) => item.word.text).join(" ")}{selected.length > 14 ? " …" : ""}</blockquote>
          {under.length > 0 && <p className="cp-te-insp-warn" role="note">{names(under)} talks under this: a delete silences only {names(who)} and asks before cutting for everyone.</p>}
          <div className="cp-te-insp-actions">
            <button type="button" className="btn btn-ghost cp-te-btn" onClick={() => ws.remove(false)} title="Cut from every track and close up (⌫)">Delete<kbd className="cp-te-kbd">⌫</kbd></button>
            <button type="button" className="btn btn-ghost cp-te-btn" onClick={() => ws.remove(true)} title={allSilenced ? "Unsilence on their track (⇧⌫)" : "Silence on their track only; nothing moves (⇧⌫)"}>
              {allSilenced ? "Unsilence" : `Silence ${names(who)}`}<kbd className="cp-te-kbd">⇧⌫</kbd></button>
          </div>
        </>}
    </section>
    {ws.marker && <EditMarkerInspector marker={ws.marker} tc={tc} onChange={(change) => ws.updateMarker(ws.marker!.id, change, `marker:${ws.marker!.id}:${Object.keys(change)[0]}`)}
      onRemove={() => ws.removeMarker(ws.marker!.id)} onDone={() => ws.setMarker(null)} />}
    {seam && <section className="cp-te-insp-section" aria-labelledby="cp-te-insp-seam">
      <h3 id="cp-te-insp-seam" className="cp-te-insp-title">Edit point</h3>
      <p className="cp-te-insp-lead">{seam.kind === "cut" ? "Cut" : seam.kind === "through" ? "Through edit" : seam.kind === "gap" ? "Gap" : "Jump"} at {tc(seam.at)}</p>
      <p className="cp-te-insp-meta">{seam.kind === "cut" ? `${seam.gap.toFixed(2)} s removed · ${plural(seam.removed.length, "word")}` : seam.kind === "through" ? "Nothing removed."
        : seam.kind === "gap" ? "Silence on every track." : Number.isNaN(seam.gap) ? "Joins two sequences." : `Jumps ${seam.gap < 0 ? "back" : "ahead"} ${Math.abs(seam.gap).toFixed(1)} s.`}</p>
      {seam.clipped.size > 0 && <p className="cp-te-insp-warn" role="note">Cuts into a word: {names([...seam.clipped].map(nameOf))}.</p>}
      <div className="cp-te-insp-actions">
        <button type="button" className="btn btn-ghost cp-te-btn" disabled={seam.kind !== "cut"} onClick={ws.healCut}>Restore</button>
        <button type="button" className="btn btn-ghost cp-te-btn" onClick={() => ws.setSeam(null)}>Done</button>
      </div>
    </section>}
    <section className="cp-te-insp-section" aria-labelledby="cp-te-insp-edit">
      <h3 id="cp-te-insp-edit" className="cp-te-insp-title">This string out</h3>
      <dl className="cp-te-insp-facts">
        <div><dt>Running time</dt><dd>{clock(ws.total)}</dd></div>
        <div><dt>Sequences</dt><dd>{[...new Set(ws.edit.segments.filter((segment) => !isGap(segment)).map((segment) => sourceName(segment.source)))].join(", ") || "None"}</dd></div>
        <div><dt>Removed lines</dt><dd>{ws.ghosts.length}</dd></div>
        <div><dt>Clips per track</dt><dd>{ws.edit.segments.length}</dd></div>
        <div><dt>Edit points</dt><dd>{ws.seams.length}</dd></div>
        <div><dt>Silenced</dt><dd>{plural(ws.placed.filter((item) => item.muted).length, "word")}</dd></div>
        <div><dt>Markers</dt><dd>{ws.markers.length}</dd></div>
      </dl>
    </section>
    <section className="cp-te-insp-section" aria-labelledby="cp-te-insp-talk">
      <h3 id="cp-te-insp-talk" className="cp-te-insp-title">Talk time</h3>
      <ul className="cp-te-insp-talk">{lanes.map((lane) => <li key={lane.id} style={{ "--te-speaker": colors[lane.id], "--te-share": `${(talk[lane.id] ?? 0) / longest * 100}%` } as React.CSSProperties}>
        <span className="cp-te-swatch" aria-hidden="true" /><span className="cp-te-insp-talk-name">{lane.name}</span>
        <span className="cp-te-insp-talk-bar" aria-hidden="true" /><span className="cp-te-insp-talk-time">{(talk[lane.id] ?? 0).toFixed(1)} s</span>
      </li>)}</ul>
    </section>
  </aside>;
}
