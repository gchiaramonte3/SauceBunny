import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REACTION_TTL_MS, clearReactions, getReactions, pushReaction, subscribeReactions,
} from "./reaction-store";

beforeEach(() => { vi.useFakeTimers(); clearReactions(); });
afterEach(() => { clearReactions(); vi.useRealTimers(); });

const r = (from: string, emote = "applause") => ({ from, name: from, emote, at: 0 });

describe("the reaction store", () => {
  it("a reaction floats, then removes itself", () => {
    pushReaction(r("m1"));
    expect(getReactions()).toHaveLength(1);
    vi.advanceTimersByTime(REACTION_TTL_MS + 1);
    expect(getReactions()).toHaveLength(0);
  });

  it("notifies on push and on the timed removal, and nothing else", () => {
    const fired = vi.fn();
    const un = subscribeReactions(fired);
    pushReaction(r("m1"));
    expect(fired).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(REACTION_TTL_MS + 1);
    expect(fired).toHaveBeenCalledTimes(2);
    un();
  });

  it("an applause burst stays bounded", () => {
    for (let i = 0; i < 40; i++) pushReaction(r(`m${i}`));
    expect(getReactions().length).toBeLessThanOrEqual(24);
    // Newest survive - the burst drops from the OLD end.
    expect(getReactions().at(-1)?.from).toBe("m39");
  });

  it("ids are unique across a burst, so the float keys never collide", () => {
    for (let i = 0; i < 10; i++) pushReaction(r("m1"));
    const ids = getReactions().map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("clear empties the feed AND cancels the pending removals", () => {
    pushReaction(r("m1"));
    clearReactions();
    expect(getReactions()).toHaveLength(0);
    const fired = vi.fn();
    const un = subscribeReactions(fired);
    // A leaked timer would fire a notify into the next session's feed.
    vi.advanceTimersByTime(REACTION_TTL_MS + 1);
    expect(fired).not.toHaveBeenCalled();
    un();
  });
});
