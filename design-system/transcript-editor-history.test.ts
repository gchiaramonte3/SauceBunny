import { describe, expect, it } from "vitest";
import { createLog, current, jump, pin, record, redo, redoTarget, sideBranches, timeline, undo, TE_COALESCE_MS } from "./transcript-editor-history";

const build = (...labels: string[]) => labels.reduce((log, label, index) => record(log, label, label, 1000 * (index + 1)), createLog("start", 0));

describe("transcript editor undo log", () => {
  it("undo and redo walk one step at a time and stop at the ends", () => {
    let log = build("a", "b", "c");
    log = undo(undo(log));
    expect(current(log)).toBe("a");
    expect(current(undo(undo(log)))).toBe("start");
    log = redo(log);
    expect(current(log)).toBe("b");
    expect(redo(redo(redo(log))).head).toBe(3);
  });

  it("a change after undo branches: the undone steps are kept and can be reached again", () => {
    let log = undo(undo(build("a", "b", "c")));
    log = record(log, "d", "d", 10_000);
    expect(current(log)).toBe("d");
    expect(log.states.map((state) => state.snapshot)).toEqual(["start", "a", "b", "c", "d"]);
    expect(sideBranches(log)).toEqual([{ from: 1, states: [2, 3] }]);
    log = jump(log, 3);
    expect(current(log)).toBe("c");
    expect(timeline(log).done).toEqual([0, 1, 2, 3]);
    // Undo from the old branch retraces it, and redo comes back the same way.
    expect(current(redo(undo(log)))).toBe("c");
    expect(sideBranches(log)).toEqual([{ from: 1, states: [4] }]);
  });

  it("redo follows the branch you last left, not simply the newest", () => {
    let log = record(undo(build("a", "b")), "x", "x", 5000);
    log = jump(log, 2);
    log = undo(log);
    expect(redoTarget(log)).toBe(2);
    log = jump(log, 3);
    log = undo(log);
    expect(redoTarget(log)).toBe(3);
  });

  it("jumping moves the head and records nothing", () => {
    const log = build("a", "b", "c");
    const jumped = jump(log, 1);
    expect(jumped.states).toBe(log.states);
    expect(timeline(jumped)).toEqual({ done: [0, 1], ahead: [2, 3] });
    expect(jump(log, 99)).toBe(log);
  });

  it("repeats of one grouped action coalesce inside the window, and not outside it", () => {
    let log = record(createLog(0, 0), "Move", 1, 100, "move");
    log = record(log, "Move", 2, 100 + TE_COALESCE_MS - 1, "move");
    expect(log.states).toHaveLength(2);
    expect(current(log)).toBe(2);
    log = record(log, "Move", 3, 100 + 3 * TE_COALESCE_MS, "move");
    expect(log.states).toHaveLength(3);
    log = record(log, "Delete", 4, 100 + 3 * TE_COALESCE_MS + 1, "delete");
    expect(log.states).toHaveLength(4);
    expect(current(undo(log))).toBe(3);
  });

  it("a pinned state is never coalesced into, and a blank name unpins", () => {
    let log = record(createLog(0, 0), "Move", 1, 100, "move");
    log = pin(log, 1, "  Client cut v2 ");
    expect(log.states[1].pinned).toBe("Client cut v2");
    log = record(log, "Move", 2, 110, "move");
    expect(log.states).toHaveLength(3);
    expect(pin(log, 1, " ").states[1].pinned).toBeNull();
  });

  it("keeps thousands of steps", () => {
    let log = createLog(0, 0);
    for (let index = 1; index <= 5000; index += 1) log = record(log, "Step", index, index * 1000);
    expect(log.states).toHaveLength(5001);
    for (let index = 0; index < 5000; index += 1) log = undo(log);
    expect(current(log)).toBe(0);
  });
});
