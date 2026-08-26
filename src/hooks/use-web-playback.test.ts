// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useWebPlayback, shouldRetryWithoutCookies } from "./use-web-playback";

/**
 * The WIRING, which is the half that had no tests.
 *
 * `lib/web-playback-machine.test.ts` covers the pure transitions with twenty
 * cases, and it cannot see any of what is here: three Tauri handlers, a
 * job-id filter that lets this hook share `playback-prep-*` with App's local
 * prep listeners, and a promise the download attempt awaits. A reducer test
 * passes whether or not those are connected.
 *
 * The job-id filter is the reason both can coexist on one channel: App's
 * listeners gate on the local prep job, these gate on the download job, and
 * each ignores the other's traffic. Remove the gate and a local transcode's
 * progress drives the web download's bar.
 */

const h = vi.hoisted(() => ({
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
  unlistened: 0,
  invoked: [] as Array<{ cmd: string; args: unknown }>,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    h.handlers.set(name, cb);
    return () => { h.unlistened += 1; };
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: unknown) => {
    h.invoked.push({ cmd, args });
    if (cmd === "get_stream_proxy_base") return "http://127.0.0.1:1234/t/tok";
    if (cmd === "get_direct_stream_url") throw new Error("no stream");
    return null;   // download_web_preview settles via playback-prep-done
  },
}));

/** Every member of Helpers. A partial stub throws inside an effect and the
 *  failure surfaces as an unrelated assertion three tests later. */
const helpers = () => ({
  appendLog: vi.fn(),
  pushNotification: vi.fn(),
  maybePromptYtAuth: vi.fn(),
  cookiesBrowser: () => undefined,
  previewMaxHeight: 720,
  getPlayheadSeconds: () => 0,
});

const fire = (n: string, payload: unknown) => h.handlers.get(n)?.({ payload });

beforeEach(() => { h.handlers.clear(); h.unlistened = 0; h.invoked.length = 0; });
afterEach(() => vi.clearAllMocks());

describe("the download listeners", () => {
  it("subscribes to all three prep channels and releases them", async () => {
    const { unmount } = renderHook(() => useWebPlayback(helpers()));
    await waitFor(() => expect(h.handlers.size).toBe(3));
    expect([...h.handlers.keys()].sort()).toEqual([
      "playback-prep-done", "playback-prep-log", "playback-prep-progress",
    ]);
    unmount();
    await waitFor(() => expect(h.unlistened).toBe(3));
  });

  it("ignores prep traffic that belongs to App's local-file jobs", async () => {
    // Both hooks listen to these three channels. The gate is what stops a
    // local transcode driving the web download's progress bar.
    const hp = helpers();
    const { result } = renderHook(() => useWebPlayback(hp));
    await waitFor(() => expect(h.handlers.size).toBe(3));

    fire("playback-prep-progress", { job_id: "app-local-prep", percent: 55 });
    fire("playback-prep-log", { job_id: "app-local-prep", tag: "info", line: "not ours" });

    expect(result.current.downloadProgress).toBe(0);
    expect(hp.appendLog).not.toHaveBeenCalled();
  });
});

describe("driving a real download", () => {
  async function startDownload() {
    const hp = helpers();
    const r = renderHook(() => useWebPlayback(hp));
    await waitFor(() => expect(h.handlers.size).toBe(3));
    act(() => { r.result.current.loadWeb("https://y.tld/1", "download-first", 1); });
    await waitFor(() => expect(r.result.current.downloadJobId).toBeTruthy());
    return { hp, ...r };
  }

  it("reports progress for OUR job", async () => {
    const { result } = await startDownload();
    const job = result.current.downloadJobId!;
    act(() => { fire("playback-prep-progress", { job_id: job, percent: 42 }); });
    await waitFor(() => expect(result.current.downloadProgress).toBe(42));
  });

  it("routes our log lines to the web-preview channel", async () => {
    const { hp, result } = await startDownload();
    const job = result.current.downloadJobId!;
    act(() => { fire("playback-prep-log", { job_id: job, tag: "info", line: "[download] 10%" }); });
    expect(hp.appendLog).toHaveBeenCalledWith("info", "web-preview", "[download] 10%");
  });

  it("settles the attempt on done, landing the cache path", async () => {
    // `download_web_preview` resolves immediately; the REAL completion arrives
    // on this event, and the attempt promise is what the state machine awaits.
    const { result } = await startDownload();
    const job = result.current.downloadJobId!;
    act(() => { fire("playback-prep-done", { job_id: job, success: true, path: "/cache/a.mp4" }); });
    await waitFor(() => expect(result.current.cachePath).toBe("/cache/a.mp4"));
  });

  it("does NOT land a cache path when the download fails", async () => {
    // The attempt promise must REJECT on failure. Resolving instead hands the
    // machine an error string where a path belongs, and the player is pointed
    // at it — a break-test caught this having no coverage at all: swapping
    // reject for resolve left every other test in this file green.
    const { result } = await startDownload();
    const job = result.current.downloadJobId!;
    act(() => { fire("playback-prep-done", { job_id: job, success: false, error: "yt-dlp died" }); });
    await waitFor(() => expect(result.current.downloading).toBe(false));
    expect(result.current.cachePath).toBeNull();
  });

  it("still ignores a foreign job while ours is in flight", async () => {
    const { result } = await startDownload();
    act(() => { fire("playback-prep-progress", { job_id: "somebody-else", percent: 99 }); });
    expect(result.current.downloadProgress).not.toBe(99);
  });
});

describe("shouldRetryWithoutCookies", () => {
  /**
   * The retry is expensive: it re-downloads the whole source. It fired on any
   * error that was not a cancellation, so a bug in the app's own file lookup
   * ("yt-dlp exited cleanly but no file was found in cache") was read as an
   * auth problem and cost a second 119 MB + 89 MB fetch before failing
   * identically.
   */
  it("does not retry when yt-dlp exited cleanly — the download worked", () => {
    expect(shouldRetryWithoutCookies(
      "yt-dlp exited cleanly but no file was found in cache", true)).toBe(false);
    expect(shouldRetryWithoutCookies(
      "yt-dlp exited cleanly but no audio file was found in cache", true)).toBe(false);
  });

  it("still retries a genuine failure, which is what the retry is for", () => {
    // Public social posts break BECAUSE the cookies are attached.
    expect(shouldRetryWithoutCookies("download failed (yt-dlp exit Some(1))", true)).toBe(true);
    expect(shouldRetryWithoutCookies("HTTP Error 403: Forbidden", true)).toBe(true);
  });

  it("never retries when no cookies were sent — there is nothing to drop", () => {
    expect(shouldRetryWithoutCookies("download failed (yt-dlp exit Some(1))", false)).toBe(false);
  });

  it("treats cancellation and a source switch as the user, not a failure", () => {
    expect(shouldRetryWithoutCookies("Cancelled", true)).toBe(false);
    expect(shouldRetryWithoutCookies("Source changed", true)).toBe(false);
  });
});
