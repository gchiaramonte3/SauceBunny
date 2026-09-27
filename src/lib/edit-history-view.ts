import type { EditHistory } from "../bindings/EditHistory";
import type { EditState } from "../bindings/EditState";

/**
 * How the History panel reads the undo log (src-tauri/src/edit_log.rs): the
 * line of states from the first to the head, the redo steps ahead of it, and
 * the branches that left that line (undone work, kept rather than discarded).
 * The same rules as the approved prototype (design-system/transcript-editor-history.ts).
 */
export type HistoryView = {
  byId: Map<number, EditState>;
  /** First state to the head, in order. */
  done: number[];
  /** What redo would step through from the head, in order. */
  ahead: number[];
  /** Branches off the shown line: `from` is the state they leave, `states` their members. */
  branches: { from: number; states: number[] }[];
};

export function historyView(history: EditHistory): HistoryView {
  const byId = new Map(history.states.map((state) => [state.id, state]));
  const children = new Map<number, number[]>();
  for (const state of history.states) {
    if (state.parent == null) continue;
    const list = children.get(state.parent) ?? [];
    list.push(state.id);
    children.set(state.parent, list);
  }
  const next = new Map(history.next);
  const redoFrom = (id: number) => next.get(id) ?? children.get(id)?.at(-1) ?? null;

  const done: number[] = [];
  for (let at: number | null = history.head; at != null && byId.has(at); at = byId.get(at)!.parent) done.unshift(at);
  const ahead: number[] = [];
  const seen = new Set(done);
  for (let at = redoFrom(history.head); at != null && !seen.has(at); at = redoFrom(at)) {
    ahead.push(at);
    seen.add(at);
  }

  const line = new Set([...done, ...ahead]);
  const branches: HistoryView["branches"] = [];
  for (const id of line) {
    for (const child of children.get(id) ?? []) {
      if (line.has(child)) continue;
      const states: number[] = [];
      const stack = [child];
      while (stack.length) {
        const at = stack.pop()!;
        states.push(at);
        stack.push(...(children.get(at) ?? []));
      }
      branches.push({ from: id, states: states.sort((a, b) => a - b) });
    }
  }
  return { byId, done, ahead, branches };
}
