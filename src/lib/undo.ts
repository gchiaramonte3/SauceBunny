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
