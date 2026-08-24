import { describe, expect, it } from "vitest";
import { applyOrderToSlots, dropIndexAt, moveItem } from "./reorder";

describe("dropIndexAt", () => {
  const mids = [10, 30, 50];

  it("is a boundary, so it spans one past the last row", () => {
    expect(dropIndexAt(mids, 0)).toBe(0);
    expect(dropIndexAt(mids, 100)).toBe(3);
  });

  it("yields at the MIDPOINT, not the edge", () => {
    // Just above the first midpoint is still "before the first row".
    expect(dropIndexAt(mids, 9)).toBe(0);
    expect(dropIndexAt(mids, 11)).toBe(1);
  });

  it("an empty list has exactly one boundary", () => {
    expect(dropIndexAt([], 42)).toBe(0);
  });
});

describe("moveItem", () => {
  const list = ["a", "b", "c", "d"];

  it("moves down, accounting for the item leaving its old slot", () => {
    // THE bug this exists to prevent. `to` is counted before removal, so a
    // naive splice lands one place short when moving down.
    expect(moveItem(list, 0, 3)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(list, 0, 4)).toEqual(["b", "c", "d", "a"]);
  });

  it("moves up without the correction", () => {
    expect(moveItem(list, 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveItem(list, 2, 1)).toEqual(["a", "c", "b", "d"]);
  });

  it("dropping an item on itself, either side, changes nothing", () => {
    expect(moveItem(list, 1, 1)).toEqual(list);
    expect(moveItem(list, 1, 2)).toEqual(list);
  });

  it("never mutates its input, and survives an out-of-range source", () => {
    const input = [...list];
    moveItem(input, 0, 3);
    expect(input).toEqual(list);
    expect(moveItem(list, 9, 0)).toEqual(list);
    expect(moveItem(list, -1, 0)).toEqual(list);
  });
});

describe("applyOrderToSlots", () => {
  type Row = { id: string; status: "queued" | "running" | "done" };
  const rows: Row[] = [
    { id: "done1", status: "done" },
    { id: "q1", status: "queued" },
    { id: "run1", status: "running" },
    { id: "q2", status: "queued" },
    { id: "q3", status: "queued" },
  ];
  const movable = (r: Row) => r.status === "queued";
  const id = (r: Row) => r.id;

  it("permutes only the slots the movable rows already occupy", () => {
    // The finished and running rows must not move: one is a receipt, the
    // other is mid-subprocess.
    const out = applyOrderToSlots(rows, movable, id, ["q3", "q2", "q1"]);
    expect(out.map((r) => r.id)).toEqual(["done1", "q3", "run1", "q2", "q1"]);
    expect(out[0].status).toBe("done");
    expect(out[2].status).toBe("running");
  });

  it("an unnamed movable row keeps its place after the named ones", () => {
    // A stale id list from a queue that changed under the drag must not
    // silently drop a clip.
    const out = applyOrderToSlots(rows, movable, id, ["q3"]);
    expect(out.map((r) => r.id)).toEqual(["done1", "q3", "run1", "q1", "q2"]);
    expect(out).toHaveLength(rows.length);
  });

  it("ignores ids that are not in the list, and duplicates", () => {
    const out = applyOrderToSlots(rows, movable, id, ["ghost", "q2", "q2", "q1", "q3"]);
    expect(out.map((r) => r.id)).toEqual(["done1", "q2", "run1", "q1", "q3"]);
  });

  it("a list with nothing movable comes back unchanged", () => {
    const frozen: Row[] = [{ id: "d", status: "done" }, { id: "r", status: "running" }];
    expect(applyOrderToSlots(frozen, movable, id, ["d"])).toEqual(frozen);
  });

  it("does not mutate its input", () => {
    const input = rows.map((r) => ({ ...r }));
    const before = input.map((r) => r.id);
    applyOrderToSlots(input, movable, id, ["q3", "q1", "q2"]);
    expect(input.map((r) => r.id)).toEqual(before);
  });
});
