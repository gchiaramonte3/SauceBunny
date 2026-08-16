// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadClipQueue, loadJson, saveClipQueue, saveJson } from "./storage";

/**
 * The persistence primitive everything else is built on, and the clip queue's
 * crash-rescue rules.
 *
 * Failure paths go through `withFailingStorage` rather than a spy: which of
 * `localStorage` and `Storage.prototype` actually owns the methods differs
 * between this machine and CI, so either spy passes silently on one of them.
 * See the helper for the detail.
 *
 * The rescue is the part worth pinning. A row that was MID-EXPORT when the app
 * went away comes back as "queued": only finished work is dropped, because a
 * done row points at a file on disk and a failed row at an error from a
 * session that is over. Earlier only "queued" survived, so quitting during an
 * export lost the row the user was most actively working on — by this module's
 * own reckoning the one thing in the workspace that cannot be recreated by
 * pressing a button again.
 *
 * The rest is failure behaviour: both wrappers swallow and warn rather than
 * throw, so a corrupt blob or a private-mode quota costs a preference and
 * never the boot.
 */

/**
 * Make one localStorage method throw, in a way that works in BOTH environments
 * this suite runs in.
 *
 * Locally, test-setup.ts installs a plain-object stub (Node 22+ ships a Web
 * Storage global with no methods, and jsdom will not replace an existing
 * global), so methods are OWN properties and a prototype spy hits nothing. In
 * CI the real Storage is present and the methods live on the PROTOTYPE, so an
 * instance spy hits nothing instead. Either spy passes silently on the wrong
 * machine — which is how the first version of this test went green locally and
 * red in CI.
 *
 * Replacing the global sidesteps the question: the module under test reads
 * `localStorage` by name at call time, so it sees whatever is installed.
 */
function withFailingStorage(method: "getItem" | "setItem", run: () => void): void {
  const real = globalThis.localStorage;
  const fake = {
    getItem: (k: string) => real.getItem(k),
    setItem: (k: string, v: string) => real.setItem(k, v),
    removeItem: (k: string) => real.removeItem(k),
    clear: () => real.clear(),
    key: (i: number) => real.key(i),
    get length() { return real.length; },
  } as unknown as Storage;
  (fake as unknown as Record<string, unknown>)[method] = () => {
    throw new Error(method === "setItem" ? "QuotaExceededError" : "SecurityError");
  };
  Object.defineProperty(globalThis, "localStorage", { value: fake, configurable: true, writable: true });
  try { run(); } finally {
    Object.defineProperty(globalThis, "localStorage", { value: real, configurable: true, writable: true });
  }
}

const QUEUE_KEY = "saucebunny.clipQueue";

type Row = { id: string; status: string };
const isRow = (x: unknown): x is Row =>
  !!x && typeof x === "object" && typeof (x as Row).id === "string" && typeof (x as Row).status === "string";

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("loadJson", () => {
  it("returns the stored value", () => {
    saveJson("k", { a: 1 });
    expect(loadJson("k", null)).toEqual({ a: 1 });
  });

  it("falls back rather than throwing on a corrupt blob", () => {
    // "my settings keep resetting" is a better outcome than a white screen.
    localStorage.setItem("k", "{not json");
    expect(loadJson("k", "fallback")).toBe("fallback");
    expect(console.warn).toHaveBeenCalled();
  });

  it("falls back when the key is absent or empty", () => {
    expect(loadJson("missing", 42)).toBe(42);
    localStorage.setItem("empty", "");
    expect(loadJson("empty", 42)).toBe(42);
  });

  it("falls back when localStorage itself throws", () => {
    withFailingStorage("getItem", () => {
      expect(loadJson("k", "fallback")).toBe("fallback");
    });
  });

  it("preserves a stored falsy value", () => {
    // 0 and false are real settings; they must not be mistaken for "unset".
    saveJson("zero", 0);
    saveJson("no", false);
    expect(loadJson("zero", 99)).toBe(0);
    expect(loadJson("no", true)).toBe(false);
  });
});

describe("saveJson", () => {
  it("swallows a quota failure instead of throwing", () => {
    withFailingStorage("setItem", () => {
      expect(() => saveJson("k", { big: "x" })).not.toThrow();
    });
    expect(console.warn).toHaveBeenCalled();
  });
});

describe("the clip queue survives a quit", () => {
  it("brings back a row that was mid-export, as queued", () => {
    // The rescue. Nothing starts the queue on boot, so "queued" is also the
    // honest description of its state on return.
    saveClipQueue([{ id: "a", status: "running" }]);
    const back = loadClipQueue(isRow);
    expect(back).toEqual([{ id: "a", status: "queued" }]);
  });

  it("keeps work still to do", () => {
    saveClipQueue([{ id: "a", status: "queued" }, { id: "b", status: "queued" }]);
    expect(loadClipQueue(isRow).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("drops work that already finished", () => {
    // A done row points at a file on disk and a failed row at an error from a
    // session that is over; restoring either greets the user with yesterday's
    // results in a panel that is supposed to be a to-do list.
    saveClipQueue([
      { id: "done", status: "done" },
      { id: "failed", status: "failed" },
      { id: "todo", status: "queued" },
    ]);
    expect(loadClipQueue(isRow).map((r) => r.id)).toEqual(["todo"]);
  });

  it("clears the key entirely when nothing is left to resume", () => {
    // Not an empty array: a stale key would keep reading as "there is a queue".
    saveClipQueue([{ id: "a", status: "queued" }]);
    saveClipQueue([{ id: "a", status: "done" }]);
    expect(localStorage.getItem(QUEUE_KEY)).toBeNull();
    expect(loadClipQueue(isRow)).toEqual([]);
  });

  it("survives a queue written by an older build", () => {
    // Validated row by row rather than trusted: one malformed entry must not
    // cost the user the rest of the queue.
    localStorage.setItem(QUEUE_KEY, JSON.stringify([
      { id: "ok", status: "queued" },
      { id: 7, status: "queued" },
      null,
      "nope",
      { status: "queued" },
    ]));
    expect(loadClipQueue(isRow).map((r) => r.id)).toEqual(["ok"]);
  });

  it("returns empty for storage that is not an array", () => {
    localStorage.setItem(QUEUE_KEY, JSON.stringify({ nope: true }));
    expect(loadClipQueue(isRow)).toEqual([]);
  });

  it("does not mutate the queue it was handed", () => {
    // The caller still renders this array; rewriting a status underneath it
    // would flip a running row to queued in the live UI.
    const live = [{ id: "a", status: "running" }, { id: "b", status: "done" }];
    saveClipQueue(live);
    expect(live).toEqual([{ id: "a", status: "running" }, { id: "b", status: "done" }]);
  });
});
