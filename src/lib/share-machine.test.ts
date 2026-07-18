import { describe, expect, it, vi } from "vitest";
import { ShareController, type ShareDeps, type ShareState } from "./share-machine";

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
    start: async (i) => `http://127.0.0.1:1/t/x/share/v1?display=${i}`,
    stopPipeline: async () => { calls.stops++; },
    open: async (_url, onDied) => {
      died = onDied;
      return { stream, track, close: () => { calls.closes++; } };
    },
    setOverride: (t) => calls.overrides.push(t),
    announce: (on) => calls.announces.push(on),
    onChange: (s) => calls.states.push(s),
    log: vi.fn(),
    ...overrides,
  };
  const ctl = new ShareController(deps);
  return { ctl, calls, fireDeath: () => died?.(), track };
}

describe("share state machine", () => {
  it("start -> sharing: override out, peers flagged", async () => {
    const { ctl, calls, track } = makeController();
    await ctl.start(1);
    expect(ctl.current()).toBe("sharing");
    expect(calls.states).toEqual(["starting", "sharing"]);
    expect(calls.overrides).toEqual([track]);
    expect(calls.announces).toEqual([true]);
  });

  it("stop restores the camera and un-flags exactly once", async () => {
    const { ctl, calls } = makeController();
    await ctl.start(0);
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
    await ctl.start(0);
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
    const { ctl, calls } = makeController({ start: async () => { throw new Error("no proxy"); } });
    await ctl.start(0);
    expect(ctl.current()).toBe("idle");
    expect(calls.announces).toEqual([false]);
    expect(calls.stops).toBe(1);
  });

  it("start while sharing is a no-op (one share at a time)", async () => {
    const { ctl, calls } = makeController();
    await ctl.start(0);
    await ctl.start(1);
    expect(calls.announces).toEqual([true]);
  });
});
