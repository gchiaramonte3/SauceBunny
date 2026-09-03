import { describe, it, expect } from "vitest";
import {
  webPlaybackReducer,
  INITIAL_WEB_PLAYBACK,
  type WebPlaybackState,
  type WebPlaybackAction,
  type StreamInfo,
} from "./web-playback-machine";

const URL = "https://www.youtube.com/watch?v=abc123";

const stream = (tag: string): StreamInfo => ({
  url: `http://127.0.0.1:5555/v1/${tag}`,
  audioUrl: null,
  videoCodec: "avc1.42001E",
  audioCodec: "mp4a.40.2",
});

function run(actions: WebPlaybackAction[], from: WebPlaybackState = INITIAL_WEB_PLAYBACK): WebPlaybackState {
  return actions.reduce(webPlaybackReducer, from);
}

describe("web-playback machine: core lifecycle", () => {
  it("LOAD stream-first enters resolving (not a fresh retry)", () => {
    const s = run([{ t: "LOAD", seq: 1, url: URL, mode: "stream-first" }]);
    expect(s).toEqual({ kind: "resolving", seq: 1, url: URL, fresh: false, resumeAtSeconds: 0 });
  });

  it("LOAD download-first enters downloading directly", () => {
    const s = run([{ t: "LOAD", seq: 1, url: URL, mode: "download-first" }]);
    expect(s.kind).toBe("downloading");
  });

  it("resolve failure falls back to download", () => {
    const s = run([
      { t: "LOAD", seq: 1, url: URL, mode: "stream-first" },
      { t: "RESOLVE_FAILED", seq: 1 },
    ]);
    expect(s.kind).toBe("downloading");
  });

  it("stale-seq actions are dropped", () => {
    const s = run([
      { t: "LOAD", seq: 2, url: URL, mode: "stream-first" },
      { t: "RESOLVED", seq: 1, stream: stream("old"), fromCache: false },
    ]);
    expect(s.kind).toBe("resolving");
  });

  it("a fresh stream's media error goes to the download fallback", () => {
    const s = run([
      { t: "LOAD", seq: 1, url: URL, mode: "stream-first" },
      { t: "RESOLVED", seq: 1, stream: stream("fresh"), fromCache: false },
      { t: "MEDIA_ERROR", seq: 1, atSeconds: 42 },
    ]);
    expect(s.kind).toBe("downloading");
  });

  it("downloading ignores MEDIA_ERROR/WATCHDOG (no double-download race)", () => {
    const base = run([
      { t: "LOAD", seq: 1, url: URL, mode: "stream-first" },
      { t: "RESOLVED", seq: 1, stream: stream("fresh"), fromCache: false },
      { t: "MEDIA_ERROR", seq: 1, atSeconds: 42 },
      { t: "DOWNLOAD_STARTED", seq: 1, jobId: "job-1" },
    ]);
    const s = run([{ t: "WATCHDOG", seq: 1, atSeconds: 42 }, { t: "MEDIA_ERROR", seq: 1, atSeconds: 42 }], base);
    expect(s).toEqual(base);
  });
});

describe("web-playback machine: warm boot (r112)", () => {
  it("LOAD_CACHED boots straight to cached playback", () => {
    const s = run([{ t: "LOAD_CACHED", seq: 1, url: URL, cachePath: "/cache/saucebunny-media/downloads/x.mp4" }]);
    expect(s).toEqual({
      kind: "cached",
      seq: 1,
      url: URL,
      cachePath: "/cache/saucebunny-media/downloads/x.mp4",
      resumeAtSeconds: 0,
    });
  });

  it("a cached stream URL's media error retries with ONE fresh resolve, not download", () => {
    const s = run([
      { t: "LOAD", seq: 1, url: URL, mode: "stream-first" },
      { t: "RESOLVED", seq: 1, stream: stream("warm"), fromCache: true },
      { t: "MEDIA_ERROR", seq: 1, atSeconds: 42 },
    ]);
    // The retry must go back through resolving with the cache bypassed,
    // CARRYING the death position (review fix).
    expect(s).toEqual({ kind: "resolving", seq: 1, url: URL, fresh: true, resumeAtSeconds: 42 });
  });

  it("the watchdog on a cached stream also retries with a fresh resolve", () => {
    const s = run([
      { t: "LOAD", seq: 1, url: URL, mode: "stream-first" },
      { t: "RESOLVED", seq: 1, stream: stream("warm"), fromCache: true },
      { t: "WATCHDOG", seq: 1, atSeconds: 42 },
    ]);
    expect(s).toEqual({ kind: "resolving", seq: 1, url: URL, fresh: true, resumeAtSeconds: 42 });
  });

  it("full chain: cached stream fails, fresh stream fails, THEN download (retry cannot loop)", () => {
    const afterRetry = run([
      { t: "LOAD", seq: 1, url: URL, mode: "stream-first" },
      { t: "RESOLVED", seq: 1, stream: stream("warm"), fromCache: true },
      { t: "MEDIA_ERROR", seq: 1, atSeconds: 42 },
      { t: "RESOLVED", seq: 1, stream: stream("fresh"), fromCache: false },
    ]);
    // The retry lands the fresh URL in the SAME streaming/MSE path — no
    // player swap, so position handling stays whatever it is today (RC4 is
    // tracked separately and deliberately not touched here).
    expect(afterRetry.kind).toBe("streaming");
    if (afterRetry.kind === "streaming") {
      expect(afterRetry.fromCache).toBe(false);
      expect(afterRetry.stream.url).toBe(stream("fresh").url);
    }
    const s = run([{ t: "MEDIA_ERROR", seq: 1, atSeconds: 42 }], afterRetry);
    expect(s.kind).toBe("downloading");
  });

  it("cached-stream failure of a stale seq is dropped", () => {
    const base = run([
      { t: "LOAD", seq: 2, url: URL, mode: "stream-first" },
      { t: "RESOLVED", seq: 2, stream: stream("warm"), fromCache: true },
    ]);
    const s = run([{ t: "MEDIA_ERROR", seq: 1, atSeconds: 42 }], base);
    expect(s).toEqual(base);
  });

  it("PLAYER_READY on a cached stream marks ready and keeps fromCache", () => {
    const s = run([
      { t: "LOAD", seq: 1, url: URL, mode: "stream-first" },
      { t: "RESOLVED", seq: 1, stream: stream("warm"), fromCache: true },
      { t: "PLAYER_READY", seq: 1 },
    ]);
    expect(s).toMatchObject({ kind: "streaming", ready: true, fromCache: true });
  });

  it("RESET tears down a warm-booted cached state", () => {
    const s = run([
      { t: "LOAD_CACHED", seq: 1, url: URL, cachePath: "/cache/x.mp4" },
      { t: "RESET" },
    ]);
    expect(s).toEqual(INITIAL_WEB_PLAYBACK);
  });
});

describe("RC4 position handoff (resumeAtSeconds)", () => {
  it("MEDIA_ERROR carries the playhead into downloading and through to cached", () => {
    let s = webPlaybackReducer(INITIAL_WEB_PLAYBACK, { t: "LOAD", seq: 1, url: "u", mode: "stream-first" });
    s = webPlaybackReducer(s, { t: "RESOLVED", seq: 1, stream: stream("s"), fromCache: false });
    s = webPlaybackReducer(s, { t: "MEDIA_ERROR", seq: 1, atSeconds: 137.5 });
    expect(s.kind).toBe("downloading");
    if (s.kind === "downloading") expect(s.resumeAtSeconds).toBe(137.5);
    s = webPlaybackReducer(s, { t: "DOWNLOAD_DONE", seq: 1, cachePath: "/tmp/x.mp4" });
    expect(s.kind).toBe("cached");
    if (s.kind === "cached") expect(s.resumeAtSeconds).toBe(137.5);
  });

  it("warm-boot LOAD_CACHED starts at 0", () => {
    const s = webPlaybackReducer(INITIAL_WEB_PLAYBACK, { t: "LOAD_CACHED", seq: 2, url: "u", cachePath: "/tmp/y.mp4" });
    expect(s.kind).toBe("cached");
    if (s.kind === "cached") expect(s.resumeAtSeconds).toBe(0);
  });
});

describe("web-playback machine: resume-position handoff (review fix)", () => {
  const toCachedStream: WebPlaybackAction[] = [
    { t: "LOAD", seq: 1, url: URL, mode: "stream-first" },
    { t: "RESOLVED", seq: 1, stream: stream("warm"), fromCache: true },
  ];

  it("cached-stream death carries the position into the fresh retry", () => {
    const s = run([...toCachedStream, { t: "MEDIA_ERROR", seq: 1, atSeconds: 1200 }]);
    expect(s).toEqual({ kind: "resolving", seq: 1, url: URL, fresh: true, resumeAtSeconds: 1200 });
  });

  it("a successful fresh retry starts the new stream at the death position", () => {
    const s = run([
      ...toCachedStream,
      { t: "WATCHDOG", seq: 1, atSeconds: 987 },
      { t: "RESOLVED", seq: 1, stream: stream("fresh"), fromCache: false },
    ]);
    expect(s.kind).toBe("streaming");
    if (s.kind === "streaming") expect(s.resumeAtSeconds).toBe(987);
  });

  it("a failed fresh retry hands the position to the download fallback", () => {
    const s = run([
      ...toCachedStream,
      { t: "MEDIA_ERROR", seq: 1, atSeconds: 1200 },
      { t: "RESOLVE_FAILED", seq: 1 },
      { t: "DOWNLOAD_DONE", seq: 1, cachePath: "/cache/a.mp4" },
    ]);
    expect(s).toEqual({ kind: "cached", seq: 1, url: URL, cachePath: "/cache/a.mp4", resumeAtSeconds: 1200 });
  });

  it("PLAYER_READY consumes the streaming resume so a remount starts clean", () => {
    const s = run([
      ...toCachedStream,
      { t: "MEDIA_ERROR", seq: 1, atSeconds: 1200 },
      { t: "RESOLVED", seq: 1, stream: stream("fresh"), fromCache: false },
      { t: "PLAYER_READY", seq: 1 },
    ]);
    if (s.kind === "streaming") expect(s.resumeAtSeconds).toBe(0);
    expect(s.kind).toBe("streaming");
  });

  it("RESUME_CONSUMED zeroes the cached resume (remounts cannot re-teleport)", () => {
    const s = run([
      { t: "LOAD", seq: 1, url: URL, mode: "download-first" },
      { t: "DOWNLOAD_DONE", seq: 1, cachePath: "/cache/a.mp4" },
      { t: "RESUME_CONSUMED", seq: 1 },
    ]);
    expect(s).toEqual({ kind: "cached", seq: 1, url: URL, cachePath: "/cache/a.mp4", resumeAtSeconds: 0 });
  });
});

describe("a peer stream has nowhere to fall back to", () => {
  // THE BUG: the peer route resolves with fromCache:false, so a dead peer
  // stream took the download edge - handing yt-dlp a `peer://<hash>` display
  // marker it cannot fetch. The download failed on the scheme, the machine
  // landed in `failed`, and NOTHING rendered or reported that state. What the
  // user saw was a stage that had gone black with the duration still showing,
  // which is one of the ways "scrubbing and not seeing the frames" arrived.
  const peerStream = {
    url: "peer://abc123def456",
    audioUrl: null,
    videoCodec: "h264",
    audioCodec: "aac",
  };

  const streaming = () => {
    let s = webPlaybackReducer(INITIAL_WEB_PLAYBACK, { t: "LOAD", seq: 1, url: "peer://abc123def456", mode: "stream-first" });
    return webPlaybackReducer(s, { t: "RESOLVED", seq: 1, stream: peerStream, fromCache: false });
  };

  it("marks a peer stream as one", () => {
    const s = streaming();
    expect(s.kind).toBe("streaming");
    expect(s.kind === "streaming" && s.peer, "a peer stream was not recognised as one").toBe(true);
  });

  it("does NOT hand a peer:// marker to the downloader", () => {
    const s = webPlaybackReducer(streaming(), { t: "MEDIA_ERROR", seq: 1, atSeconds: 42 });
    expect(
      s.kind,
      "a dead peer stream started a yt-dlp download of a peer:// URL, which cannot work",
    ).toBe("failed");
  });

  it("says why, so the state cannot be swallowed into a black screen", () => {
    const s = webPlaybackReducer(streaming(), { t: "WATCHDOG", seq: 1, atSeconds: 42 });
    expect(s.kind).toBe("failed");
    expect(s.kind === "failed" && s.message.length, "failed with no message to show").toBeGreaterThan(20);
  });

  it("leaves a genuine WEB stream's download fallback alone", () => {
    // The fallback exists for a reason and must still fire for real URLs.
    let s = webPlaybackReducer(INITIAL_WEB_PLAYBACK, { t: "LOAD", seq: 2, url: "https://x.test/v", mode: "stream-first" });
    s = webPlaybackReducer(s, {
      t: "RESOLVED", seq: 2, fromCache: false,
      stream: { url: "https://x.test/stream.m3u8", audioUrl: null, videoCodec: "h264", audioCodec: "aac" },
    });
    expect(webPlaybackReducer(s, { t: "MEDIA_ERROR", seq: 2, atSeconds: 5 }).kind).toBe("downloading");
  });
});
