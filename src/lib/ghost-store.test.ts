import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GHOST_TTL_MS, PRESENCE_KEEPALIVE_MS, clearGhosts, getGhosts, pruneGhosts,
  shouldSendPresence, subscribeGhosts, upsertGhost,
} from "./ghost-store";

afterEach(() => clearGhosts());

describe("the ghost store", () => {
  it("one ghost per peer: a new beat replaces, never appends", () => {
    upsertGhost("Ada", 10, 1000);
    upsertGhost("Ada", 11, 1350);
    expect(getGhosts()).toEqual([{ name: "Ada", position: 11, at: 1350 }]);
  });

  it("prune is IDENTITY when nothing expired - the whole point of the store", () => {
    // The inline version filtered into a fresh array every 350ms tick, which
    // defeated React's bail-out: a host alone in a paused room re-rendered
    // the entire App tree ~3x a second for the life of the session.
    upsertGhost("Ada", 10, 1000);
    const before = getGhosts();
    const fired = vi.fn();
    const un = subscribeGhosts(fired);
    pruneGhosts(1000 + GHOST_TTL_MS - 1);
    expect(getGhosts()).toBe(before);
    expect(fired).not.toHaveBeenCalled();
    un();
  });

  it("prune drops a silent peer and notifies once", () => {
    upsertGhost("Ada", 10, 1000);
    upsertGhost("Lin", 20, 4000);
    const fired = vi.fn();
    const un = subscribeGhosts(fired);
    pruneGhosts(1000 + GHOST_TTL_MS);
    expect(getGhosts().map((g) => g.name)).toEqual(["Lin"]);
    expect(fired).toHaveBeenCalledTimes(1);
    un();
  });

  it("an upsert also sweeps peers that expired since the last prune", () => {
    upsertGhost("Ada", 10, 1000);
    upsertGhost("Lin", 20, 1000 + GHOST_TTL_MS + 100);
    expect(getGhosts().map((g) => g.name)).toEqual(["Lin"]);
  });

  it("clear empties the room, and clearing an empty room stays silent", () => {
    upsertGhost("Ada", 10, 1000);
    clearGhosts();
    expect(getGhosts()).toEqual([]);
    const fired = vi.fn();
    const un = subscribeGhosts(fired);
    clearGhosts();
    expect(fired).not.toHaveBeenCalled();
    un();
  });
});

describe("shouldSendPresence", () => {
  it("a moving playhead sends every tick", () => {
    expect(shouldSendPresence(10, 10.35, 1000, 1350)).toBe(true);
  });

  it("a paused frame-step still announces immediately", () => {
    // One frame at 30fps is 0.033s - well over the half-frame-at-60 gate.
    expect(shouldSendPresence(10, 10 + 1 / 30, 1000, 1350)).toBe(true);
  });

  it("a parked playhead only sends the keepalive beat", () => {
    expect(shouldSendPresence(10, 10, 1000, 1350)).toBe(false);
    expect(shouldSendPresence(10, 10, 1000, 1000 + PRESENCE_KEEPALIVE_MS)).toBe(true);
  });

  it("the keepalive comes well inside the receiver's TTL, so a parked ghost never flickers", () => {
    expect(PRESENCE_KEEPALIVE_MS * 2).toBeLessThan(GHOST_TTL_MS);
  });

  it("the very first tick sends, via the keepalive - NaN never moves", () => {
    // NaN comparisons are always false, so the movement gate can never fire
    // on the first beat; the sender seeds lastSentAt = 0, which makes the
    // keepalive condition true against any real clock. Pin both halves.
    expect(shouldSendPresence(Number.NaN, 10, 0, Date.now())).toBe(true);
    expect(shouldSendPresence(Number.NaN, 10, Date.now(), Date.now() + 350)).toBe(false);
  });
});
