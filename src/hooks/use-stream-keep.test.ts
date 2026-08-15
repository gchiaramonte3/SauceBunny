// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useStreamKeep } from "./use-stream-keep";

const h = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown]>,
  pending: [] as Array<{ res: (p: string) => void; rej: (e: unknown) => void }>,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => {
    h.calls.push([cmd, args]);
    if (cmd === "session_fetch_file") {
      return new Promise<string>((res, rej) => { h.pending.push({ res, rej }); });
    }
    return Promise.resolve(undefined);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

/**
 * The React shell around the keep policy.
 *
 * The pure reducer had 32 tests and this file had none, which is backwards:
 * every bug this subsystem has actually shipped lived here, in the wiring
 * between an async invoke and a state machine that has already moved on. The
 * reducer cannot get the ordering wrong because it never waits for anything.
 */
const WATCH = { blake3: "aa", name: "reel.mp4", total: 1_000 };
const countOf = (cmd: string) => h.calls.filter(([c]) => c === cmd).length;
const fetches = () => countOf("session_fetch_file");
const cancels = () => countOf("session_cancel_fetch");

describe("useStreamKeep wiring", () => {
  beforeEach(() => { h.calls = []; h.pending = []; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const mount = () =>
    renderHook(() => useStreamKeep({ watching: WATCH, onHandOff: () => {} }));

  it("waits out the start delay before putting bytes on the wire", async () => {
    const { result } = mount();
    expect(fetches()).toBe(0);
    await act(async () => { vi.advanceTimersByTime(11_000); });
    expect(fetches()).toBe(1);
    expect(result.current.state.phase).toBe("keeping");
  });

  it("cancels when the stream stalls, because the stream comes first", async () => {
    const { result } = mount();
    await act(async () => { vi.advanceTimersByTime(11_000); });
    act(() => { result.current.onStall(); });
    expect(cancels()).toBe(1);
    expect(result.current.state.phase).toBe("yielded");
  });

  it("resumes after the yield even when our own cancel is still in the air", async () => {
    // THE REGRESSION. The restart used to be skipped whenever the resume beat
    // the cancel's rejection: the effect saw its own hash still marked in
    // flight and did nothing, then the late rejection cleared the slot with
    // no dep left to change. The copy stopped for good and said nothing.
    const { result } = mount();
    await act(async () => { vi.advanceTimersByTime(11_000); });
    const first = h.pending[0];
    act(() => { result.current.onStall(); });

    await act(async () => { vi.advanceTimersByTime(31_000); });
    expect(result.current.state.phase).toBe("keeping");
    expect(fetches()).toBe(2);

    // The abandoned fetch now rejects, late. It must be inert: no failure
    // badge, and no clearing of the slot the second fetch owns.
    await act(async () => { first.rej(new Error("cancelled")); await Promise.resolve(); });
    expect(result.current.state.phase).toBe("keeping");
  });

  it("does not report a failure for a cancel it asked for", async () => {
    const { result } = mount();
    await act(async () => { vi.advanceTimersByTime(11_000); });
    const first = h.pending[0];
    act(() => { result.current.onCancel(); });
    await act(async () => { first.rej(new Error("cancelled")); await Promise.resolve(); });
    expect(result.current.state.phase).not.toBe("failed");
  });

  it("hands off once the copy lands, and names the file", async () => {
    const handed: Array<[string, string]> = [];
    const { result } = renderHook(() =>
      useStreamKeep({ watching: WATCH, onHandOff: (p, n) => { handed.push([p, n]); } }),
    );
    await act(async () => { vi.advanceTimersByTime(11_000); });
    await act(async () => { h.pending[0].res("/tmp/reel.mp4"); await Promise.resolve(); });
    expect(handed).toEqual([["/tmp/reel.mp4", "reel.mp4"]]);
    expect(result.current.state.phase).toBe("done");
  });

  it("treats an explicit Get of the same file as superseding, not failing", async () => {
    // Pressing "Get the file" as well as "Watch now" makes the backend refuse
    // the second fetch. Reporting "could not save a copy" while the copy is
    // visibly downloading in the panel beside it is the chip contradicting
    // what the user can see.
    const { result } = mount();
    await act(async () => { vi.advanceTimersByTime(11_000); });
    await act(async () => {
      h.pending[0].rej(new Error("that file is already being received"));
      await Promise.resolve();
    });
    expect(result.current.state.phase).not.toBe("failed");
  });
});
