// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The per-install id, and the roster bug its own error path reintroduced.
 *
 * This module exists (r124) because minting session member ids unconditionally
 * meant a friend who dropped and rejoined came back as a SECOND member: same
 * human, fresh id, roster grew, and the abandoned tile sat on "Connecting"
 * forever. The install id lets the host recognise a returning install.
 *
 * Its catch block then did the very thing the module was written to stop. On any
 * install where localStorage throws — private mode, quota, storage disabled —
 * every call minted a new uuid, so a rejoin inside one run arrived as a stranger
 * and the roster grew exactly as before. The comment above it claimed the
 * opposite ("a rejoin inside the same run still reclaims"), which is what made
 * it hard to notice: the intent was written down, just never implemented.
 *
 * Storage is stubbed only to choose whether it throws. Everything asserted here
 * is this module's own behaviour — stability, persistence, and which failure
 * mode it degrades into.
 */

const KEY = "saucebunny.installId";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Fresh module copy — the fallback id lives in a module-level closure. */
async function freshModule() {
  vi.resetModules();
  return import("./identity");
}

/**
 * Break localStorage by REPLACING the property, not by spying on a method.
 *
 * A method spy is environment-fragile and this file has now been burned by it
 * twice. `vi.spyOn(Storage.prototype, "getItem")` never intercepts in jsdom at
 * all; `vi.spyOn(window.localStorage, "getItem")` intercepted on a Node 25
 * laptop and did NOT on CI's Node 20, so the suite went green locally and red
 * on push. The module under test reads a bare `localStorage`, and which object
 * that binding resolves to is exactly what varies.
 *
 * Substituting the property removes the question: every access path -
 * `localStorage`, `window.localStorage`, `globalThis.localStorage` - goes
 * through the same lookup, so a stub installed here is the one the module gets.
 * `which` picks the failure mode, since "quota blocks the write" and "storage
 * is disabled entirely" are different real situations.
 *
 * The CANARY test below is the guard: it seeds a known id, breaks the read, and
 * fails if the seeded value comes back. It caught both earlier mistakes.
 */
let restoreStorage: (() => void) | null = null;

function breakStorage(which: "get" | "set" | "both") {
  const real = window.localStorage;
  const die = (name: string, msg: string) => () => { throw new DOMException(msg, name); };
  const stub: Storage = {
    getItem: which === "set" ? real.getItem.bind(real) : die("SecurityError", "storage disabled"),
    setItem: which === "get" ? real.setItem.bind(real) : die("QuotaExceededError", "quota exceeded"),
    removeItem: real.removeItem.bind(real),
    clear: real.clear.bind(real),
    key: real.key.bind(real),
    get length() { return real.length; },
  } as Storage;
  // Installed on BOTH bindings. In jsdom `window === globalThis`, so this is
  // usually one write - but "usually" is what made the method-spy version pass
  // locally and fail in CI, and a test harness is free to hand the module a
  // different `localStorage` binding than `window`'s. Defining both costs
  // nothing and removes the assumption.
  const targets = window === (globalThis as unknown as Window) ? [window] : [window, globalThis];
  for (const t of targets) Object.defineProperty(t, "localStorage", { configurable: true, value: stub });
  restoreStorage = () => {
    for (const t of targets) Object.defineProperty(t, "localStorage", { configurable: true, value: real });
    restoreStorage = null;
  };
}

afterEach(() => {
  restoreStorage?.();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("the ordinary path", () => {
  it("mints an id and persists it", async () => {
    const m = await freshModule();
    const id = m.loadInstallId();
    expect(id).toMatch(UUID);
    expect(localStorage.getItem(KEY)).toBe(id);
  });

  it("returns the SAME id on every later call", async () => {
    // The whole point of the module: a returning install must be recognisable.
    const m = await freshModule();
    expect(m.loadInstallId()).toBe(m.loadInstallId());
  });

  it("returns the same id across a fresh module load, because it is on disk", async () => {
    const first = (await freshModule()).loadInstallId();
    const second = (await freshModule()).loadInstallId();
    expect(second, "a restart minted a new identity").toBe(first);
  });

  it("adopts an id already in storage rather than replacing it", async () => {
    localStorage.setItem(KEY, "11111111-2222-3333-4444-555555555555");
    const m = await freshModule();
    expect(m.loadInstallId()).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("re-mints if storage is cleared mid-run", async () => {
    // Deliberate: the happy path reads storage every call, so "regenerated by
    // clearing app data" (the doc's promise) holds without a restart. This is
    // why only the FALLBACK is cached.
    const m = await freshModule();
    const before = m.loadInstallId();
    localStorage.clear();
    const after = m.loadInstallId();
    expect(after).not.toBe(before);
    expect(after).toMatch(UUID);
  });
});

describe("when localStorage throws", () => {
  it("still returns a usable id instead of propagating", async () => {
    // A session must be joinable in private mode, not crash on identity.
    breakStorage("both");
    const m = await freshModule();
    expect(m.loadInstallId()).toMatch(UUID);
  });

  it("returns a STABLE id within the run — the bug", async () => {
    // Every call used to mint fresh, so a rejoin looked like a new person and
    // the roster grew with a tile stuck on "Connecting".
    breakStorage("both");
    const m = await freshModule();
    const a = m.loadInstallId();
    const b = m.loadInstallId();
    const c = m.loadInstallId();
    expect(b, "a rejoin inside one run got a different identity").toBe(a);
    expect(c).toBe(a);
  });

  it("is stable when only the WRITE fails", async () => {
    // The likelier real case: reading works, quota blocks the write. The read
    // returns null every time, so the id must come from the run cache rather
    // than a fresh mint per call.
    breakStorage("set");
    const m = await freshModule();
    expect(m.loadInstallId()).toBe(m.loadInstallId());
  });

  it("is stable when only the READ fails", async () => {
    breakStorage("get");
    const m = await freshModule();
    expect(m.loadInstallId()).toBe(m.loadInstallId());
  });

  it("CANARY: the fallback path is really being reached", async () => {
    // Without this the suite could pass while never entering the catch block —
    // which is exactly what happened with a prototype-level spy that jsdom
    // ignores. Seed a known id, break the read, and the seeded value must NOT
    // come back: if storage still works, it does, and this fails.
    localStorage.setItem(KEY, "deadbeef-0000-0000-0000-000000000000");
    breakStorage("get");
    const m = await freshModule();
    const id = m.loadInstallId();
    expect(id, "storage was not actually broken - these tests are vacuous")
      .not.toBe("deadbeef-0000-0000-0000-000000000000");
    expect(id).toMatch(UUID);
  });

  it("never persists the fallback, which is why a later run mints afresh", async () => {
    // The mechanism behind the accepted degradation. Asserting "a new run gets
    // a new id" directly is not possible in-process — vi.resetModules() does
    // not re-instantiate twice inside one test — but this is the property that
    // makes it true, and it is directly checkable.
    breakStorage("set");
    const m = await freshModule();
    const id = m.loadInstallId();
    restoreStorage?.();
    expect(localStorage.getItem(KEY), "the fallback id was written to disk").toBeNull();
    expect(id).toMatch(UUID);
  });
});

describe("the shape of the id", () => {
  it("is a uuid on both paths, so the host cannot tell them apart", async () => {
    // The fallback must be indistinguishable in form — a differently shaped id
    // would leak the storage failure into the wire protocol.
    const ok = (await freshModule()).loadInstallId();
    breakStorage("both");
    const degraded = (await freshModule()).loadInstallId();
    expect(ok).toMatch(UUID);
    expect(degraded).toMatch(UUID);
  });

  it("carries no personal data — it is only a random uuid", async () => {
    // The doc's privacy claim, checked rather than trusted: nothing derived
    // from the machine, the user, or the clock.
    const m = await freshModule();
    const id = m.loadInstallId();
    expect(id).toMatch(UUID);
    expect(id).not.toContain(String(new Date().getFullYear()));
  });
});
