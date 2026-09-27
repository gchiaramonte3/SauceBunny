/**
 * Transcript Editor prototype: the undo log.
 *
 * Every state the edit has been in is kept, as a tree: undo moves the head to
 * the parent, redo to the child you came from, and a new change after an undo
 * starts a sibling branch instead of throwing the undone steps away (vim's
 * undo tree, not Premiere's stack). Any state can be jumped to, and a state
 * can be pinned with a name. Rapid repeats of one action (a paragraph nudged
 * five times) coalesce into one step.
 *
 * In the app this is a SQLite database in app_data_dir(), holding ops and
 * periodic checkpoints rather than whole snapshots; see "Undo log" in
 * docs/TRANSCRIPT-EDITOR-UX.md. The prototype keeps it in memory, and the
 * shape of the API is the part being judged.
 */

export type TeState<T> = { id: number; parent: number | null; label: string; at: number; snapshot: T; group: string | null; pinned: string | null };
export type TeLog<T> = { states: TeState<T>[]; head: number; next: Record<number, number> };

/** Coalesce a repeat of the same grouped action within this window. */
export const TE_COALESCE_MS = 500;

export function createLog<T>(snapshot: T, at: number, label = "Opened"): TeLog<T> {
  return { states: [{ id: 0, parent: null, label, at, snapshot, group: null, pinned: null }], head: 0, next: {} };
}

export const current = <T>(log: TeLog<T>) => log.states[log.head].snapshot;
export const childrenOf = <T>(log: TeLog<T>, id: number) => log.states.filter((state) => state.parent === id);

export function record<T>(log: TeLog<T>, label: string, snapshot: T, at: number, group: string | null = null): TeLog<T> {
  const head = log.states[log.head];
  if (group && head.group === group && at - head.at < TE_COALESCE_MS && !childrenOf(log, head.id).length && !head.pinned) {
    const states = [...log.states];
    states[head.id] = { ...head, snapshot, at };
    return { ...log, states };
  }
  const id = log.states.length;
  return { states: [...log.states, { id, parent: head.id, label, at, snapshot, group, pinned: null }], head: id, next: { ...log.next, [head.id]: id } };
}

export function undo<T>(log: TeLog<T>): TeLog<T> {
  const parent = log.states[log.head].parent;
  return parent == null ? log : { ...log, head: parent, next: { ...log.next, [parent]: log.head } };
}

/** The step redo would take: the child you last left, else the newest. */
export function redoTarget<T>(log: TeLog<T>): number | null {
  const remembered = log.next[log.head];
  if (remembered != null) return remembered;
  const children = childrenOf(log, log.head);
  return children.length ? children[children.length - 1].id : null;
}

export function redo<T>(log: TeLog<T>): TeLog<T> {
  const target = redoTarget(log);
  return target == null ? log : { ...log, head: target };
}

/** Ids from the first state to `id`. */
export function pathTo<T>(log: TeLog<T>, id: number): number[] {
  const path: number[] = [];
  for (let at: number | null = id; at != null; at = log.states[at].parent) path.unshift(at);
  return path;
}

/** Move the head anywhere. Nothing is recorded or lost; redo then retraces this path. */
export function jump<T>(log: TeLog<T>, id: number): TeLog<T> {
  if (!log.states[id] || id === log.head) return log;
  const next = { ...log.next };
  const path = pathTo(log, id);
  for (let index = 1; index < path.length; index += 1) next[path[index - 1]] = path[index];
  return { ...log, head: id, next };
}

/** The line history shows: the path to the head, then the redo steps after it. */
export function timeline<T>(log: TeLog<T>): { done: number[]; ahead: number[] } {
  const done = pathTo(log, log.head), ahead: number[] = [];
  for (let at = log.next[log.head] ?? null; at != null; at = log.next[at] ?? null) ahead.push(at);
  if (!ahead.length) {
    let at = redoTarget(log);
    while (at != null) { ahead.push(at); const children = childrenOf(log, at); at = log.next[at] ?? (children.length ? children[children.length - 1].id : null); }
  }
  return { done, ahead };
}

/** Branches that leave the shown line: undone work kept, not discarded. */
export function sideBranches<T>(log: TeLog<T>): { from: number; states: number[] }[] {
  const { done, ahead } = timeline(log);
  const line = new Set([...done, ...ahead]);
  const out: { from: number; states: number[] }[] = [];
  for (const id of line) for (const child of childrenOf(log, id)) {
    if (line.has(child.id)) continue;
    const states: number[] = [];
    const walk = (at: number) => { states.push(at); for (const next of childrenOf(log, at)) walk(next.id); };
    walk(child.id);
    out.push({ from: id, states });
  }
  return out;
}

export function pin<T>(log: TeLog<T>, id: number, name: string | null): TeLog<T> {
  if (!log.states[id]) return log;
  const states = [...log.states];
  states[id] = { ...states[id], pinned: name && name.trim() ? name.trim() : null };
  return { ...log, states };
}
