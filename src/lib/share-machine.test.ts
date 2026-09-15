import { describe, expect, it, vi } from "vitest";
import { ShareController, type ShareDeps, type ShareState } from "./share-machine";

const source = { kind: "display", id: 1, crop: null, audio: false } as const;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function opened(audio = false): Awaited<ReturnType<ShareDeps["open"]>> {
  return { stream: {} as MediaStream, track: { kind: "video" } as MediaStreamTrack,
    audioTrack: audio ? { kind: "audio" } as MediaStreamTrack : null, close: vi.fn() };
}

function makeController(overrides: Partial<ShareDeps> = {}) {
  const calls = {
    overrides: [] as Array<unknown>,
    announces: [] as boolean[],
    stops: 0,
    closes: 0,
    states: [] as ShareState[],
  };
  let died: (() => void) | null = null;
  const track = { kind: "video" } as unknown as MediaStreamTrack;
  const stream = {} as MediaStream;
  const deps: ShareDeps = {
    start: async (src) => `http://127.0.0.1:1/t/x/share/v1?kind=${src.kind}&id=${src.id}`,
    stopPipeline: async () => { calls.stops++; },
    open: async (_url, onDied) => {
      died = onDied;
      return { stream, track, audioTrack: null, close: () => { calls.closes++; } };
    },
    setOverride: (t) => calls.overrides.push(t),
    setAudioOverride: () => {},
    mixAudio: () => ({ track: { kind: "audio" } as unknown as MediaStreamTrack, close: () => {} }),
    announce: (on) => calls.announces.push(on),
    onChange: (s) => calls.states.push(s),
    log: vi.fn(),
    ...overrides,
  };
  const ctl = new ShareController(deps);
  return { ctl, calls, fireDeath: () => died?.(), track };
}

describe("share state machine", () => {
  it("owns abortable decode before open returns and passes the selected audio consent", async () => {
    let signal: AbortSignal | undefined;
    const open = vi.fn((_url, _died, options: Parameters<ShareDeps["open"]>[2]) => {
      signal = options.signal;
      return new Promise<Awaited<ReturnType<ShareDeps["open"]>>>((_, reject) => {
        options.signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
      });
    });
    const onStartError = vi.fn(), { ctl, calls } = makeController({ open, onStartError });
    const pending = ctl.start({ ...source, audio: true });
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(open.mock.calls[0][2].audio).toBe(true);
    await ctl.stop(); await pending;
    expect(signal?.aborted).toBe(true); expect(calls.states).toEqual(["starting", "idle"]);
    expect(calls.announces).toEqual([false]); expect(onStartError).not.toHaveBeenCalled();
  });
  it("start -> sharing: override out, peers flagged", async () => {
    const { ctl, calls, track } = makeController();
    await ctl.start({ kind: "display", id: 1, crop: null, audio: false });
    expect(ctl.current()).toBe("sharing");
    expect(calls.states).toEqual(["starting", "sharing"]);
    expect(calls.overrides).toEqual([track]);
    expect(calls.announces).toEqual([true]);
  });

  it("stop restores the camera and un-flags exactly once", async () => {
    const { ctl, calls } = makeController();
    await ctl.start({ kind: "display", id: 0, crop: null, audio: false });
    await ctl.stop();
    expect(ctl.current()).toBe("idle");
    expect(calls.overrides[1]).toBeNull();
    expect(calls.announces).toEqual([true, false]);
    expect(calls.stops).toBe(1);
    expect(calls.closes).toBe(1);
    // A second stop is a no-op - the cleanup can't double-fire.
    await ctl.stop();
    expect(calls.stops).toBe(1);
  });

  it("ffmpeg death converges on the SAME cleanup", async () => {
    const { ctl, calls, fireDeath } = makeController();
    await ctl.start({ kind: "display", id: 0, crop: null, audio: false });
    fireDeath();
    await Promise.resolve();
    expect(ctl.current()).toBe("idle");
    expect(calls.overrides[1]).toBeNull();
    expect(calls.announces).toEqual([true, false]);
    // A stop after the death does nothing more.
    await ctl.stop();
    expect(calls.closes).toBe(1);
  });

  it("a failed start lands back on idle with the pipeline stopped", async () => {
    const error = new Error("no proxy"), onStartError = vi.fn();
    const { ctl, calls } = makeController({ start: async () => { throw error; }, onStartError });
    await ctl.start({ kind: "display", id: 0, crop: null, audio: false });
    expect(ctl.current()).toBe("idle");
    expect(calls.announces).toEqual([false]);
    expect(calls.stops).toBe(1);
    expect(onStartError).toHaveBeenCalledExactlyOnceWith(error);
  });

  it("start while sharing is a no-op (one share at a time)", async () => {
    const { ctl, calls } = makeController();
    await ctl.start({ kind: "display", id: 0, crop: null, audio: false });
    await ctl.start({ kind: "display", id: 1, crop: null, audio: false });
    expect(calls.announces).toEqual([true]);
  });

  it("Stop owns a pending native start and never opens or announces its late URL", async () => {
    const native = deferred<string>();
    const start = vi.fn(() => native.promise), open = vi.fn(async () => opened());
    const onStartError = vi.fn();
    const { ctl, calls } = makeController({ start, open, onStartError });
    const starting = ctl.start(source);
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    const stopping = ctl.stop();
    expect(ctl.current()).toBe("idle");
    expect(calls.overrides).toEqual([null]);
    native.resolve("late-native-url");
    await Promise.all([starting, stopping]);
    expect(open).not.toHaveBeenCalled();
    expect(calls.announces).toEqual([false]);
    expect(calls.stops).toBe(2); // Immediate stop plus post-start retirement.
    expect(onStartError).not.toHaveBeenCalled();
  });

  it("Stop closes a late open without installing either audio or video", async () => {
    const opening = deferred<Awaited<ReturnType<ShareDeps["open"]>>>();
    const open = vi.fn(() => opening.promise), mixAudio = vi.fn(), setAudioOverride = vi.fn();
    const { ctl, calls } = makeController({ open, mixAudio, setAudioOverride });
    const starting = ctl.start(source);
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    const stopping = ctl.stop();
    const late = opened(true);
    opening.resolve(late);
    await Promise.all([starting, stopping]);
    expect(late.close).toHaveBeenCalledTimes(1);
    expect(mixAudio).not.toHaveBeenCalled();
    expect(setAudioOverride).toHaveBeenCalledExactlyOnceWith(null);
    expect(calls.overrides).toEqual([null]);
    expect(calls.announces).toEqual([false]);
    expect(calls.states).toEqual(["starting", "idle"]);
  });

  it("a retired open failure cannot report an error or clean up the replacement", async () => {
    const opening = deferred<Awaited<ReturnType<ShareDeps["open"]>>>();
    const replacement = opened();
    const open = vi.fn().mockImplementationOnce(() => opening.promise).mockResolvedValueOnce(replacement);
    const start = vi.fn(async () => "url"), onStartError = vi.fn();
    const { ctl, calls } = makeController({ start, open, onStartError });
    const first = ctl.start(source);
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    const stopping = ctl.stop();
    const second = ctl.start({ ...source, id: 2 });
    expect(ctl.current()).toBe("starting");
    expect(start).toHaveBeenCalledTimes(1);
    opening.reject(new Error("retired open failed"));
    await Promise.all([first, stopping, second]);
    expect(ctl.current()).toBe("sharing");
    expect(onStartError).not.toHaveBeenCalled();
    expect(calls.overrides).toEqual([null, replacement.track]);
    expect(calls.announces).toEqual([false, true]);
    expect(replacement.close).not.toHaveBeenCalled();
  });

  it("replacement waits for the last old global stop even after late open settles", async () => {
    const opening = deferred<Awaited<ReturnType<ShareDeps["open"]>>>();
    const finalStop = deferred<void>();
    const old = opened(), replacement = opened();
    const stopPipeline = vi.fn().mockResolvedValueOnce(undefined).mockImplementationOnce(() => finalStop.promise);
    const start = vi.fn(async () => "url");
    const open = vi.fn().mockImplementationOnce(() => opening.promise).mockResolvedValueOnce(replacement);
    const { ctl, calls } = makeController({ start, open, stopPipeline });
    const first = ctl.start(source);
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    const stopping = ctl.stop();
    const second = ctl.start({ ...source, id: 2 });
    opening.resolve(old);
    await first;
    await vi.waitFor(() => expect(stopPipeline).toHaveBeenCalledTimes(2));
    expect(old.close).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(calls.announces).toEqual([false]);
    finalStop.resolve();
    await Promise.all([stopping, second]);
    expect(start).toHaveBeenCalledTimes(2);
    expect(calls.announces).toEqual([false, true]);
  });

  it("session end cancels a replacement waiting behind an earlier cleanup", async () => {
    const stoppingNative = deferred<void>();
    const start = vi.fn(async () => "url"), stopPipeline = vi.fn(() => stoppingNative.promise);
    const { ctl, calls } = makeController({ start, stopPipeline });
    await ctl.start(source);
    const firstStop = ctl.stop();
    const replacement = ctl.start({ ...source, id: 2 });
    const sessionEnd = ctl.stop();
    expect(ctl.current()).toBe("idle");
    stoppingNative.resolve();
    await Promise.all([firstStop, replacement, sessionEnd]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stopPipeline).toHaveBeenCalledTimes(1);
    expect(calls.announces.filter(Boolean)).toEqual([true]);
  });

  it("old death callbacks cannot stop the new share or clear its audio mix", async () => {
    const callbacks: Array<() => void> = [];
    const streams = [opened(true), opened(true)];
    const mixes = [{ track: {} as MediaStreamTrack, close: vi.fn() }, { track: {} as MediaStreamTrack, close: vi.fn() }];
    const setAudioOverride = vi.fn();
    const mixAudio = vi.fn().mockReturnValueOnce(mixes[0]).mockReturnValueOnce(mixes[1]);
    const open = vi.fn(async (_url: string, died: () => void) => {
      callbacks.push(died);
      return streams[callbacks.length - 1];
    });
    const { ctl, calls } = makeController({ open, mixAudio, setAudioOverride });
    await ctl.start(source); await ctl.stop();
    await ctl.start({ ...source, id: 2 });
    callbacks[0](); callbacks[0]();
    await Promise.resolve();
    expect(ctl.current()).toBe("sharing");
    expect(calls.stops).toBe(1);
    expect(calls.announces).toEqual([true, false, true]);
    expect(calls.overrides).toEqual([streams[0].track, null, streams[1].track]);
    expect(mixes[0].close).toHaveBeenCalledTimes(1);
    expect(mixes[1].close).not.toHaveBeenCalled();
    expect(setAudioOverride.mock.calls.map(([track]) => track)).toEqual([mixes[0].track, null, mixes[1].track]);
    await ctl.stop();
  });

  it("death during open retracts once and owns the eventual handle", async () => {
    const late = opened();
    const { ctl, calls } = makeController({ open: async (_url, died) => { died(); return late; } });
    await ctl.start(source); await ctl.stop();
    expect(late.close).toHaveBeenCalledTimes(1);
    expect(ctl.current()).toBe("idle");
    expect(calls.announces).toEqual([false]);
    expect(calls.overrides).toEqual([null]);
  });

  it("a failure notification cannot outlive session end while cleanup is pending", async () => {
    const nativeStop = deferred<void>(), onStartError = vi.fn();
    const stopPipeline = vi.fn(() => nativeStop.promise);
    const { ctl } = makeController({ start: async () => { throw new Error("permission denied"); }, stopPipeline, onStartError });
    const starting = ctl.start(source);
    await vi.waitFor(() => expect(stopPipeline).toHaveBeenCalledTimes(1));
    const ending = ctl.stop();
    nativeStop.resolve();
    await Promise.all([starting, ending]);
    expect(onStartError).not.toHaveBeenCalled();
  });
});
