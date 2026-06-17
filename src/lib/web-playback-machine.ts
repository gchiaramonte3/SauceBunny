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
//      └──LOAD(download-first)─┐          │ RESOLVE_FAILED       │ PLAYER_READY → ready
//                             ▼           ▼                      │ MEDIA_ERROR / WATCHDOG
//                         downloading ◀───┴──────────────────────┘
//                             │ DOWNLOAD_DONE ──▶ cached
//                             │ DOWNLOAD_FAILED ─▶ failed
//   (any) ──RESET──▶ inactive
//
// The ONLY edge out of `streaming` on failure goes to `downloading`, and
// `downloading` ignores MEDIA_ERROR/WATCHDOG — so a stream error and the 15s
// watchdog can never both start a download. The race is gone structurally.

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
  | { kind: "resolving"; seq: number; url: string }
  | { kind: "streaming"; seq: number; url: string; stream: StreamInfo; ready: boolean }
  | { kind: "downloading"; seq: number; url: string; jobId: string | null; progress: number }
  | { kind: "cached"; seq: number; url: string; cachePath: string }
  | { kind: "failed"; seq: number; url: string; message: string };

export type WebPlaybackAction =
  | { t: "LOAD"; seq: number; url: string; mode: "stream-first" | "download-first" }
  | { t: "RESOLVED"; seq: number; stream: StreamInfo }
  | { t: "RESOLVE_FAILED"; seq: number }
  | { t: "PLAYER_READY"; seq: number }
  | { t: "MEDIA_ERROR"; seq: number }
  | { t: "WATCHDOG"; seq: number }
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

function startDownload(seq: number, url: string): WebPlaybackState {
  return { kind: "downloading", seq, url, jobId: null, progress: 0 };
}

export function webPlaybackReducer(
  state: WebPlaybackState,
  action: WebPlaybackAction,
): WebPlaybackState {
  // RESET and LOAD are seq-agnostic (they (re)start the lifecycle).
  if (action.t === "RESET") return INITIAL_WEB_PLAYBACK;
  if (action.t === "LOAD") {
    return action.mode === "download-first"
      ? startDownload(action.seq, action.url)
      : { kind: "resolving", seq: action.seq, url: action.url };
  }

  // Every other action is seq-scoped: silently drop anything that doesn't
  // match the live source. THIS is the single place stale async results die
  // (replacing the scattered sourceSeqRef / webPreviewSeqRef checks).
  if (webPlaybackSeq(state) !== action.seq) return state;

  switch (state.kind) {
    case "resolving":
      if (action.t === "RESOLVED")
        return { kind: "streaming", seq: state.seq, url: state.url, stream: action.stream, ready: false };
      if (action.t === "RESOLVE_FAILED") return startDownload(state.seq, state.url);
      return state;

    case "streaming":
      if (action.t === "PLAYER_READY") return state.ready ? state : { ...state, ready: true };
      if (action.t === "MEDIA_ERROR" || action.t === "WATCHDOG") return startDownload(state.seq, state.url);
      return state;

    case "downloading":
      if (action.t === "DOWNLOAD_STARTED") return { ...state, jobId: action.jobId };
      if (action.t === "DOWNLOAD_PROGRESS") return { ...state, progress: action.progress };
      if (action.t === "DOWNLOAD_DONE")
        return { kind: "cached", seq: state.seq, url: state.url, cachePath: action.cachePath };
      if (action.t === "DOWNLOAD_FAILED")
        return { kind: "failed", seq: state.seq, url: state.url, message: action.message };
      return state;

    default:
      return state;
  }
}
