// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { usePlaybackPrepListeners } from "./use-playback-prep-listeners";

/**
 * The transcode-for-playback promise, and the one channel with no job filter.
 *
 * `playback-prep-done` settles a promise the caller is awaiting for a PATH, so
 * a failure has to reject rather than resolve with nothing — a resolve on
 * failure hands the player an undefined source and the symptom lands somewhere
 * else entirely.
 *
 * `llm-log` is deliberately unfiltered: the other three channels are per-run,
 * while llama-server is one long-lived process that always reports as
 * "llm-server". A job filter there would silence it, which is exactly the
 * state it shipped in — emitted by Rust with nothing listening.
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

const JOB = "prep-1";

function deps() {
  return {
    appendLog: vi.fn(),
    setPlaybackPrepProgress: vi.fn(),
    playbackPrepJobIdRef: { current: JOB as string | null },
    playbackPrepResolverRef: { current: null as null | { resolve: (p: string) => void; reject: (e: unknown) => void } },
  } as unknown as Parameters<typeof usePlaybackPrepListeners>[0];
}

async function mount() {
  const d = deps();
  const r = renderHook(() => usePlaybackPrepListeners(d));
  await waitFor(() => expect(h.handlers.has("playback-prep-done")).toBe(true));
  return { d, ...r };
}
const fire = (n: string, payload: unknown) => h.handlers.get(n)!({ payload });

beforeEach(() => { h.handlers.clear(); h.unlistened = 0; });
afterEach(() => vi.clearAllMocks());

describe("subscription", () => {
  it("registers all four channels and cleans them up", async () => {
    const { unmount } = await mount();
    expect([...h.handlers.keys()].sort()).toEqual([
      "llm-log", "playback-prep-done", "playback-prep-log", "playback-prep-progress",
    ]);
    unmount();
    await waitFor(() => expect(h.unlistened).toBe(4));
  });
});

describe("playback-prep-done settles the caller's promise", () => {
  it("resolves with the transcoded path on success", async () => {
    const { d } = await mount();
    const resolve = vi.fn(), reject = vi.fn();
    d.playbackPrepResolverRef.current = { resolve, reject };
    fire("playback-prep-done", { job_id: JOB, success: true, path: "/tmp/prepped.mp4" });
    expect(resolve).toHaveBeenCalledWith("/tmp/prepped.mp4");
    expect(reject).not.toHaveBeenCalled();
  });

  it("REJECTS on failure rather than resolving with nothing", async () => {
    // The distinction that matters: the caller awaits a path. Resolving here
    // hands the player an undefined source and the failure surfaces somewhere
    // unrelated, long after the transcode that actually broke.
    const { d } = await mount();
    const resolve = vi.fn(), reject = vi.fn();
    d.playbackPrepResolverRef.current = { resolve, reject };
    fire("playback-prep-done", { job_id: JOB, success: false, error: "ffmpeg died" });
    expect(reject).toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("ignores a done event for a different job", async () => {
    const { d } = await mount();
    const resolve = vi.fn(), reject = vi.fn();
    d.playbackPrepResolverRef.current = { resolve, reject };
    fire("playback-prep-done", { job_id: "other", success: true, path: "/x.mp4" });
    expect(resolve).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
  });
});

describe("progress", () => {
  it("reports its own job's percent", async () => {
    const { d } = await mount();
    fire("playback-prep-progress", { job_id: JOB, percent: 42 });
    expect(d.setPlaybackPrepProgress).toHaveBeenCalledWith(42);
  });

  it("ignores another job's percent", async () => {
    const { d } = await mount();
    fire("playback-prep-progress", { job_id: "other", percent: 99 });
    expect(d.setPlaybackPrepProgress).not.toHaveBeenCalled();
  });
});

describe("llm-log", () => {
  it("is NOT job-filtered, because the server is not a run", async () => {
    // llama-server always reports as "llm-server". Filtering on the prep job
    // id would drop every line, which is the silence this listener was added
    // to end.
    const { d } = await mount();
    fire("llm-log", { job_id: "llm-server", tag: "info", line: "loading model" });
    expect(d.appendLog).toHaveBeenCalledWith("info", "llm", "loading model");
  });
});
