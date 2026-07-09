import { describe, expect, it } from "vitest";
import { createScrubPump } from "./scrub-pump";

/**
 * A controllable async "decoder": each drain call records its target and
 * parks on a promise we resolve by hand, so requests can be interleaved
 * deterministically around an in-flight decode.
 */
function deferredDrain() {
  const started: number[] = [];
  let resolveCurrent: (() => void) | null = null;
  const drain = (target: number): Promise<void> =>
    new Promise<void>((resolve) => {
      started.push(target);
      resolveCurrent = () => {
        resolveCurrent = null;
        resolve();
      };
    });
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));
  return {
    drain,
    started,
    inFlight: (): boolean => resolveCurrent !== null,
    /** Finish the in-flight drain and let the pump's loop advance. */
    async finish(): Promise<void> {
      if (!resolveCurrent) throw new Error("no drain in flight");
      resolveCurrent();
      await flush();
    },
  };
}

describe("createScrubPump", () => {
  it("runs a single request immediately", async () => {
    const d = deferredDrain();
    const pump = createScrubPump(d.drain);
    pump.request(5);
    await Promise.resolve();
    expect(d.started).toEqual([5]);
    expect(pump.isBusy()).toBe(true);
    await d.finish();
    expect(pump.isBusy()).toBe(false);
  });

  it("coalesces to the latest target — intermediate targets are dropped", async () => {
    const d = deferredDrain();
    const pump = createScrubPump(d.drain);

    // First request starts decoding immediately.
    pump.request(1);
    await Promise.resolve();
    expect(d.started).toEqual([1]);

    // While 1 is in flight, two more arrive. Only the freshest (3) should
    // survive; 2 is superseded before it ever starts.
    pump.request(2);
    pump.request(3);
    expect(d.started).toEqual([1]); // still only 1 has started

    await d.finish(); // 1 completes → loop picks up the latest (3), skips 2
    expect(d.started).toEqual([1, 3]);

    await d.finish(); // 3 completes → nothing pending, loop stops
    expect(d.started).toEqual([1, 3]);
    expect(pump.isBusy()).toBe(false);
  });

  it("drains sequential requests one at a time when idle between them", async () => {
    const d = deferredDrain();
    const pump = createScrubPump(d.drain);

    pump.request(10);
    await Promise.resolve();
    await d.finish();
    expect(d.started).toEqual([10]);

    pump.request(20);
    await Promise.resolve();
    await d.finish();
    expect(d.started).toEqual([10, 20]);
    expect(pump.isBusy()).toBe(false);
  });

  it("cancel() drops a pending target that has not started yet", async () => {
    const d = deferredDrain();
    const pump = createScrubPump(d.drain);

    pump.request(1);
    await Promise.resolve();
    expect(d.started).toEqual([1]);

    pump.request(2); // queued behind the in-flight 1
    pump.cancel(); // drop it before it starts

    await d.finish(); // 1 finishes; nothing pending → 2 never runs
    expect(d.started).toEqual([1]);
    expect(pump.isBusy()).toBe(false);
  });

  it("keeps only the newest of many rapid requests during one decode", async () => {
    const d = deferredDrain();
    const pump = createScrubPump(d.drain);

    pump.request(0);
    await Promise.resolve();

    // Simulate a fast drag: a burst of targets during a single decode.
    for (let t = 1; t <= 9; t++) pump.request(t);
    expect(d.started).toEqual([0]);

    await d.finish();
    expect(d.started).toEqual([0, 9]); // eight intermediate frames skipped
    await d.finish();
    expect(pump.isBusy()).toBe(false);
  });
});
