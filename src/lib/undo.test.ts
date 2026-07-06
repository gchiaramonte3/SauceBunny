import { describe, it, expect } from "vitest";
import { UndoManager, type UndoEntry } from "./undo";

/** Entry that logs its execution into `log` so ordering is observable. */
function entry(label: string, log: string[]): UndoEntry {
  return {
    label,
    undo: () => log.push(`undo:${label}`),
    redo: () => log.push(`redo:${label}`),
  };
}

describe("UndoManager", () => {
  it("undoes in LIFO order and redoes back in original order", () => {
    const m = new UndoManager();
    const log: string[] = [];
    m.push(entry("a", log));
    m.push(entry("b", log));
    m.push(entry("c", log));

    expect(m.undo()).toBe("c");
    expect(m.undo()).toBe("b");
    expect(m.undo()).toBe("a");
    expect(m.undo()).toBeNull(); // stack exhausted

    expect(m.redo()).toBe("a");
    expect(m.redo()).toBe("b");
    expect(m.redo()).toBe("c");
    expect(m.redo()).toBeNull();

    expect(log).toEqual([
      "undo:c", "undo:b", "undo:a",
      "redo:a", "redo:b", "redo:c",
    ]);
  });

  it("returns null (and runs nothing) on empty stacks", () => {
    const m = new UndoManager();
    expect(m.undo()).toBeNull();
    expect(m.redo()).toBeNull();
    expect(m.getSnapshot()).toEqual({ canUndo: false, canRedo: false, undoLabel: null, redoLabel: null });
  });

  it("a new push invalidates the redo branch", () => {
    const m = new UndoManager();
    const log: string[] = [];
    m.push(entry("a", log));
    m.push(entry("b", log));
    m.undo(); // b now redoable
    expect(m.getSnapshot().canRedo).toBe(true);

    m.push(entry("c", log)); // diverge → b's redo is gone
    expect(m.getSnapshot().canRedo).toBe(false);
    expect(m.redo()).toBeNull();
    expect(m.undo()).toBe("c");
    expect(m.undo()).toBe("a");
  });

  it("evicts the OLDEST entry past the cap", () => {
    const m = new UndoManager(3);
    const log: string[] = [];
    for (const l of ["a", "b", "c", "d", "e"]) m.push(entry(l, log));
    expect(m.undo()).toBe("e");
    expect(m.undo()).toBe("d");
    expect(m.undo()).toBe("c");
    expect(m.undo()).toBeNull(); // a + b were evicted
  });

  it("clear drops both stacks", () => {
    const m = new UndoManager();
    const log: string[] = [];
    m.push(entry("a", log));
    m.push(entry("b", log));
    m.undo(); // one on each stack
    m.clear();
    expect(m.undo()).toBeNull();
    expect(m.redo()).toBeNull();
    expect(log).toEqual(["undo:b"]); // clear ran no entry code
  });

  it("snapshot reflects the top labels and is referentially stable until a change", () => {
    const m = new UndoManager();
    const log: string[] = [];
    const empty1 = m.getSnapshot();
    const empty2 = m.getSnapshot();
    expect(empty1).toBe(empty2); // cached — required by useSyncExternalStore

    m.push(entry("mark in", log));
    m.push(entry("add comment", log));
    const s = m.getSnapshot();
    expect(s).toEqual({ canUndo: true, canRedo: false, undoLabel: "add comment", redoLabel: null });

    m.undo();
    const s2 = m.getSnapshot();
    expect(s2).not.toBe(s);
    expect(s2).toEqual({ canUndo: true, canRedo: true, undoLabel: "mark in", redoLabel: "add comment" });
  });

  it("notifies subscribers on push/undo/redo/clear and stops after unsubscribe", () => {
    const m = new UndoManager();
    const log: string[] = [];
    let ticks = 0;
    const off = m.subscribe(() => ticks++);
    m.push(entry("a", log)); // 1
    m.undo();                // 2
    m.redo();                // 3
    m.clear();               // 4
    m.clear();               // no-op on empty → no tick
    expect(ticks).toBe(4);
    off();
    m.push(entry("b", log));
    expect(ticks).toBe(4);
  });
});
