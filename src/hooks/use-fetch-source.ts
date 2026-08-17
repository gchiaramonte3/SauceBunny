import { useCallback, type Dispatch, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  AppStatus, ClientLog, ExportOpts, Metadata, QueuedClip, SourceKind, WarmStart,
} from "../types";
import type { StatefulPhase } from "../lib/stateful-phase";
import type { CachedStream } from "../bindings/CachedStream";
import type { RecentSource } from "../lib/recent-sources";
import type { Defaults } from "../components/SettingsModal";
import type { ToastKind } from "../components/CanvasToast";
import { formatError } from "../lib/error-format";
import { setPlayheadFrames as publishPlayheadFrames } from "../lib/playhead-store";
import { hostnameOf, isLikelyVideoUrl, normalizeUrl, youTubeThumbnailUrl } from "../lib/validation";

/** Enumerated by tsc from the moved block. Every type is the one the value
 *  still has at its declaration in App.tsx, read rather than remembered. */
export type FetchSourceProps = {
  url: string;
  defaults: Defaults;
  fallbackFps: number;

  // Per-load identity + guards
  sourceSeqRef: { current: number };
  activeSourceUrlRef: { current: string | null };
  metadataRef: { current: Metadata | null };

  // Source state this path writes
  setMetadata: Dispatch<SetStateAction<Metadata | null>>;
  setMetadataLoading: Dispatch<SetStateAction<boolean>>;
  setActiveSourceUrl: Dispatch<SetStateAction<string | null>>;
  setSourceKind: Dispatch<SetStateAction<SourceKind>>;
  setStatus: Dispatch<SetStateAction<AppStatus>>;
  setFetchPhase: Dispatch<SetStateAction<StatefulPhase>>;
  setErrorDetail: Dispatch<SetStateAction<string | null>>;
  setExportOpts: Dispatch<SetStateAction<ExportOpts>>;
  setInFrames: Dispatch<SetStateAction<number | null>>;
  setOutFrames: Dispatch<SetStateAction<number | null>>;
  setClipQueue: Dispatch<SetStateAction<QueuedClip[]>>;

  // Collaborators, all defined before this hook runs in App
  resetForNewSource: (sourceKey: string) => void;
  tryAutoLoadTranscript: (
    input: { sourcePath?: string | null; sourceUrl?: string | null }, seq: number,
  ) => Promise<void>;
  recordRecentSource: (entry: {
    kind: RecentSource["kind"]; value: string; title: string; durationSeconds?: number;
  }) => void;
  seedFilename: (prevName: string, title: string) => string;
  decodeMetaTitle: <T extends { title: string }>(m: T) => T;
  loadWebPlayback: (
    url: string, mode: "stream-first" | "download-first", seq: number,
    warmStream?: CachedStream | null,
  ) => void;
  loadCachedWebPlayback: (url: string, cachePath: string, seq: number) => void;

  // Shell affordances
  appendLog: (tag: ClientLog["tag"], source: string, message: string) => void;
  pushNotification: (kind: ToastKind, title: string, body: string, path?: string) => void;
  maybePromptYtAuth: (msg: string, seq: number) => void;
  classifyExtractorRot: (msg: string) => void;
  cookiesBrowserOrNone: () => string | undefined;
};


/**
 * The web-source load path: URL in, metadata + player + transcript out.
 *
 * Lifted from App.tsx verbatim (r157), the single largest handler in the file.
 * It owns the whole sequence a URL goes through - cache warm path, yt-dlp
 * metadata, the entity decode at the boundary, playback selection, filename
 * seeding, recents, and the transcript auto-load - and nothing else calls into
 * the middle of it.
 *
 * Its sibling `loadLocalPath` (the local-file path) deliberately did NOT move
 * with it. `handleFetch` is used by the extractor-rot retry effect declared just
 * below it, so it has to exist before that point; `loadLocalPath` depends on
 * `runPlaybackPrep` and `openSourceView`, which are declared after it. One hook
 * cannot satisfy both without reordering declarations, and App.tsx's ordering is
 * already load-bearing - the comment above `sessionRoomRef` records another
 * instance of the same constraint. Two paths, two seams.
 */
export function useFetchSource(p: FetchSourceProps) {
  // Destructured so the block below is byte-identical to App.tsx.
  const {
    url,
    defaults,
    fallbackFps,
    sourceSeqRef,
    activeSourceUrlRef,
    metadataRef,
    setMetadata,
    setMetadataLoading,
    setActiveSourceUrl,
    setSourceKind,
    setStatus,
    setFetchPhase,
    setErrorDetail,
    setExportOpts,
    setInFrames,
    setOutFrames,
    setClipQueue,
    resetForNewSource,
    tryAutoLoadTranscript,
    recordRecentSource,
    seedFilename,
    decodeMetaTitle,
    loadWebPlayback,
    loadCachedWebPlayback,
    appendLog,
    pushNotification,
    maybePromptYtAuth,
    classifyExtractorRot,
    cookiesBrowserOrNone,
  } = p;

  const handleFetch = useCallback(async (urlOverride?: string) => {
    // `urlOverride` lets callers (e.g. paste-and-fetch) pass the URL directly
    // instead of relying on the `url` state having committed — avoids the
    // race where a freshly-pasted URL hasn't landed in state yet.
    // Empty URL bar → do nothing. Without this, ⌘Enter (which the raw key
    // binding doesn't gate the way the command registry does) would flip status
    // to "error" and kill a currently-loaded source's transport.
    if (!(urlOverride ?? url).trim()) return;
    const full = normalizeUrl(urlOverride ?? url);
    if (!isLikelyVideoUrl(full)) {
      const msg = "Paste a video URL (YouTube, Vimeo, TikTok, Twitter/X, Reddit, Instagram, or any page with embedded video).";
      // A loaded source survives a bad paste: same protection the empty-URL
      // guard above gives, for the same accidental gesture.
      if (metadataRef.current) {
        pushNotification("error", "That doesn't look like a video URL", msg);
      } else {
        setErrorDetail(msg);
        setStatus("error");
        setFetchPhase("error");
      }
      return;
    }
    resetForNewSource(full);
    // Committed source URL for the audio-master cache (keyed off this, not the
    // live `url` input, which can change without a re-fetch). The ref mirror is
    // set synchronously so the cookie reminder can name the host mid-fetch.
    activeSourceUrlRef.current = full;
    setActiveSourceUrl(full);
    // Capture this load's sequence — any await continuation below must
    // re-check the ref before calling setState to avoid clobbering a newer
    // source the user has since started.
    const seq = ++sourceSeqRef.current;

    // ─── Warm-start probe (r112) ─────────────────────────────────────────
    // One local-disk read (no network): cached metadata to hydrate the UI
    // instantly, a still-valid resolved stream URL to skip extraction, and
    // a complete downloaded copy to skip resolve/proxy entirely. Best
    // effort: any failure means a normal cold boot.
    const warm = await invoke<WarmStart>("get_warm_start", {
      url: full,
      maxHeight: defaults.previewMaxHeight,
    }).catch(() => null);
    if (sourceSeqRef.current !== seq) return; // user already moved on

    // ─── Optimistic mount ────────────────────────────────────────────────
    // The Monitor extracts a video ID from `metadata.webpage_url` and mounts
    // the IFrame player as soon as one is present. So instead of blocking on
    // yt-dlp's metadata fetch (which can take 1–3s while it probes manifests),
    // we seed a stub metadata object that's just enough to render the player.
    // The user can hit play and watch immediately; we hydrate width/height/
    // duration/title/thumbnail in the background and reflow when they arrive.
    //
    // Known source (r112): the cached Metadata takes the stub's place — real
    // title, duration, and thumbnail on screen immediately, through the SAME
    // setMetadata path a fresh fetch uses.
    const stub: Metadata = warm?.metadata ?? {
      title: "Loading…",
      duration: null,
      // r62: show the YouTube poster INSTANTLY (derived from the video ID,
      // no network/yt-dlp needed) so the canvas isn't blank during the ~8s
      // stream resolve. Replaced by the real thumbnail once metadata lands.
      thumbnail: youTubeThumbnailUrl(full),
      uploader: null,
      upload_date: null,
      view_count: null,
      webpage_url: full,
      width: null,
      height: null,
      fps: null,
      vcodec: null,
      acodec: null,
      ext: null,
      has_subs: false, chapters: [], description: null,
    };
    setMetadata(stub);
    setSourceKind("youtube");
    setStatus("loaded");
    publishPlayheadFrames(0);
    setInFrames(null);
    setOutFrames(null);
    // resetForNewSource() above clears the panel so the stub window shows no
    // holdover from the previous video. Once real metadata lands below we
    // re-attach any transcript associated with THIS url (matched by webpage_url)
    // — imported or generated — so an associated transcript sticks to its source.
    // Filename is owned by resetForNewSource (cleared unless the user's
    // custom name belongs to THIS source) + the hydrates below (reseeded
    // from the real title) — no competing seed here (review fix: this was
    // the last survivor of the retired prev.filename heuristic).
    setExportOpts((prev) => ({
      ...prev,
      folder: prev.folder ?? defaults.folder,
      format: defaults.format,
      reencode: defaults.reencode,
      captions: defaults.captions,
    }));
    if (warm?.metadata) {
      appendLog("ok", "cache", `Details for ${hostnameOf(full)} loaded from cache`);
      // Mirror the fresh-fetch hydrate: caption availability + a filename
      // suggestion from the real title (user-typed names always win).
      const wm = decodeMetaTitle(warm.metadata);
      setExportOpts((prev) => ({
        ...prev,
        captions: defaults.captions && wm.has_subs,
        filename: seedFilename(prev.filename, wm.title),
      }));
    }
    setMetadataLoading(true);
    // Toolbar Fetch button → loading; the flash resolves on metadata hydrate
    // (success) or the catch below (error). See fetchButtonPhase.
    setFetchPhase("loading");

    // ─── PLAYBACK-FIRST (r59) ────────────────────────────────────────────
    // Resolve the stream URL and point the player at the loopback proxy IN
    // PARALLEL with the metadata probe — keyed off the pasted URL, so we
    // don't wait ~9s for fetch_metadata before even starting the ~9s stream
    // resolve. The player needs only the stream URL; title/dims/duration
    // hydrate separately (and the player reports its own duration via
    // loadedmetadata). This is the single biggest time-to-first-frame win.
    //
    // Playback history (why a proxy at all):
    //   r20 IFrame → r53 dropped (Error 153, YouTube Dec-2025 Referer) →
    //   r54 direct <video src> (failed for YouTube) → r57 custom scheme
    //   (WKWebView never requests custom schemes for media) → r58 loopback
    //   HTTP proxy: WKWebView streams http://127.0.0.1 natively through
    //   WebKit's Range/206 path. The Content-Length framing (not chunked)
    //   was the key — see src-tauri/src/stream_proxy.rs.
    // ─── Web-source playback path (r72 HYBRID; r80 state machine) ──
    // The whole stream → resolve → download-fallback → watchdog → cache
    // lifecycle lives in the `useWebPlayback` state machine now. Here we just
    // kick it off in the user's chosen mode; the hook logs its own progress
    // and exposes a read-model the Monitor consumes (see webPlayback.* below).
    // `streamPreview` ON = stream-first (instant, fall back to download on any
    // failure); OFF = download-first (slower, max reliability on flaky links).
    //
    // Warm boot (r112), strongest fast path first:
    //   1. A COMPLETE downloaded copy on disk → play the file immediately
    //      (LocalMediaPlayer via the machine's `cached` state); no resolve,
    //      no proxy, no yt-dlp. Source identity stays the URL throughout —
    //      recents, history, transcripts, and review docs all key off
    //      `full` / `webpage_url`, never the cache path.
    //   2. A still-valid resolved stream URL → hand it to the proxy/MSE path
    //      and skip extraction (the hook logs "Stream ready from cache").
    //   3. Otherwise: the normal cold resolve/download.
    if (warm?.cached_copy) {
      appendLog("ok", "cache", `Playing the saved copy of ${hostnameOf(full)} from disk`);
      loadCachedWebPlayback(full, warm.cached_copy, seq);
    } else {
      const warmStream = defaults.streamPreview ? warm?.stream ?? null : null;
      if (!warmStream) {
        // The cookie source is stated on EVERY yt-dlp line that can hit a
        // bot-check. Proven necessary: a user hit "Sign in to confirm you're
        // not a bot" with a browser configured, and from the log alone there
        // was no way to tell whether cookies had been sent - the same command
        // run by hand with --cookies-from-browser worked first time. An
        // unfalsifiable report is worth less than one noisy word per fetch.
        const ck = cookiesBrowserOrNone();
        appendLog(
          "info",
          "yt-dlp",
          (defaults.streamPreview
            ? `Resolving stream URL for ${hostnameOf(full)}…`
            : `Downloading ${hostnameOf(full)} for in-app playback…`)
          + (ck ? ` (cookies: ${ck})` : " (no cookies)"),
        );
      }
      loadWebPlayback(full, defaults.streamPreview ? "stream-first" : "download-first", seq, warmStream);
    }

    // ─── Background metadata hydration ───────────────────────────────────
    // Fresh cached metadata (<24h) skips the network probe entirely — the UI
    // is already hydrated from the warm start above. Stale (or missing)
    // cached metadata still shows instantly, then revalidates here in the
    // background through the exact same path a cold fetch uses.
    if (warm?.metadata && !warm.metadata_stale) {
      const wm = warm.metadata;
      setFetchPhase("success");
      setMetadataLoading(false);
      // A warm open is a successful load — record it (URL identity).
      recordRecentSource({
        kind: "url",
        value: full,
        title: wm.title,
        durationSeconds: wm.duration ?? undefined,
      });
      appendLog("ok", "probe", `${wm.width ?? "?"}×${wm.height ?? "?"} · ${wm.fps ?? "?"} fps · ${wm.duration?.toFixed(1) ?? "?"}s · from cache`);
      // Warm opens skip the cold fetch_metadata branch, so re-attach the source's
      // transcript here too (else a re-pasted cached URL loses its transcript).
      void tryAutoLoadTranscript({ sourceUrl: wm.webpage_url ?? full }, seq);
      return;
    }
    // If this fails we leave the player visible (the user is probably already
    // watching) and surface the error via the notification bell instead of
    // tearing the canvas down.
    appendLog("info", "yt-dlp", `Extracting URL: ${full}`);
    try {
      const raw = await invoke<Metadata>("fetch_metadata", {
        url: full,
        cookiesBrowser: cookiesBrowserOrNone(),
      });
      if (sourceSeqRef.current !== seq) return; // user already moved on
      // Decode ONCE here so every downstream consumer - display, the seeded
      // export filename, and the stored recents title - sees the same string.
      const m = decodeMetaTitle(raw);
      setMetadata(m);
      setFetchPhase("success"); // metadata hydrated → success flash
      // Re-attach a transcript previously associated with THIS url (imported or
      // caption/whisper-generated), keyed by the canonical webpage_url — the same
      // key those paths record. Matched to this source only (never a holdover
      // from a different video); resetForNewSource cleared the panel above, so
      // this restores the remembered one. No-op when nothing is associated.
      void tryAutoLoadTranscript({ sourceUrl: m.webpage_url ?? full }, seq);
      // Successful load confirmed → record in recent sources. Title comes
      // from the metadata this fetch already returned (no second request).
      recordRecentSource({
        kind: "url",
        value: full,
        title: m.title,
        durationSeconds: m.duration ?? undefined,
      });
      // Queue items added during the optimistic-stub window captured
      // "Loading…" as their title — re-stamp them with the real title/
      // thumbnail now that metadata has hydrated (recents would otherwise
      // show "Loading…" for clips exported from those items).
      setClipQueue((prev) => prev.map((c) =>
        c.source.kind === "web" && c.source.url === full && c.title === stub.title
          ? { ...c, title: m.title, thumbnail: m.thumbnail ?? c.thumbnail }
          : c
      ));
      setExportOpts((prev) => ({
        ...prev,
        captions: defaults.captions && m.has_subs,
        // Keep the name only if the USER typed it FOR THIS SOURCE — any
        // other source's name (typed or seeded) must not survive onto it.
        filename: seedFilename(prev.filename, m.title),
      }));
      // yt-dlp's authoritative duration may differ slightly from what the
      // IFrame reported (subtle rounding, or the IFrame hadn't measured yet).
      // Re-clamp any marks the user already set so they stay in-range.
      if (m.duration && m.duration > 0) {
        const r = Math.max(1, Math.round(m.fps ?? fallbackFps));
        const maxF = Math.max(0, Math.floor(m.duration * r) - 1);
        setInFrames((prev)  => prev == null ? prev : Math.min(prev, maxF));
        setOutFrames((prev) => prev == null ? prev : Math.min(prev, maxF));
      }
      appendLog("ok", "probe", `${m.width ?? "?"}×${m.height ?? "?"} · ${m.fps ?? "?"} fps · ${m.duration?.toFixed(1) ?? "?"}s`);
      // Playback (stream URL → proxy) was already kicked off in parallel
      // above (r59) — metadata only hydrates title/dims/duration here.
    } catch (err) {
      if (sourceSeqRef.current !== seq) return;
      // formatError unwraps the AppError discriminated union (r51) — raw
      // String(err) on an `{ kind, data }` object produces "[object Object]".
      const msg = formatError(err);
      appendLog("err", "yt-dlp", msg);
      setFetchPhase("error"); // metadata probe failed → error flash
      // Don't blow the canvas away — the direct-stream path is independent
      // of metadata. Just record the error so the sidebar/notification surfaces it.
      setErrorDetail(msg);
      // Stale-extractor signature? Arm the one-click "Update yt-dlp & retry"
      // (rendered by the error overlay once playback also proves dead —
      // see the webPlayback `failed` escalation effect).
      classifyExtractorRot(msg);
      pushNotification("error", "Metadata fetch failed",
        "The player is still active, but export quality options may be limited until metadata loads.");
      maybePromptYtAuth(msg, seq);
    } finally {
      if (sourceSeqRef.current === seq) setMetadataLoading(false);
    }
  }, [url, appendLog, defaults, fallbackFps, resetForNewSource, pushNotification, maybePromptYtAuth, classifyExtractorRot, loadWebPlayback, loadCachedWebPlayback, recordRecentSource,
      seedFilename, tryAutoLoadTranscript, cookiesBrowserOrNone, decodeMetaTitle, activeSourceUrlRef, metadataRef, setActiveSourceUrl, setClipQueue, setErrorDetail, setExportOpts, setFetchPhase, setInFrames, setMetadata, setMetadataLoading, setOutFrames, setSourceKind, setStatus, sourceSeqRef]);

  return { handleFetch };
}
