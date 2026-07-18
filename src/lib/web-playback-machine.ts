// Web-source playback state machine (pure — no React, no I/O).
//
// Replaces the boolean/ref soup that used to encode "which web player / what
// phase" across ~7 separate fields in App.tsx (webStreamUrl, webCachePath,
// webPreviewDownloading, webStreamWatchdogRef, webPreviewSeqRef, …). Modelling
// it as one discriminated union makes the impossible states unrepresentable —
// the double-download race, the stale-closure watchdog, and the re-entry bugs
// are eliminated by construction rather than by scattered guards.
//
// Style matches the codebase's `AppError` discriminated union ({ kind, … }).
//
// The lifecycle (web sources only — local files are handled separately):
//
//   inactive ──LOAD(stream-first)──▶ resolving ──RESOLVED──▶ streaming
//      │                                  │                      │
//      ├──LOAD(download-first)─┐          │ RESOLVE_FAILED       │ PLAYER_READY → ready
//      │                       ▼          ▼                      │ MEDIA_ERROR / WATCHDOG
//      │                   downloading ◀──┴──────────────────────┤ (fromCache: false)
//      │                       │ DOWNLOAD_DONE ──▶ cached        │
//      │                       │ DOWNLOAD_FAILED ─▶ failed       │ MEDIA_ERROR / WATCHDOG
//      │                                                         ▼ (fromCache: true)
//      │                                            resolving{fresh:true} ── one retry
//      └──LOAD_CACHED (warm boot, complete copy on disk)──▶ cached
//   (any) ──RESET──▶ inactive
//
// The ONLY edge out of a FRESHLY-resolved `streaming` on failure goes to
// `downloading`, and `downloading` ignores MEDIA_ERROR/WATCHDOG — so a stream
// error and the 15s watchdog can never both start a download. The race is
// gone structurally.
//
// r112 warm boot: a stream may start from a CACHED signed URL (skipping
// yt-dlp). Signed URLs rot (403 after key rotation), so a cached stream's
// failure edge goes back to `resolving` with `fresh: true` — ONE retry with a
// fresh yt-dlp resolve — instead of straight to the download fallback. The
// fresh resolve produces a `fromCache: false` stream, whose failure edge is
// the normal download fallback, so the retry cannot loop.

export type StreamInfo = {
  /** Proxied loopback URL, ready to hand to the player (already through buildProxyUrl). */
  url: string;
  /** RAW DASH audio-track URL (the proxy merges it); null when the video is muxed. */
  audioUrl: string | null;
  /** Codec strings from the resolver, for MSEStreamPlayer's probe-skip fast path. */
  videoCodec: string | null;
  audioCodec: string | null;
};

export type WebPlaybackState =
  | { kind: "inactive" }
  /** `fresh: true` = the retry after a cached stream URL failed — the
   *  resolver must bypass the warm cache and ask yt-dlp for new URLs. */
  | { kind: "resolving"; seq: number; url: string; fresh: boolean }
  /** `fromCache: true` = playing cached signed URLs (warm boot). Its failure
   *  edge is a fresh resolve, not the download fallback. */
  | { kind: "streaming"; seq: number; url: string; stream: StreamInfo; ready: boolean; fromCache: boolean }
  /** resumeAtSeconds: the playhead at the moment the stream died — the
   *  cached player boots there instead of 0 (RC4: a swap must never lose
   *  the position). REQUIRED so every future fallback transition has to
   *  decide the handoff explicitly (compile error, not a regression). */
  | { kind: "downloading"; seq: number; url: string; jobId: string | null; progress: number; resumeAtSeconds: number }
  | { kind: "cached"; seq: number; url: string; cachePath: string; resumeAtSeconds: number }
  | { kind: "failed"; seq: number; url: string; message: string };

export type WebPlaybackAction =
  | { t: "LOAD"; seq: number; url: string; mode: "stream-first" | "download-first" }
  /** Warm boot: a complete downloaded copy exists on disk — skip
   *  resolve/proxy entirely and boot LocalMediaPlayer from the file. */
  | { t: "LOAD_CACHED"; seq: number; url: string; cachePath: string }
  | { t: "RESOLVED"; seq: number; stream: StreamInfo; fromCache: boolean }
  | { t: "RESOLVE_FAILED"; seq: number }
  | { t: "PLAYER_READY"; seq: number }
  | { t: "MEDIA_ERROR"; seq: number; atSeconds: number }
  | { t: "WATCHDOG"; seq: number; atSeconds: number }
  | { t: "DOWNLOAD_STARTED"; seq: number; jobId: string }
  | { t: "DOWNLOAD_PROGRESS"; seq: number; progress: number }
  | { t: "DOWNLOAD_DONE"; seq: number; cachePath: string }
  | { t: "DOWNLOAD_FAILED"; seq: number; message: string }
  | { t: "RESET" };

export const INITIAL_WEB_PLAYBACK: WebPlaybackState = { kind: "inactive" };

/** Current source sequence, or null when inactive. */
export function webPlaybackSeq(s: WebPlaybackState): number | null {
  return s.kind === "inactive" ? null : s.seq;
}

function startDownload(seq: number, url: string, resumeAtSeconds: number): WebPlaybackState {
  return { kind: "downloading", seq, url, jobId: null, progress: 0, resumeAtSeconds };
}

export function webPlaybackReducer(
  state: WebPlaybackState,
  action: WebPlaybackAction,
): WebPlaybackState {
  // RESET, LOAD and LOAD_CACHED are seq-agnostic (they (re)start the lifecycle).
  if (action.t === "RESET") return INITIAL_WEB_PLAYBACK;
  if (action.t === "LOAD") {
    return action.mode === "download-first"
      ? startDownload(action.seq, action.url, 0)
      : { kind: "resolving", seq: action.seq, url: action.url, fresh: false };
  }
  if (action.t === "LOAD_CACHED") {
    // Warm boot from a complete copy: position 0 is correct at load time.
    return { kind: "cached", seq: action.seq, url: action.url, cachePath: action.cachePath, resumeAtSeconds: 0 };
  }

  // Every other action is seq-scoped: silently drop anything that doesn't
  // match the live source. THIS is the single place stale async results die
  // (replacing the scattered sourceSeqRef / webPreviewSeqRef checks).
  if (webPlaybackSeq(state) !== action.seq) return state;

  switch (state.kind) {
    case "resolving":
      if (action.t === "RESOLVED")
        return {
          kind: "streaming",
          seq: state.seq,
          url: state.url,
          stream: action.stream,
          ready: false,
          fromCache: action.fromCache,
        };
      if (action.t === "RESOLVE_FAILED") return startDownload(state.seq, state.url, 0);
      return state;

    case "streaming":
      if (action.t === "PLAYER_READY") return state.ready ? state : { ...state, ready: true };
      if (action.t === "MEDIA_ERROR" || action.t === "WATCHDOG") {
        // A CACHED signed URL died (expired/rotated) — that says nothing
        // about the source itself, so spend one fresh resolve before the
        // download fallback. A fresh stream's failure means the MSE path
        // genuinely can't play this source → download. No player swap
        // happens on the retry edge: the fresh URL lands in the SAME
        // streaming state / MSE path.
        return state.fromCache
          ? { kind: "resolving", seq: state.seq, url: state.url, fresh: true }
          : startDownload(state.seq, state.url, action.atSeconds);
      }
      return state;

    case "downloading":
      if (action.t === "DOWNLOAD_STARTED") return { ...state, jobId: action.jobId };
      if (action.t === "DOWNLOAD_PROGRESS") return { ...state, progress: action.progress };
      if (action.t === "DOWNLOAD_DONE")
        return { kind: "cached", seq: state.seq, url: state.url, cachePath: action.cachePath, resumeAtSeconds: state.resumeAtSeconds };
      if (action.t === "DOWNLOAD_FAILED")
        return { kind: "failed", seq: state.seq, url: state.url, message: action.message };
      return state;

    default:
      return state;
  }
}
