/**
 * Scoped undo/redo for local user actions — marks, the user's OWN review ops,
 * and (via a separate in-composer history) annotation drafts.
 *
 * Deliberately NOT a global time machine: callers push {label, undo, redo}
 * entries at the site of each undoable user action, and App clears the stack
 * at boundaries where replay would be nonsense (source change, co-review
 * join/leave). Peer-originated review changes never create entries — only
 * the local mutation funnels push here.
 *
 * Module-level singleton (`appUndo`), mirroring the lib's other shared-state
 * modules (storage, keybindings): no state-management library, per the
 * constitution. UI reads it through `subscribe`/`getSnapshot`, which are
 * shaped for React's `useSyncExternalStore` (stable methods, cached snapshot).
 */

export type UndoEntry = {
  /** Short human phrase for the HUD/palette, e.g. "mark in", "add comment". */
  label: string;
  undo: () => void;
  redo: () => void;
  /**
   * Which state this entry restores, so a boundary can drop the entries it
   * invalidates WITHOUT dropping the rest.
   *
   * App used to clear the whole stack on both source change and co-review
   * join/leave. The join case is right for REVIEW entries and only for those:
   * `replayOps` captures `inSession` when the entry is made, so a solo entry
   * replayed inside a session writes the local file while peers hold the
   * shared doc, and a session entry replayed solo relays into a room. That
   * capture is protective, not a bug - the fix is not to make entries
   * mode-agnostic, it is to stop taking everything else down with them.
   * Marks, speaker overrides and queue rows are pure local-state restores and
   * survive a join fine.
   *
   * THE CONDITION THAT MAKES SELECTIVE CLEARING SOUND, and the reason to be
   * careful widening it: removing entries from the middle of a stack is safe
   * only when what stays does not share state with what goes. Marks, speaker
   * overrides, review ops and the export queue are four independent domains,
   * so undoing a mark is correct whatever happened to the review doc in
   * between. Tag two things that DO share state and this becomes a bug
   * generator.
   */
  scope?: string;
};

export type UndoSnapshot = {
  canUndo: boolean;
  canRedo: boolean;
  /** Label of what ⌘Z would undo next (null = nothing). */
  undoLabel: string | null;
  redoLabel: string | null;
};

const DEFAULT_LIMIT = 50;

export class UndoManager {
  private past: UndoEntry[] = [];
  private future: UndoEntry[] = [];
  private listeners = new Set<() => void>();
  private snap: UndoSnapshot | null = null;

  constructor(private limit = DEFAULT_LIMIT) {}

  /** Record an already-performed action. Evicts the oldest entry past the
   *  cap and invalidates the redo branch (the universal undo-model rule). */
  push(entry: UndoEntry): void {
    this.past.push(entry);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
    this.emit();
  }

  /** Undo the newest entry; returns its label (for the HUD) or null. */
  undo(): string | null {
    const e = this.past.pop();
    if (!e) return null;
    e.undo();
    this.future.push(e);
    this.emit();
    return e.label;
  }

  /** Redo the most recently undone entry; returns its label or null. */
  redo(): string | null {
    const e = this.future.pop();
    if (!e) return null;
    e.redo();
    this.past.push(e);
    this.emit();
    return e.label;
  }

  /** Drop everything — called at source-change / session boundaries. */
  clear(): void {
    if (this.past.length === 0 && this.future.length === 0) return;
    this.past = [];
    this.future = [];
    this.emit();
  }

  /**
   * Drop only the entries of one scope, keeping the rest in order.
   *
   * The redo branch goes ENTIRELY, not filtered. A redo that spans the
   * boundary being crossed is exactly what this is protecting against, and
   * keeping half of one buys nothing - the standard undo model already
   * discards the future on any new action.
   */
  clearScope(scope: string): void {
    const kept = this.past.filter((e) => e.scope !== scope);
    if (kept.length === this.past.length && this.future.length === 0) return;
    this.past = kept;
    this.future = [];
    this.emit();
  }

  // ── UI subscription (useSyncExternalStore-compatible) ─────────────────────
  // Arrow properties so `appUndo.subscribe` / `appUndo.getSnapshot` can be
  // passed straight to the hook without binding.

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Cached — returns the SAME object until the stacks change, so
   *  useSyncExternalStore doesn't loop on referential inequality. */
  getSnapshot = (): UndoSnapshot => {
    this.snap ??= {
      canUndo: this.past.length > 0,
      canRedo: this.future.length > 0,
      undoLabel: this.past[this.past.length - 1]?.label ?? null,
      redoLabel: this.future[this.future.length - 1]?.label ?? null,
    };
    return this.snap;
  };

  private emit(): void {
    this.snap = null;
    for (const fn of this.listeners) fn();
  }
}

/** The ONE app-wide stack — mark and review entries interleave chronologically. */
export const appUndo = new UndoManager();
