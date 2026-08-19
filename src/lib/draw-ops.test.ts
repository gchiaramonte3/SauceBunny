import { describe, expect, it } from "vitest";
import {
  applyDrawOp, drawAuthors, EMPTY_DRAW_STATE, lastStrokeBy, mergeDrawOps,
  type DrawOp, type DrawStroke,
} from "./draw-ops";

/**
 * Multi-user drawing convergence, without a CRDT library.
 *
 * A finished stroke is immutable, so a shared drawing is a 2P-Set: adds union,
 * erases tombstone. These prove the property that matters — any two peers that
 * receive the same ops IN ANY ORDER end up with the same picture, including the
 * two cases that actually break naive implementations.
 */
const s = (id: string, author: string, at: number): DrawStroke => ({
  id, author, at, color: "#f00", size: 5, pts: [[0, 0, 0.5], [1, 1, 0.5]],
});

const add = (st: DrawStroke): DrawOp => ({ t: "strokeAdd", stroke: st });
const erase = (id: string, at: number): DrawOp => ({ t: "strokeErase", id, at });

/** Every ordering of a small op list. */
function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) =>
    permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

describe("shared drawing converges", () => {
  it("merges strokes from two people into one picture", () => {
    const ops = [add(s("a", "Gasper", 1)), add(s("b", "David", 2))];
    const out = mergeDrawOps(EMPTY_DRAW_STATE, ops);
    expect(out.strokes.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("reaches the SAME picture no matter what order ops arrive in", () => {
    // The whole claim. A host-relayed session delivers ops in whatever order
    // the network produces; every permutation must land identically.
    const ops = [add(s("a", "G", 1)), add(s("b", "D", 2)), erase("a", 3), add(s("c", "G", 4))];
    const results = permutations(ops).map((p) =>
      mergeDrawOps(EMPTY_DRAW_STATE, p).strokes.map((x) => x.id).join(","));
    expect(new Set(results).size, `diverged: ${[...new Set(results)].join(" | ")}`).toBe(1);
  });

  it("does not resurrect a stroke erased before it arrived", () => {
    // The hazard that makes tombstones necessary. Filtering an erase against
    // the CURRENT set drops it on the floor when the add is still in flight,
    // and the stroke reappears on that peer only.
    const late = mergeDrawOps(EMPTY_DRAW_STATE, [erase("a", 2), add(s("a", "G", 1))]);
    expect(late.strokes, "an erased stroke came back").toEqual([]);
  });

  it("is idempotent, so a replayed add never duplicates", () => {
    const one = add(s("a", "G", 1));
    const out = mergeDrawOps(EMPTY_DRAW_STATE, [one, one, one]);
    expect(out.strokes).toHaveLength(1);
  });

  it("is idempotent for erase too", () => {
    const out = mergeDrawOps(EMPTY_DRAW_STATE, [add(s("a", "G", 1)), erase("a", 2), erase("a", 2)]);
    expect(out.strokes).toEqual([]);
    expect(out.erased).toEqual(["a"]);
  });

  it("agrees on paint order when two machines stamp the same millisecond", () => {
    // Without the id tiebreak the two peers paint these in opposite orders and
    // disagree about which colour is on top — a divergence you can SEE.
    const forward = mergeDrawOps(EMPTY_DRAW_STATE, [add(s("a", "G", 7)), add(s("b", "D", 7))]);
    const reverse = mergeDrawOps(EMPTY_DRAW_STATE, [add(s("b", "D", 7)), add(s("a", "G", 7))]);
    expect(forward.strokes.map((x) => x.id)).toEqual(reverse.strokes.map((x) => x.id));
  });

  it("paints later strokes on top", () => {
    const out = mergeDrawOps(EMPTY_DRAW_STATE, [add(s("late", "G", 9)), add(s("early", "D", 1))]);
    expect(out.strokes.map((x) => x.id)).toEqual(["early", "late"]);
  });

  it("never mutates the state it was given", () => {
    const before = { ...EMPTY_DRAW_STATE, strokes: [s("a", "G", 1)] };
    const snapshot = JSON.stringify(before);
    applyDrawOp(before, add(s("b", "D", 2)));
    applyDrawOp(before, erase("a", 3));
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("ignores an op shape it does not know", () => {
    // Forward compatibility: a peer on a newer build may send a tool this one
    // has never heard of, and the session must not break over it.
    const st = mergeDrawOps(EMPTY_DRAW_STATE, [add(s("a", "G", 1))]);
    expect(applyDrawOp(st, { t: "strokeFuture" } as unknown as DrawOp)).toBe(st);
  });
});

describe("attribution", () => {
  it("lists everyone who has drawn, in first-stroke order", () => {
    const st = mergeDrawOps(EMPTY_DRAW_STATE, [
      add(s("b", "David", 2)), add(s("a", "Gasper", 1)), add(s("c", "Gasper", 3)),
    ]);
    expect(drawAuthors(st)).toEqual(["Gasper", "David"]);
  });

  it("undo finds only YOUR last stroke, never a peer's", () => {
    // Undoing someone else's work in a shared session is the fastest way to
    // make people stop drawing together.
    const st = mergeDrawOps(EMPTY_DRAW_STATE, [
      add(s("a", "Gasper", 1)), add(s("b", "David", 2)), add(s("c", "Gasper", 3)),
    ]);
    expect(lastStrokeBy(st, "Gasper")?.id).toBe("c");
    expect(lastStrokeBy(st, "David")?.id).toBe("b");
    expect(lastStrokeBy(st, "Nobody")).toBeNull();
  });
});
