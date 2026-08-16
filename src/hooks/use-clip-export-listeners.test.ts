// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useClipExportListeners } from "./use-clip-export-listeners";

/**
 * One event, two owners.
 *
 * `clip-done` fires for a single export AND for every clip the queue runner
 * drives. When the queue is driving it parks a promise resolver in
 * `queueResolverRef`, and the handler must hand the event straight to it and
 * return — no toast, no recents entry, no status change, because the queue
 * does its own bookkeeping. Get that wrong and nothing throws: every queued
 * clip is simply reported twice, and the export button flashes success in the
 * middle of a run that is still going.
 *
 * That branch was unreachable from a test while this lived inside App.tsx.
 */

const h = vi.hoisted(() => ({
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
  unlistened: 0,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    h.handlers.set(name, cb);
    return () => { h.unlistened += 1; };
  },
}));

const JOB = "clip-1";

function deps() {
  return {
    appendLog: vi.fn(), notify: vi.fn(), pushNotification: vi.fn(), classifyExtractorRot: vi.fn(),
    setStatus: vi.fn(), setExportPhase: vi.fn(), setResultPath: vi.fn(),
    setProgress: vi.fn(), setErrorDetail: vi.fn(), setRecents: vi.fn(),
    jobIdRef: { current: JOB as string | null },
    fpsRef: { current: 24 },
    clipJobMetaRef: { current: { title: "A", thumbnail: null, inTc: "00:00:00:00", outTc: "00:00:10:00" } },
    queueResolverRef: { current: null as null | ((r: unknown) => void) },
  } as unknown as Parameters<typeof useClipExportListeners>[0];
}

async function mount() {
  const d = deps();
  const r = renderHook(() => useClipExportListeners(d));
  await waitFor(() => expect(h.handlers.has("clip-done")).toBe(true));
  return { d, ...r };
}
const fire = (name: string, payload: unknown) => h.handlers.get(name)!({ payload });

beforeEach(() => { h.handlers.clear(); h.unlistened = 0; });
afterEach(() => vi.clearAllMocks());

describe("subscription", () => {
  it("registers all three clip events and cleans them up", async () => {
    const { unmount } = await mount();
    expect([...h.handlers.keys()].sort()).toEqual(["clip-done", "clip-log", "clip-progress"]);
    unmount();
    await waitFor(() => expect(h.unlistened).toBe(3));
  });
});

describe("a queued clip", () => {
  it("goes to the queue runner and does NOT double-report", async () => {
    const { d } = await mount();
    const resolver = vi.fn();
    d.queueResolverRef.current = resolver;
    fire("clip-done", { job_id: JOB, success: true, path: "/out/a.mp4" });

    expect(resolver).toHaveBeenCalledWith({ success: true, path: "/out/a.mp4", error: undefined });
    // None of the single-export bookkeeping may run.
    expect(d.setStatus).not.toHaveBeenCalled();
    expect(d.setExportPhase).not.toHaveBeenCalled();
    expect(d.setRecents).not.toHaveBeenCalled();
    expect(d.pushNotification).not.toHaveBeenCalled();
  });

  it("clears the resolver so the NEXT clip is not routed to a stale one", async () => {
    const { d } = await mount();
    d.queueResolverRef.current = vi.fn();
    fire("clip-done", { job_id: JOB, success: true, path: "/out/a.mp4" });
    expect(d.queueResolverRef.current).toBeNull();
  });

  it("forwards a failure verbatim rather than handling it here", async () => {
    const { d } = await mount();
    const resolver = vi.fn();
    d.queueResolverRef.current = resolver;
    fire("clip-done", { job_id: JOB, success: false, error: "ffmpeg died" });
    expect(resolver).toHaveBeenCalledWith({ success: false, path: undefined, error: "ffmpeg died" });
    expect(d.notify).not.toHaveBeenCalled();
  });
});

describe("a single export", () => {
  it("announces success and records it in recents", async () => {
    const { d } = await mount();
    fire("clip-done", { job_id: JOB, success: true, path: "/out/a.mp4" });
    expect(d.setStatus).toHaveBeenCalledWith("loaded");
    expect(d.setExportPhase).toHaveBeenCalledWith("success");
    expect(d.setResultPath).toHaveBeenCalledWith("/out/a.mp4");
    expect(d.setRecents).toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledWith("Clip exported", "a.mp4");
  });

  it("stays on 'loaded' after a cancel, with no error flash", async () => {
    // A cancelled export must not look like a broken one: the canvas keeps
    // its video and the button goes straight back to idle.
    const { d } = await mount();
    fire("clip-done", { job_id: JOB, success: false, error: "Cancelled" });
    expect(d.setStatus).toHaveBeenCalledWith("loaded");
    expect(d.setExportPhase).toHaveBeenCalledWith("idle");
    expect(d.setErrorDetail).toHaveBeenCalledWith(null);
    expect(d.notify).not.toHaveBeenCalled();
  });

  it("does NOT absorb a crash as a cancel", async () => {
    const { d } = await mount();
    fire("clip-done", { job_id: JOB, success: false, error: "exited with code 1" });
    expect(d.setStatus).toHaveBeenCalledWith("error");
    expect(d.setExportPhase).toHaveBeenCalledWith("error");
  });

  it("shows the rot classifier the RAW text, before the humanizer rewrites it", async () => {
    // The ordering the handler comments call out, and it needs an error the
    // humanizer actually rewrites to be worth asserting. "exited with code 1"
    // passes through untouched, so testing the ordering with THAT proves
    // nothing — swapping the two calls left the first version of this test
    // green. An EACCES spawn failure is rewritten wholesale, so here the two
    // orderings give visibly different arguments.
    const raw = "yt-dlp failed to start: Permission denied (os error 13)";
    const { d } = await mount();
    fire("clip-done", { job_id: JOB, success: false, error: raw });
    expect(d.classifyExtractorRot).toHaveBeenCalledWith(raw);
    // ...and the USER sees the rewritten one.
    expect(d.setErrorDetail).toHaveBeenCalledWith(expect.stringContaining("helper couldn't start"));
  });

  it("ignores an event for a different job", async () => {
    const { d } = await mount();
    fire("clip-done", { job_id: "other", success: true, path: "/out/x.mp4" });
    expect(d.setStatus).not.toHaveBeenCalled();
  });
});

describe("clip-log routing", () => {
  it("labels ffmpeg, yt-dlp and bare stderr lines apart", async () => {
    const { d } = await mount();
    fire("clip-log", { job_id: JOB, tag: "info", line: "[ffmpeg] frame=1", stream: "stdout" });
    fire("clip-log", { job_id: JOB, tag: "info", line: "[download] 50%", stream: "stdout" });
    fire("clip-log", { job_id: JOB, tag: "info", line: "plain text", stream: "stderr" });
    const sources = (d.appendLog as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => c[1]);
    expect(sources).toEqual(["ffmpeg", "yt-dlp", "stderr"]);
  });
});
