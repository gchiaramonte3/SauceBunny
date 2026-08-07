import { describe, expect, it } from "vitest";
import {
  EMPTY_RANGE, MIN_RANGE_SPAN, markRangeIn, markRangeOut, rangeToPost, tapRange,
  type MarkRange,
} from "./review-range";

/**
 * Every transition of the four-state machine, including the ones that
 * deliberately do nothing. These were unreachable while the logic lived inside
 * ReviewPanel as closures over setState: asking "what does OUT-ARMED do when
 * you mark IN a hair before the OUT" required mounting a component and driving
 * a playhead, so nobody ever asked.
 */

const r = (i: number | null, o: number | null): MarkRange => ({ in: i, out: o });
/** Just under the threshold — the width that must never become a range. */
const HAIR = MIN_RANGE_SPAN / 2;

describe("markRangeIn", () => {
  it("arms IN from idle", () => {
    expect(markRangeIn(EMPTY_RANGE, 10)).toEqual(r(10, null));
  });

  it("re-arms IN in place rather than completing against itself", () => {
    expect(markRangeIn(r(10, null), 25)).toEqual(r(25, null));
  });

  it("completes an OUT-armed range, ordering the marks by time", () => {
    // Marked OUT first, then IN earlier: the span is still in→out.
    expect(markRangeIn(r(null, 30), 10)).toEqual(r(10, 30));
    // And marked IN *after* the OUT: the machine sorts them rather than
    // producing an inverted range.
    expect(markRangeIn(r(null, 10), 30)).toEqual(r(10, 30));
  });

  it("REFUSES to complete a span too short to be one, staying armed", () => {
    // The transition with no visible effect, which is exactly why it needs a
    // test: silently producing a zero-width band is the alternative.
    const cur = r(null, 30);
    expect(markRangeIn(cur, 30 - HAIR)).toBe(cur); // same identity = nothing happened
    expect(markRangeIn(cur, 30)).toBe(cur);
  });

  it("moves the IN edge of a set range", () => {
    expect(markRangeIn(r(10, 30), 15)).toEqual(r(15, 30));
  });

  it("collapses a set range to a fresh armed IN rather than inverting it", () => {
    // Marking IN at or past the OUT would flip the range under the user.
    expect(markRangeIn(r(10, 30), 30)).toEqual(r(30, null));
    expect(markRangeIn(r(10, 30), 45)).toEqual(r(45, null));
    expect(markRangeIn(r(10, 30), 30 - HAIR)).toEqual(r(30 - HAIR, null));
  });
});

describe("markRangeOut", () => {
  it("arms OUT from idle", () => {
    expect(markRangeOut(EMPTY_RANGE, 10)).toEqual(r(null, 10));
  });

  it("re-arms OUT in place", () => {
    expect(markRangeOut(r(null, 10), 25)).toEqual(r(null, 25));
  });

  it("completes an IN-armed range, ordering the marks by time", () => {
    expect(markRangeOut(r(10, null), 30)).toEqual(r(10, 30));
    expect(markRangeOut(r(30, null), 10)).toEqual(r(10, 30));
  });

  it("REFUSES to complete a span too short to be one, staying armed", () => {
    const cur = r(10, null);
    expect(markRangeOut(cur, 10 + HAIR)).toBe(cur);
    expect(markRangeOut(cur, 10)).toBe(cur);
  });

  it("moves the OUT edge of a set range", () => {
    expect(markRangeOut(r(10, 30), 45)).toEqual(r(10, 45));
  });

  it("collapses a set range to a fresh armed OUT rather than inverting it", () => {
    expect(markRangeOut(r(10, 30), 10)).toEqual(r(null, 10));
    expect(markRangeOut(r(10, 30), 5)).toEqual(r(null, 5));
  });
});

describe("the machine never produces an inverted or zero-width range", () => {
  it("holds across a long pseudo-random walk of marks", () => {
    // The property that matters more than any single transition: whatever
    // sequence of marks and scrub positions a user produces, a SET range is
    // always a real, forward span.
    let cur = EMPTY_RANGE;
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 2000; i += 1) {
      const t = Math.round(next() * 6000) / 100; // 0…60s, hundredths
      const pick = next();
      cur = pick < 0.4 ? markRangeIn(cur, t) : pick < 0.8 ? markRangeOut(cur, t) : tapRange(cur, t);
      if (cur.in != null && cur.out != null) {
        expect(cur.out).toBeGreaterThan(cur.in);
        expect(cur.out - cur.in).toBeGreaterThanOrEqual(MIN_RANGE_SPAN);
      }
    }
  });
});

describe("tapRange — the one-button cycle", () => {
  it("walks idle → armed → set → re-armed", () => {
    let cur = tapRange(EMPTY_RANGE, 10);
    expect(cur).toEqual(r(10, null));
    cur = tapRange(cur, 30);
    expect(cur).toEqual(r(10, 30));
    cur = tapRange(cur, 50); // SET → re-arm, NOT "move an edge"
    expect(cur).toEqual(r(50, null));
  });

  it("completes an OUT-armed range instead of re-arming it", () => {
    expect(tapRange(r(null, 30), 10)).toEqual(r(10, 30));
  });

  it("re-arms a set range even when the tap lands inside it", () => {
    // The distinction from pressing the IN key, which would MOVE the edge.
    expect(tapRange(r(10, 30), 20)).toEqual(r(20, null));
  });
});

describe("rangeToPost — what an armed range commits as", () => {
  it("posts a set range as-is, ignoring the playhead", () => {
    expect(rangeToPost(r(10, 30), 999)).toEqual({ timeStart: 10, timeEnd: 30 });
  });

  it("posts a point comment at the playhead when nothing is marked", () => {
    expect(rangeToPost(EMPTY_RANGE, 12.5)).toEqual({ timeStart: 12.5, timeEnd: null });
  });

  it("commits the live span an IN-armed pill was showing", () => {
    expect(rangeToPost(r(10, null), 30)).toEqual({ timeStart: 10, timeEnd: 30 });
  });

  it("clamps a playhead scrubbed BEHIND an armed IN, degrading to a point", () => {
    // Never an inverted range: the comment lands on the mark the user set.
    expect(rangeToPost(r(10, null), 4)).toEqual({ timeStart: 10, timeEnd: null });
    expect(rangeToPost(r(10, null), 10 + HAIR)).toEqual({ timeStart: 10, timeEnd: null });
  });

  it("commits the live span an OUT-armed pill was showing", () => {
    expect(rangeToPost(r(null, 30), 10)).toEqual({ timeStart: 10, timeEnd: 30 });
  });

  it("clamps a playhead scrubbed PAST an armed OUT, degrading to a point", () => {
    expect(rangeToPost(r(null, 30), 45)).toEqual({ timeStart: 30, timeEnd: null });
    expect(rangeToPost(r(null, 30), 30 - HAIR)).toEqual({ timeStart: 30, timeEnd: null });
  });

  it("never posts an inverted or zero-width range, for any playhead", () => {
    for (const cur of [r(10, null), r(null, 30), r(10, 30), EMPTY_RANGE]) {
      for (const t of [0, 9.99, 10, 10.01, 20, 29.99, 30, 30.01, 100]) {
        const { timeStart, timeEnd } = rangeToPost(cur, t);
        if (timeEnd != null) {
          expect(timeEnd, `${JSON.stringify(cur)} @ ${t}`).toBeGreaterThan(timeStart);
          expect(timeEnd - timeStart).toBeGreaterThanOrEqual(MIN_RANGE_SPAN);
        }
      }
    }
  });
});
