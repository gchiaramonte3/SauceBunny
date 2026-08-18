import { beforeEach, describe, expect, it } from "vitest";
import {
  countHiddenNotices, hiddenNoticeKeys, restoreHiddenNotices, HIDDEN_NOTICE_KEYS,
} from "./hidden-notices";

/** A localStorage stand-in; the node environment has no real one. */
function fakeStore(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => map.clear(),
  } as Storage;
}

describe("hidden notices", () => {
  let store: Storage;
  beforeEach(() => {
    store = fakeStore({
      "saucebunny.renameDiskAck": "1",
      "saucebunny.onboarding": '{"dismissed":true}',
      "saucebunny.noticeDismissed./a/one.srt": "1",
      "saucebunny.noticeDismissed./b/two.srt": "1",
      "saucebunny.timingFixDismissed./a/one.srt": "1",
      // Not a notice. Restoring warnings must not touch the user's settings.
      "saucebunny.defaults": '{"folder":"/out"}',
      "saucebunny.speakers": "{}",
    });
  });

  it("finds exact keys and whole per-path families", () => {
    expect(countHiddenNotices(store)).toBe(5);
  });

  it("leaves everything that is not a notice alone", () => {
    restoreHiddenNotices(store);
    expect(store.getItem("saucebunny.defaults"), "wiped a real preference").not.toBeNull();
    expect(store.getItem("saucebunny.speakers"), "wiped the speaker overrides").not.toBeNull();
  });

  it("clears every notice in ONE pass, including the per-path ones", () => {
    // The bug this guards: removeItem inside a store.key(i) walk reindexes the
    // store under the loop and skips every other match, leaving a "restored"
    // user still missing half their warnings — a failure shaped like success.
    const n = restoreHiddenNotices(store);
    expect(n).toBe(5);
    expect(countHiddenNotices(store), "a second pass would have been needed").toBe(0);
  });

  it("is a no-op, reporting zero, when nothing is hidden", () => {
    const empty = fakeStore({ "saucebunny.defaults": "{}" });
    expect(restoreHiddenNotices(empty)).toBe(0);
    expect(countHiddenNotices(empty)).toBe(0);
  });

  it("returns the keys it would clear, so the count and the action agree", () => {
    const keys = hiddenNoticeKeys(store);
    expect(keys).toHaveLength(countHiddenNotices(store));
    expect(keys).toContain("saucebunny.renameDiskAck");
    expect(keys.filter((k) => k.startsWith("saucebunny.noticeDismissed."))).toHaveLength(2);
  });

  it("labels every entry, since the list is what Settings describes", () => {
    for (const n of HIDDEN_NOTICE_KEYS) {
      expect(n.label.trim().length, `${n.key} has no label`).toBeGreaterThan(0);
    }
  });
});
