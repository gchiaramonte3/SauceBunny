import { useEffect, useState } from "react";
import type { AafDocument } from "../bindings/AafDocument";
import type { EditSummary } from "../bindings/EditSummary";
import type { PlacedWord } from "../lib/edit-model";
import { appendBite } from "../lib/edit-stringout";
import { editStore } from "../lib/edit-store";
import { formatError } from "../lib/error-format";

type Props = { editId: string; selected: PlacedWord[]; sequenceOf: (source: string) => AafDocument | undefined; onDone: (message: string) => void };

/**
 * Add the selected words to another edit, the manual string-out: pick the
 * edit and the bite is appended there after filler, in its own undo history.
 * A selection that crosses a cut sends each side as its own bite, in order,
 * butted together as they play here, so the words cut between them stay cut.
 */
export function selectionRuns(selected: PlacedWord[]): { source: string; start: number; end: number; count: number }[] {
  const runs: { source: string; segment: number; start: number; end: number; count: number }[] = [];
  for (const item of selected) {
    const last = runs[runs.length - 1];
    if (last && last.segment === item.segment) { last.start = Math.min(last.start, item.word.start); last.end = Math.max(last.end, item.word.end); last.count++; }
    else runs.push({ source: item.word.source, segment: item.segment, start: item.word.start, end: item.word.end, count: 1 });
  }
  return runs.map(({ source, start, end, count }) => ({ source, start, end, count }));
}

export function EditSendTo({ editId, selected, sequenceOf, onDone }: Props) {
  const [edits, setEdits] = useState<EditSummary[]>([]);
  useEffect(() => {
    let live = true;
    editStore.list().then((items) => { if (live) setEdits(items.filter((item) => item.id !== editId)); }).catch(() => undefined);
    return () => { live = false; };
  }, [editId]);
  const send = async (target: EditSummary) => {
    const runs = selectionRuns(selected).filter((run) => sequenceOf(run.source));
    if (!runs.length) return;
    try {
      const head = await editStore.head(target.id);
      const next = runs.reduce((document, run, index) => appendBite(document, sequenceOf(run.source)!, run.start, run.end, index ? 0 : undefined), head.document);
      if (next === head.document) return;
      await editStore.commit(target.id, runs.length === 1 ? "Add Bite" : `Add ${runs.length} Bites`, next);
      const count = runs.reduce((sum, run) => sum + run.count, 0);
      onDone(`Added ${count} word${count === 1 ? "" : "s"} to ${target.title}.`);
    } catch (cause) {
      onDone(`Could not add to ${target.title}: ${formatError(cause)}`);
    }
  };
  return <select className="cp-select cp-te-add-source" aria-label="Add the selection to another string out" value="" disabled={!selected.length || !edits.length}
    title={!edits.length ? "Make another string out to send bites to" : selected.length ? "Add the selected words to another string out" : "Select words in the record first"}
    onChange={(event) => { const target = edits.find((item) => item.id === event.target.value); if (target) void send(target); }}>
    <option value="" disabled>Add to…</option>
    {edits.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
  </select>;
}
