// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_PER_REVIEW, __clearAllOutboxes, clearDelivered, discardOutbox,
  enqueueOp, pendingCount, pendingOps,
} from "./review-outbox";
import type { ReviewOp } from "./review";

const op = (id: string): ReviewOp => ({ t: "del", id });

beforeEach(() => { localStorage.clear(); __clearAllOutboxes(); });
afterEach(() => { localStorage.clear(); });

describe("the review outbox", () => {
  it("keeps a note nobody received", () => {
    enqueueOp("film-a", op("1"));
    expect(pendingOps("film-a")).toEqual([op("1")]);
  });

  it("survives a reload, which is the entire point", () => {
    // The in-memory queue this replaces was wiped on session teardown, so a
    // note written after the host dropped was applied locally and lost.
    enqueueOp("film-a", op("1"));
    const raw = localStorage.getItem("saucebunny.review.outbox");
    expect(raw, "nothing was written to storage").toBeTruthy();
    expect(JSON.parse(raw!)["film-a"]).toHaveLength(1);
  });

  it("keeps reviews apart", () => {
    enqueueOp("film-a", op("1"));
    enqueueOp("film-b", op("2"));
    expect(pendingOps("film-a")).toEqual([op("1")]);
    expect(pendingCount()).toBe(2);
  });

  it("drops only what was delivered, not what arrived mid-drain", () => {
    // The window is real: the drain awaits an invoke per op, and a note
    // written during it must not be thrown away with the successful ones.
    enqueueOp("film-a", op("1"));
    enqueueOp("film-a", op("2"));
    const draining = pendingOps("film-a");
    enqueueOp("film-a", op("3"));           // written mid-drain
    clearDelivered("film-a", draining);
    expect(pendingOps("film-a"), "the note written during the drain was lost").toEqual([op("3")]);
  });

  it("removes the review entirely once it is empty", () => {
    enqueueOp("film-a", op("1"));
    clearDelivered("film-a", [op("1")]);
    expect(pendingOps("film-a")).toEqual([]);
    expect(JSON.parse(localStorage.getItem("saucebunny.review.outbox")!)).toEqual({});
  });

  it("is bounded, and keeps the RECENT notes", () => {
    // Nothing guarantees a host ever returns, and an unbounded store is a
    // quota failure waiting to happen. If someone has written past the cap
    // into the void, the recent notes are the ones they still care about.
    for (let i = 0; i < MAX_PER_REVIEW + 5; i++) enqueueOp("film-a", op(String(i)));
    const q = pendingOps("film-a");
    expect(q).toHaveLength(MAX_PER_REVIEW);
    expect(q[0], "it trimmed the newest instead of the oldest").toEqual(op("5"));
    expect(q.at(-1)).toEqual(op(String(MAX_PER_REVIEW + 4)));
  });

  it("discards a review a user gives up on", () => {
    enqueueOp("film-a", op("1"));
    discardOutbox("film-a");
    expect(pendingOps("film-a")).toEqual([]);
  });

  it("ignores an empty key rather than filing under one", () => {
    expect(enqueueOp("", op("1"))).toBe(0);
    expect(pendingCount()).toBe(0);
  });

  it("survives a mangled stored value", () => {
    localStorage.setItem("saucebunny.review.outbox", "{not json");
    expect(pendingOps("film-a")).toEqual([]);
    expect(() => enqueueOp("film-a", op("1"))).not.toThrow();
  });
});
