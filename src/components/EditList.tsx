import type { EditSummary } from "../bindings/EditSummary";

type Props = { edits: EditSummary[]; onOpen: (id: string) => void };

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Every saved string out, newest first. */
export function EditList({ edits, onOpen }: Props) {
  const sorted = [...edits].sort((a, b) => b.updated_at - a.updated_at);
  return <div className="cp-te-picker">
    <h2 className="cp-te-picker-head">Saved string outs</h2>
    <ul className="cp-te-picker-list">{sorted.map((item) => <li key={item.id}>
      <button type="button" className="cp-te-picker-item" onClick={() => onOpen(item.id)}>
        <span className="cp-te-picker-name">{item.title}</span>
        <span className="cp-te-pane-note">{item.states - 1} change{item.states === 2 ? "" : "s"} · {when(item.updated_at)}</span>
      </button></li>)}</ul>
  </div>;
}
