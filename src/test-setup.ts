/**
 * Vitest setup — runs before every test file, node and jsdom alike.
 *
 * Keep this SMALL. It is not a place to stub away real behaviour; a component
 * test that only passes because this file faked something is worth less than
 * no test. Everything here fills in a browser API that jsdom genuinely does
 * not implement, and each one is a no-op in the node environment where the
 * ~550 pure-logic tests run.
 *
 * Everything goes through this untyped view of the global rather than through
 * `window`, because `!("ResizeObserver" in window)` narrows the negative
 * branch to `never` — TypeScript's lib.dom says the property is always there,
 * which is exactly the claim jsdom disproves.
 */
const g = globalThis as unknown as Record<string, unknown>;

if (typeof document !== "undefined") {
  // jsdom has no layout engine, so it ships no ResizeObserver. Components
  // that measure themselves (Timeline's track, the transcript viewport) call
  // `new ResizeObserver(...)` in an effect and throw on mount without it.
  //
  // It never fires. That is correct rather than lazy: nothing in jsdom has a
  // size to report, so a callback here would be inventing measurements. A
  // test that cares about a measured width should set it explicitly.
  if (g.ResizeObserver == null) {
    g.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }

  // Same story: no layout, so no intersection.
  if (g.IntersectionObserver == null) {
    g.IntersectionObserver = class {
      readonly root = null;
      readonly rootMargin = "";
      readonly thresholds: readonly number[] = [];
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    };
  }

  // jsdom implements neither, and React warns loudly when a component
  // schedules with one and it never runs. Straight to the timer queue.
  if (g.requestAnimationFrame == null) {
    g.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 0);
    g.cancelAnimationFrame = (id: number) => clearTimeout(id);
  }

  // localStorage is where every user preference in this app lives, so a
  // component test without it tests very little.
  //
  // Node 22+ ships its own experimental Web Storage global, and on Node 25 it
  // is present by default. It needs `--localstorage-file` to actually work;
  // without one you get an object that exists, satisfies `"localStorage" in
  // globalThis`, and has no methods — `localStorage.clear` is `undefined`, not
  // a function. Because the global is already defined, jsdom does not install
  // its own over the top, so the test environment inherits the broken one.
  //
  // Detect by capability rather than by version and replace it with a plain
  // in-memory Storage. Checked on `clear` specifically because that is the
  // first method a test reaches for.
  const store = g.localStorage as { clear?: unknown } | undefined;
  if (typeof store?.clear !== "function") {
    const map = new Map<string, string>();
    const storage: Storage = {
      get length() { return map.size; },
      key: (i: number) => [...map.keys()][i] ?? null,
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => { map.set(k, String(v)); },
      removeItem: (k: string) => { map.delete(k); },
      clear: () => map.clear(),
    };
    g.localStorage = storage;
    g.sessionStorage = storage;
    if (typeof window !== "undefined") {
      Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
      Object.defineProperty(window, "sessionStorage", { value: storage, configurable: true });
    }
  }

  // matchMedia is how the app reads prefers-reduced-motion and the colour
  // scheme. Default every query to "no": a test should opt IN to a media
  // state, never inherit one.
  if (g.matchMedia == null) {
    g.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    });
  }
}

/**
 * Make one localStorage method throw, for tests that cover a failure path.
 *
 * Lives here because it exists entirely to work around the quirk documented
 * above. Which object owns the methods differs by machine: with the stub
 * installed they are OWN properties, so a `Storage.prototype` spy intercepts
 * nothing; where the real Storage is present they are INHERITED, so an
 * instance spy intercepts nothing. Each spy passes silently on the machine it
 * is wrong for — one such test was green locally and red in CI.
 *
 * Swapping the global sidesteps the question: modules read `localStorage` by
 * name at call time, so they see whatever is installed.
 */
export function withFailingStorage(method: "getItem" | "setItem", run: () => void): void {
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
