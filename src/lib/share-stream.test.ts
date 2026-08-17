// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { openShareStream } from "./share-stream";

/**
 * The two ways a screen share used to hang instead of failing.
 *
 * This module is the DOM seam its own header describes — the pure state machine
 * lives in share-machine.ts. So yes, the environment below is scaffolding:
 * jsdom has no MediaSource, no SourceBuffer and no captureStream. But the
 * assertions are not about the scaffolding. Both bugs were control flow, and
 * both produced a HANG rather than an error, which is the failure a state
 * machine cannot recover from because it is never told anything happened.
 *
 *   1. `gotData` had a resolve and no reject. A stream that ended or errored
 *      before its first byte left `await gotData` waiting forever:
 *      openShareStream never settled, teardown never ran, and a detached
 *      playing <video>, an open MediaSource and a live read loop stayed behind
 *      for the rest of the session. A proxy answering 200 with an empty body
 *      reaches it.
 *   2. The quota-recovery branch returned from INSIDE a guard it had already
 *      failed. With `keepFrom === 0` — every quota hit in the first ten seconds
 *      of playback — nothing was evicted, so no `updateend` fired, so `pump`
 *      was never re-entered, and the share stalled with no death reported.
 *
 * Both are now assertions that finish. Before the fix the first test times out
 * rather than failing, which is itself the point.
 */

// ── A MediaSource/SourceBuffer/fetch environment just real enough ────────────

type Listener = () => void;

class FakeSourceBuffer {
  mode = "";
  updating = false;
  appends: number[] = [];
  removes: Array<[number, number]> = [];
  /** Set to throw this on the Nth append (1-based). */
  throwOnAppend: { nth: number; error: DOMException } | null = null;
  /** When true, `remove` itself throws — the un-evictable case. */
  removeThrows = false;
  private listeners: Listener[] = [];
  addEventListener(_: string, fn: Listener) { this.listeners.push(fn); }
  appendBuffer(b: BufferSource) {
    this.appends.push((b as Uint8Array).byteLength);
    if (this.throwOnAppend && this.appends.length === this.throwOnAppend.nth) {
      throw this.throwOnAppend.error;
    }
  }
  remove(a: number, b: number) {
    if (this.removeThrows) throw new DOMException("cannot remove", "InvalidStateError");
    this.removes.push([a, b]);
    for (const fn of this.listeners) fn();   // updateend re-enters pump
  }
}

class FakeMediaSource {
  readyState = "closed";
  sb = new FakeSourceBuffer();
  private open: Listener[] = [];
  addEventListener(type: string, fn: Listener) {
    if (type === "sourceopen") {
      this.open.push(fn);
      // Fire on a later tick, the way the real event does.
      setTimeout(() => { this.readyState = "open"; fn(); }, 0);
    }
  }
  addSourceBuffer() { return this.sb as unknown as SourceBuffer; }
  endOfStream() {}
}

/**
 * A body: chunks then EOF, chunks then still-live, empty, or a throwing read.
 *
 * "live" matters for the quota tests. A real share stream does not end - it
 * keeps arriving until the sharer stops. With a body that reaches EOF, the
 * reader loop legitimately calls died() once the chunks run out, so a test
 * asserting "no death" fails for a reason that has nothing to do with quota.
 * The hanging read models the live case, and leaves only the quota path able to
 * report a death.
 */
function bodyOf(mode: "chunks" | "live" | "empty" | "error", chunks: Uint8Array[] = []) {
  let i = 0;
  return {
    getReader: () => ({
      read: async () => {
        if (mode === "error") throw new Error("connection reset");
        if (mode === "empty") return { done: true, value: undefined };
        if (i < chunks.length) return { done: false, value: chunks[i++] };
        // Never settles: the stream is still open, nothing more has arrived.
        if (mode === "live") return new Promise<never>(() => {});
        return { done: true, value: undefined };
      },
      cancel: async () => {},
    }),
  };
}

let currentMs: FakeMediaSource;

function installEnv(opts: {
  body: ReturnType<typeof bodyOf>;
  ok?: boolean;
  status?: number;
  currentTime?: number;
}) {
  currentMs = new FakeMediaSource();
  vi.stubGlobal("MediaSource", function () { return currentMs; } as unknown as typeof MediaSource);
  URL.createObjectURL = () => "blob:share";
  URL.revokeObjectURL = () => {};
  vi.stubGlobal("fetch", async () => ({
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    body: opts.body,
  }));
  // captureStream + a currentTime we control, on every <video> jsdom makes.
  const proto = window.HTMLVideoElement.prototype as unknown as Record<string, unknown>;
  proto.captureStream = function () {
    const track = { kind: "video", contentHint: "", stop() {} } as unknown as MediaStreamTrack;
    return { getVideoTracks: () => [track], getAudioTracks: () => [] } as unknown as MediaStream;
  };
  proto.play = async function () {};
  Object.defineProperty(proto, "currentTime", {
    configurable: true,
    get() { return opts.currentTime ?? 0; },
    set() {},
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const chunk = (n: number) => new Uint8Array(n);

describe("a stream that dies before its first byte", () => {
  it("REJECTS instead of hanging when the body ends immediately", async () => {
    // The bug. `await gotData` had nothing to settle it on this path, so this
    // call never returned and the caller sat on a share that was already gone.
    installEnv({ body: bodyOf("empty") });
    const onDied = vi.fn();
    await expect(openShareStream("http://127.0.0.1/x", onDied))
      .rejects.toThrow(/ended before sending any data/);
  });

  it("REJECTS instead of hanging when the read throws", async () => {
    installEnv({ body: bodyOf("error") });
    await expect(openShareStream("http://127.0.0.1/x", vi.fn()))
      .rejects.toThrow(/connection reset/);
  });

  it("tears down rather than leaking a playing video and an open MediaSource", async () => {
    // teardown() only runs via the catch, so a promise that never settled never
    // cleaned up either. This is the leak half of the same bug.
    installEnv({ body: bodyOf("empty") });
    const revoked = vi.fn();
    URL.revokeObjectURL = revoked;
    await expect(openShareStream("http://127.0.0.1/x", vi.fn())).rejects.toThrow();
    expect(revoked, "the object URL was never revoked").toHaveBeenCalled();
  });

  it("still rejects on a non-ok HTTP response", async () => {
    // The path that always worked; kept so the fix cannot regress it.
    installEnv({ body: bodyOf("chunks", [chunk(4)]), ok: false, status: 503 });
    await expect(openShareStream("http://127.0.0.1/x", vi.fn()))
      .rejects.toThrow(/HTTP 503/);
  });
});

describe("a stream that delivers data", () => {
  it("resolves with a video track and appends the chunks", async () => {
    // The canary: every rejection above is meaningless if the happy path cannot
    // open at all.
    installEnv({ body: bodyOf("chunks", [chunk(64), chunk(32)]) });
    const handle = await openShareStream("http://127.0.0.1/x", vi.fn());
    expect(handle.track.kind).toBe("video");
    expect(currentMs.sb.appends[0]).toBe(64);
    handle.close();
  });

  it("marks the track as detail, since screen content is text not motion", async () => {
    installEnv({ body: bodyOf("chunks", [chunk(8)]) });
    const handle = await openShareStream("http://127.0.0.1/x", vi.fn());
    expect(handle.track.contentHint).toBe("detail");
    handle.close();
  });
});

describe("the SourceBuffer quota", () => {
  it("evicts and retries when there is played media to drop", async () => {
    // The recovery that already worked: currentTime is past the 10s window, so
    // remove(0, currentTime-10) is issued and its updateend re-enters pump.
    installEnv({ body: bodyOf("live", [chunk(16), chunk(16)]), currentTime: 30 });
    const onDied = vi.fn();
    currentMs.sb.throwOnAppend = { nth: 1, error: new DOMException("full", "QuotaExceededError") };
    const handle = await openShareStream("http://127.0.0.1/x", onDied);
    expect(currentMs.sb.removes, "nothing was evicted").toEqual([[0, 20]]);
    expect(onDied, "a recoverable quota hit was reported as a death").not.toHaveBeenCalled();
    handle.close();
  });

  it("DIES rather than stalling when there is nothing to evict", async () => {
    // The bug: with currentTime <= 10, keepFrom is 0, so the guarded remove was
    // skipped — and the old code returned anyway. No eviction, no updateend, no
    // death: the share hung with the chunk still queued. Dying is honest; the
    // state machine can restart from it.
    installEnv({ body: bodyOf("live", [chunk(16)]), currentTime: 4 });
    const onDied = vi.fn();
    currentMs.sb.throwOnAppend = { nth: 1, error: new DOMException("full", "QuotaExceededError") };
    await openShareStream("http://127.0.0.1/x", onDied).catch(() => {});
    expect(currentMs.sb.removes, "it evicted from a stream with nothing played").toEqual([]);
    expect(onDied, "an un-evictable quota hit neither recovered nor died").toHaveBeenCalled();
  });

  it("dies when the eviction itself is refused", async () => {
    installEnv({ body: bodyOf("live", [chunk(16)]), currentTime: 30 });
    const onDied = vi.fn();
    currentMs.sb.removeThrows = true;
    currentMs.sb.throwOnAppend = { nth: 1, error: new DOMException("full", "QuotaExceededError") };
    await openShareStream("http://127.0.0.1/x", onDied).catch(() => {});
    expect(onDied).toHaveBeenCalled();
  });

  it("treats a NON-quota append failure as a death immediately", async () => {
    // Only QuotaExceededError earns a retry. Anything else is the pipeline
    // genuinely failing and must not be swallowed by the recovery path.
    installEnv({ body: bodyOf("live", [chunk(16)]), currentTime: 30 });
    const onDied = vi.fn();
    currentMs.sb.throwOnAppend = { nth: 1, error: new DOMException("bad state", "InvalidStateError") };
    await openShareStream("http://127.0.0.1/x", onDied).catch(() => {});
    expect(currentMs.sb.removes, "a non-quota error tried to evict").toEqual([]);
    expect(onDied).toHaveBeenCalled();
  });
});
