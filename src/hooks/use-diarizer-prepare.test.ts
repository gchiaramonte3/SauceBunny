// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useDiarizerPrepare } from "./use-diarizer-prepare";

const h = vi.hoisted(() => ({
  calls: [] as Array<{ cmd: string; args: unknown }>,
  /** event name -> handler, so a test can fire what Rust would emit. */
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
  unlistened: [] as string[],
  failInvoke: null as null | string,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: unknown) => {
    h.calls.push({ cmd, args });
    if (h.failInvoke === cmd) throw new Error("spawn refused");
    return "";
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, fn: (e: { payload: unknown }) => void) => {
    h.handlers.set(name, fn);
    return () => { h.unlistened.push(name); h.handlers.delete(name); };
  },
}));

/**
 * The speaker-model pre-warm, now that it is reachable.
 *
 * None of this could be tested while it lived in App.tsx: every case below
 * needs a `diarize-prepare-done` payload delivered to a listener that was
 * registered inside App's central event effect, which cannot be mounted
 * without mounting the whole application.
 *
 * The job-id cases are the ones that matter. Two runs of this can overlap in
 * practice - the Settings button and a retry - and resolving a run with the
 * wrong payload either strands the UI on "running" forever or reports success
 * for a download that failed.
 */

const opts = () => ({ onReady: vi.fn(), notify: vi.fn() });

async function mount(o = opts()) {
  const r = renderHook(() => useDiarizerPrepare(o));
  await waitFor(() => expect(h.handlers.has("diarize-prepare-done")).toBe(true));
  return { ...r, o };
}

/** Deliver what Rust would emit on the done channel. */
function fireDone(payload: Record<string, unknown>) {
  act(() => {
    h.handlers.get("diarize-prepare-done")?.({
      payload: { job_id: "", success: false, code: null, path: null, error: null, ...payload },
    });
  });
}

const startedJobId = () =>
  (h.calls.find((c) => c.cmd === "prepare_diarizer_models")?.args as { jobId: string }).jobId;

beforeEach(() => {
  h.calls.length = 0;
  h.unlistened.length = 0;
  h.handlers.clear();
  h.failInvoke = null;
});

describe("useDiarizerPrepare", () => {
  it("starts idle and subscribes to both channels", async () => {
    const { result } = await mount();
    expect(result.current.state).toBe("idle");
    expect(result.current.error).toBeNull();
    expect(h.handlers.has("diarize-prepare-progress")).toBe(true);
  });

  it("runs, then resolves on ITS OWN done payload", async () => {
    const { result, o } = await mount();
    await act(async () => { await result.current.prepare(); });
    expect(result.current.state).toBe("running");
    expect(h.calls.some((c) => c.cmd === "prepare_diarizer_models")).toBe(true);

    fireDone({ job_id: startedJobId(), success: true });
    expect(result.current.state).toBe("done");
    expect(result.current.error).toBeNull();
    expect(o.onReady).toHaveBeenCalledTimes(1);
    expect(o.notify).toHaveBeenCalledWith("success", "Speaker models ready", expect.any(String));
  });

  it("ignores a done payload belonging to another job", async () => {
    // Reporting somebody else's success would latch "models cached" over a
    // download that is still running - and the real one would then be
    // resolved by nothing.
    const { result, o } = await mount();
    await act(async () => { await result.current.prepare(); });

    fireDone({ job_id: "some-other-job", success: true });

    expect(result.current.state).toBe("running");
    expect(o.onReady).not.toHaveBeenCalled();
    expect(o.notify).not.toHaveBeenCalled();
  });

  it("treats a cancel as idle, not as a failure", async () => {
    // The user stopped it on purpose. An error banner for that is noise, and
    // the button has to be usable again immediately.
    const { result, o } = await mount();
    await act(async () => { await result.current.prepare(); });

    fireDone({ job_id: startedJobId(), success: false, error: "Cancelled" });

    expect(result.current.state).toBe("idle");
    expect(result.current.error).toBeNull();
    expect(o.notify).not.toHaveBeenCalled();
  });

  it("surfaces a real failure with its message", async () => {
    const { result, o } = await mount();
    await act(async () => { await result.current.prepare(); });

    fireDone({ job_id: startedJobId(), success: false, error: "no space left on device" });

    expect(result.current.state).toBe("error");
    expect(result.current.error).toBe("no space left on device");
    expect(o.onReady).not.toHaveBeenCalled();
  });

  it("names the failure even when the payload carries none", async () => {
    const { result } = await mount();
    await act(async () => { await result.current.prepare(); });
    fireDone({ job_id: startedJobId(), success: false, error: null });
    expect(result.current.error).toBe("Model preparation failed");
  });

  it("refuses a second run while one is in flight", async () => {
    // A double-click must not start two multi-hundred-MB downloads.
    const { result } = await mount();
    await act(async () => { await result.current.prepare(); });
    await act(async () => { await result.current.prepare(); });
    expect(h.calls.filter((c) => c.cmd === "prepare_diarizer_models")).toHaveLength(1);
  });

  it("allows another run once the last one settled", async () => {
    const { result } = await mount();
    await act(async () => { await result.current.prepare(); });
    fireDone({ job_id: startedJobId(), success: false, error: "boom" });
    await act(async () => { await result.current.prepare(); });
    expect(h.calls.filter((c) => c.cmd === "prepare_diarizer_models")).toHaveLength(2);
  });

  it("cancels the job it actually started", async () => {
    const { result } = await mount();
    await act(async () => { await result.current.prepare(); });
    const id = startedJobId();
    await act(async () => { await result.current.cancel(); });
    expect(h.calls).toContainEqual({ cmd: "cancel_job", args: { jobId: id } });
  });

  it("cancels nothing when nothing is running", async () => {
    const { result } = await mount();
    await act(async () => { await result.current.cancel(); });
    expect(h.calls.some((c) => c.cmd === "cancel_job")).toBe(false);
  });

  it("reports a spawn that never started, and stays restartable", async () => {
    h.failInvoke = "prepare_diarizer_models";
    const { result } = await mount();
    await act(async () => { await result.current.prepare(); });
    expect(result.current.state).toBe("error");
    expect(result.current.error).toContain("spawn refused");

    // The job id must have been released, or the button is dead forever.
    h.failInvoke = null;
    await act(async () => { await result.current.prepare(); });
    expect(result.current.state).toBe("running");
  });

  it("stays restartable when the spawn fails TWICE in a row", async () => {
    // The case that makes the explicit id-release in the catch load-bearing.
    // On the second failure both setState calls batch into the state the hook
    // is already in ("error"), so React commits nothing and the settle effect
    // - which is keyed on state - never re-runs. If the catch did not release
    // the id itself, it would stay set and every later press would be refused:
    // a button that is permanently dead after two failures, with no visible
    // reason. Break-tested by deleting that line.
    h.failInvoke = "prepare_diarizer_models";
    const { result } = await mount();
    await act(async () => { await result.current.prepare(); });
    await act(async () => { await result.current.prepare(); });
    expect(result.current.state).toBe("error");

    h.failInvoke = null;
    await act(async () => { await result.current.prepare(); });
    expect(result.current.state, "the third press was refused - the job id leaked").toBe("running");
  });

  it("drops both listeners on unmount", async () => {
    const { unmount } = await mount();
    unmount();
    await waitFor(() => expect(h.unlistened).toContain("diarize-prepare-done"));
    expect(h.unlistened).toContain("diarize-prepare-progress");
  });
});
