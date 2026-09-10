// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { presentationRefreshDelayMs, proxyPresentationSource, useWebPlayback } from "./use-web-playback";

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
  resolveSource: null as null | (() => Promise<unknown>),
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
    if (cmd === "resolve_presentation_source") return h.resolveSource?.() ?? null;
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

beforeEach(() => { h.handlers.clear(); h.unlistened = 0; h.invoked.length = 0; h.resolveSource = null; });
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

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

  it("defers optional resolution until the review copy finishes", async () => {
    const { result } = await startDownload();
    expect(result.current.downloading).toBe(true);
    expect(h.invoked.some((call) => call.cmd === "resolve_presentation_source")).toBe(false);
    const job = result.current.downloadJobId!;
    act(() => { fire("playback-prep-done", { job_id: job, success: true, path: "/cache/a.mp4" }); });
    await waitFor(() => expect(result.current.cachePath).toBe("/cache/a.mp4"));
    expect(h.invoked.some((call) => call.cmd === "resolve_presentation_source")).toBe(true);
  });

  it("cancels an unfinished review-copy download when metadata identifies an active live source", async () => {
    const { result } = await startDownload();
    act(() => { result.current.promoteLive("https://y.tld/1", 1); });
    await waitFor(() => expect(h.invoked.some((call) => call.cmd === "cancel_job")).toBe(true));
    expect(h.invoked.some((call) => call.cmd === "get_direct_stream_url")).toBe(true);
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

describe("independent presentation representation", () => {
  const base = "http://127.0.0.1:1234/t/token";

  it("retains the working source while an expiry refresh is pending or fails", async () => {
    vi.useFakeTimers();
    const hp = helpers();
    const source = { kind: "progressive", videoUrl: "https://cdn.example/video", expiresAt: Date.now() / 1000 + 61,
      width: 1920, height: 1080, videoCodec: "avc1", audioCodec: "mp4a" };
    let reject!: (error: Error) => void;
    h.resolveSource = vi.fn().mockResolvedValueOnce(source).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const { result, unmount } = renderHook(() => useWebPlayback(hp));
    await act(async () => { result.current.loadCached("https://y.tld/1", "/cache/review.mp4", 1); });
    const original = result.current.presentationSource;
    expect(original).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(result.current.presentationSource).toBe(original);
    await act(async () => { reject(new Error("expired https://cdn.example/?secret=private")); });
    expect(result.current.presentationSource).toBe(original);
    expect(JSON.stringify(hp.appendLog.mock.calls)).not.toContain("secret=");
    unmount();
  });

  it("rejects a late resolution after another source or unmount", async () => {
    let resolve!: (source: unknown) => void;
    h.resolveSource = () => new Promise((done) => { resolve = done; });
    const hp = helpers(); const { result, unmount } = renderHook(() => useWebPlayback(hp));
    await act(async () => { result.current.loadCached("https://y.tld/old", "/cache/old.mp4", 1); });
    act(() => { result.current.loadWeb("https://y.tld/live", "stream-first", 1); });
    await act(async () => { resolve({ kind: "progressive", videoUrl: "https://cdn.example/old", expiresAt: 99 }); });
    expect(result.current.presentationSource).toBeNull();
    await act(async () => { result.current.loadCached("https://y.tld/next", "/cache/next.mp4", 2); });
    unmount();
    await act(async () => { resolve({ kind: "progressive", videoUrl: "https://cdn.example/next", expiresAt: 99 }); });
    expect(hp.appendLog.mock.calls.some((call) => String(call[2]).startsWith("High-quality source resolved"))).toBe(false);
  });

  it("routes HLS through the manifest rewriter", () => {
    const source = proxyPresentationSource({
      kind: "hls", manifestUrl: "https://cdn.example/master.m3u8", expiresAt: 99,
      width: 1920, height: 1080, videoCodec: "avc1", audioCodec: "mp4a",
    }, base);
    expect(source.kind).toBe("hls");
    if (source.kind === "hls") expect(source.manifestUrl).toContain("/hls/v1/");
  });

  it("proxies split video but preserves the separately signed audio URL", () => {
    const audioUrl = "https://audio.example/a.m4a?sig=1";
    const source = proxyPresentationSource({
      kind: "split", videoUrl: "https://video.example/v.mp4?sig=2", audioUrl, expiresAt: 99,
      width: 3840, height: 2160, videoCodec: "avc1", audioCodec: "mp4a",
    }, base);
    expect(source.kind).toBe("split");
    if (source.kind === "split") {
      expect(source.videoUrl).toContain("/v1/");
      expect(source.audioUrl).toBe(audioUrl);
    }
  });

  it("refreshes signed sources before expiry without creating a zero-delay loop", () => {
    const now = 1_800_000_000_000;
    expect(presentationRefreshDelayMs(1_800_000_120, now)).toBe(60_000);
    expect(presentationRefreshDelayMs(1_799_999_999, now)).toBe(1_000);
  });
});
