import { useEffect, useState } from "react";
import type { AafDocument } from "../bindings/AafDocument";
import type { EditSummary } from "../bindings/EditSummary";
import type { TimelineWord } from "../lib/edit-model";
import { appendBite } from "../lib/edit-stringout";
import { editStore } from "../lib/edit-store";
import { formatError } from "../lib/error-format";

type Props = { editId: string; selected: TimelineWord[]; sequenceOf: (source: string) => AafDocument | undefined; onDone: (message: string) => void };

/**
 * Add the selected words to another edit, the manual string-out: pick the
 * edit and the bite is appended there after filler, in its own undo history.
 * A selection that spans sources sends the first source's words.
 */
export function EditSendTo({ editId, selected, sequenceOf, onDone }: Props) {
  const [edits, setEdits] = useState<EditSummary[]>([]);
  useEffect(() => {
    let live = true;
    editStore.list().then((items) => { if (live) setEdits(items.filter((item) => item.id !== editId)); }).catch(() => undefined);
    return () => { live = false; };
  }, [editId]);
  const send = async (target: EditSummary) => {
    const source = selected[0]?.source;
    const sequence = source ? sequenceOf(source) : undefined;
    if (!source || !sequence) return;
    const words = selected.filter((word) => word.source === source);
    try {
      const head = await editStore.head(target.id);
      const next = appendBite(head.document, sequence, Math.min(...words.map((word) => word.start)), Math.max(...words.map((word) => word.end)));
      if (next === head.document) return;
      await editStore.commit(target.id, "Add Bite", next);
      onDone(`Added ${words.length} word${words.length === 1 ? "" : "s"} to ${target.title}.`);
    } catch (cause) {
      onDone(`Could not add to ${target.title}: ${formatError(cause)}`);
    }
  };
  return <select className="cp-select cp-te-add-source" aria-label="Add the selection to another string out" value="" disabled={!selected.length || !edits.length}
    title={edits.length ? "Add the selected words to another string out" : "Make another string out to send bites to"}
    onChange={(event) => { const target = edits.find((item) => item.id === event.target.value); if (target) void send(target); }}>
    <option value="" disabled>Add to…</option>
    {edits.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
  </select>;
}
