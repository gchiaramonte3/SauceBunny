import { describe, expect, it } from "vitest";
import type { EditHistory } from "../bindings/EditHistory";
import { historyView } from "./edit-history-view";

const state = (id: number, parent: number | null) => ({ id, parent, label: `s${id}`, at: id * 1000, pinned: null });

describe("history view", () => {
  it("shows the line to the head, the steps ahead, and undone branches kept", () => {
    // 1 -> 2 -> 3 -> 4, then undo to 2 and a new step 5: 3 and 4 are a branch off 2.
    const history: EditHistory = { head: 5, states: [state(1, null), state(2, 1), state(3, 2), state(4, 3), state(5, 2)], next: [[1, 2], [2, 5], [3, 4]] };
    const view = historyView(history);
    expect(view.done).toEqual([1, 2, 5]);
    expect(view.ahead).toEqual([]);
    expect(view.branches).toEqual([{ from: 2, states: [3, 4] }]);
  });

  it("after undo the undone steps are ahead, not a branch", () => {
    const history: EditHistory = { head: 2, states: [state(1, null), state(2, 1), state(3, 2), state(4, 3)], next: [[1, 2], [2, 3], [3, 4]] };
    const view = historyView(history);
    expect(view.done).toEqual([1, 2]);
    expect(view.ahead).toEqual([3, 4]);
    expect(view.branches).toEqual([]);
  });

  it("redo follows the remembered child, and the other child is a branch", () => {
    const history: EditHistory = { head: 1, states: [state(1, null), state(2, 1), state(3, 1)], next: [[1, 2]] };
    const view = historyView(history);
    expect(view.ahead).toEqual([2]);
    expect(view.branches).toEqual([{ from: 1, states: [3] }]);
  });
});
