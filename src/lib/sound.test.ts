// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The UI cue synthesiser, and the reason it was silent.
 *
 * Every cue here fires from an async completion — an export finishing, a
 * transcript landing — never from a click. WKWebView starts an AudioContext
 * created outside a user gesture in the "suspended" state, where scheduling an
 * oscillator succeeds and produces nothing. `getCtx` cached that context for
 * the life of the page and never called `resume()`, so the app had no sounds
 * at all and no error to explain it.
 *
 * A note on what is being stubbed. There is no AudioContext in jsdom, so one
 * is supplied — but the assertions are about THIS module's decisions (does it
 * resume a suspended context? does it reuse one? does it survive a constructor
 * that throws?), not about the platform doing what the stub was told to do.
 * The distinction matters: a test asserting "createOscillator was called with
 * 880" would only be restating the source. The one below that counts `resume`
 * calls is checking the exact line whose absence made the feature dead.
 */

type StubOsc = { type: string; frequency: { value: number }; connect: () => StubOsc; start: (t: number) => void; stop: (t: number) => void };

function installAudioContext(opts: { state?: string; throwOnConstruct?: boolean } = {}) {
  const calls = { constructed: 0, resumed: 0, started: [] as number[], freqs: [] as number[] };
  class StubCtx {
    state: string;
    currentTime = 0;
    destination = {};
    constructor() {
      calls.constructed += 1;
      if (opts.throwOnConstruct) throw new Error("no audio hardware");
      this.state = opts.state ?? "running";
    }
    resume() { calls.resumed += 1; this.state = "running"; return Promise.resolve(); }
    createOscillator(): StubOsc {
      const osc: StubOsc = {
        type: "sine",
        frequency: { value: 0 },
        connect: () => osc,
        start: (t: number) => { calls.started.push(t); calls.freqs.push(osc.frequency.value); },
        stop: () => {},
      };
      return osc;
    }
    createGain() {
      const g = {
        gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
        connect: () => ({}),
      };
      return g;
    }
  }
  (window as unknown as { AudioContext: unknown }).AudioContext = StubCtx;
  return calls;
}

/** The module caches its context in a closure, so each test needs a fresh copy. */
async function freshModule() {
  vi.resetModules();
  return import("./sound");
}

afterEach(() => {
  delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  delete (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext;
});

describe("a suspended context", () => {
  it("is resumed, which is the whole bug", () => {
    // Without this line every cue scheduled silently and the app had no sound.
    const calls = installAudioContext({ state: "suspended" });
    return freshModule().then((m) => {
      m.playSuccess();
      expect(calls.resumed, "a suspended context was never resumed").toBeGreaterThan(0);
    });
  });

  it("is not resumed repeatedly once running", () => {
    // resume() is a no-op on a running context, but calling it every cue would
    // still be noise. The state check should stop after the first.
    const calls = installAudioContext({ state: "suspended" });
    return freshModule().then((m) => {
      m.playSuccess();
      m.playInfo();
      m.playError();
      expect(calls.resumed).toBe(1);
    });
  });

  it("leaves an already-running context alone", () => {
    const calls = installAudioContext({ state: "running" });
    return freshModule().then((m) => {
      m.playSuccess();
      expect(calls.resumed).toBe(0);
      expect(calls.started.length, "nothing was scheduled at all").toBeGreaterThan(0);
    });
  });
});

describe("the context is built once", () => {
  it("is reused across every cue rather than constructed per call", () => {
    // A new AudioContext per cue would exhaust the browser's limit within a
    // session; the cache is load-bearing, not an optimisation.
    const calls = installAudioContext();
    return freshModule().then((m) => {
      m.playSuccess();
      m.playError();
      m.playInfo();
      expect(calls.constructed).toBe(1);
    });
  });
});

describe("when audio is unavailable", () => {
  it("does not throw if the constructor does", () => {
    // Some machines and locked-down configurations have no audio output. A
    // failed cue must never take down the export that triggered it.
    installAudioContext({ throwOnConstruct: true });
    return freshModule().then((m) => {
      expect(() => { m.playSuccess(); m.playError(); m.playInfo(); }).not.toThrow();
    });
  });

  it("does not throw when the platform has no AudioContext at all", () => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    return freshModule().then((m) => {
      expect(() => m.playSuccess()).not.toThrow();
    });
  });

  it("falls back to the webkit-prefixed constructor when that is all there is", () => {
    const calls = installAudioContext();
    const Ctor = (window as unknown as { AudioContext: unknown }).AudioContext;
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    (window as unknown as { webkitAudioContext: unknown }).webkitAudioContext = Ctor;
    return freshModule().then((m) => {
      m.playSuccess();
      expect(calls.constructed).toBe(1);
    });
  });
});

describe("the cues themselves", () => {
  it("schedules two ascending tones for success", () => {
    const calls = installAudioContext();
    return freshModule().then((m) => {
      m.playSuccess();
      expect(calls.freqs).toHaveLength(2);
      expect(calls.freqs[1], "the chime should ascend").toBeGreaterThan(calls.freqs[0]);
    });
  });

  it("schedules two DESCENDING tones for error, which the doc used to deny", () => {
    // The doc said "Single low buzz". It has always played two, and they fall.
    const calls = installAudioContext();
    return freshModule().then((m) => {
      m.playError();
      expect(calls.freqs).toHaveLength(2);
      expect(calls.freqs[1], "the buzz should descend").toBeLessThan(calls.freqs[0]);
    });
  });

  it("schedules exactly one tone for info", () => {
    const calls = installAudioContext();
    return freshModule().then((m) => {
      m.playInfo();
      expect(calls.freqs).toHaveLength(1);
    });
  });

  it("staggers the second tone rather than stacking both at once", () => {
    // Both tones starting at t0 would be a chord, not a chime.
    const calls = installAudioContext();
    return freshModule().then((m) => {
      m.playSuccess();
      expect(calls.started[1]).toBeGreaterThan(calls.started[0]);
    });
  });
});
