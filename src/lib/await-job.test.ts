import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** One registered listener, so a test can emit into it. */
let handlers: Array<(e: { payload: unknown }) => void> = [];
let unlistened = 0;
/** Resolves the `listen()` call, so a test can control the registration race. */
let holdRegistration: (() => void) | null = null;

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, cb: (e: { payload: unknown }) => void) => {
    if (holdRegistration) await new Promise<void>((r) => { holdRegistration = r as () => void; });
    handlers.push(cb);
    return () => { unlistened += 1; handlers = handlers.filter((h) => h !== cb); };
  }),
}));

const emit = (payload: Record<string, unknown>) => {
  for (const h of [...handlers]) h({ payload });
};

beforeEach(() => { handlers = []; unlistened = 0; holdRegistration = null; });
afterEach(() => vi.restoreAllMocks());

async function watch(id: string) {
  const { watchJob } = await import("./await-job");
  return watchJob(id);
}

describe("watchJob", () => {
  it("resolves when its own job reports success", async () => {
    const w = await watch("job-1");
    emit({ job_id: "job-1", success: true, code: 0, path: "/out/a.srt", error: null });
    await expect(w.finished).resolves.toBeUndefined();
  });

  it("rejects with the backend's message on failure", async () => {
    const w = await watch("job-1");
    emit({ job_id: "job-1", success: false, code: 1, path: null, error: "unsupported codec" });
    await expect(w.finished).rejects.toThrow("unsupported codec");
  });

  it("settles on cancellation, which arrives as a failed done", async () => {
    // Otherwise pressing Stop leaves the batch loop awaiting forever.
    const w = await watch("job-1");
    emit({ job_id: "job-1", success: false, code: null, path: null, error: "Cancelled" });
    await expect(w.finished).rejects.toThrow("Cancelled");
  });

  it("ignores another job's completion", async () => {
    // The batch runs jobs in sequence and App has its own long-lived listener;
    // matching the wrong id would mark a file done that never ran.
    const w = await watch("mine");
    let settled = false;
    void w.finished.then(() => { settled = true; }, () => { settled = true; });
    emit({ job_id: "someone-else", success: true, code: 0, path: "/x", error: null });
    await Promise.resolve();
    expect(settled).toBe(false);
    emit({ job_id: "mine", success: true, code: 0, path: "/y", error: null });
    await expect(w.finished).resolves.toBeUndefined();
  });

  it("detaches its listener once settled", async () => {
    const w = await watch("job-1");
    emit({ job_id: "job-1", success: true, code: 0, path: null, error: null });
    await w.finished;
    expect(unlistened).toBe(1);
    expect(handlers).toHaveLength(0);
  });

  it("is listening before it returns, so a fast job cannot be missed", async () => {
    // The mount race: events are dropped, not queued, for a listener that is
    // not attached yet. A file that fails instantly on a bad codec emits its
    // done immediately, and a caller that registered afterwards waits forever.
    const w = await watch("job-1");
    expect(handlers, "watchJob returned before its listener was live").toHaveLength(1);
    emit({ job_id: "job-1", success: true, code: 0, path: null, error: null });
    await expect(w.finished).resolves.toBeUndefined();
  });

  it("stop() detaches and is safe twice", async () => {
    const w = await watch("job-1");
    w.stop();
    w.stop();
    expect(unlistened).toBe(1);
  });
});
