import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { Toolbar } from "./components/Toolbar";
import { NavRail } from "./components/NavRail";
import { LibraryView } from "./components/LibraryView";
import { Sidebar } from "./components/Sidebar";
import { ParticipantRail } from "./components/ParticipantRail";
import { CoReviewLobby } from "./components/CoReviewLobby";
import { Monitor, type AspectId } from "./components/Monitor";
import type { Notif } from "./components/NotificationBell";
import type { ToastKind } from "./components/CanvasToast";
import { playSuccess, playError, playInfo } from "./lib/sound";
import { Transport } from "./components/Transport";
import { Timeline } from "./components/Timeline";
import { ViewOptions } from "./components/ViewOptions";
import { LogsPanel } from "./components/LogsPanel";
import { SettingsModal, type Defaults, type CaptionFontKey } from "./components/SettingsModal";
import { YouTubeAuthModal } from "./components/YouTubeAuthModal";
import type { PlayerHandle } from "./components/player-handle";
import type {
  AppError, AppStatus, ClientLog, DoneEvent, ExportOpts,
  LocalFileMeta, LogEvent, Metadata, ProgressEvent, QueuedClip, QueueSource, RecentClip,
  SourceKind, WhisperModel,
} from "./types";
import { asLogTag } from "./types";
import { formatError, isAppError } from "./lib/error-format";
import { fetchButtonPhase, type StatefulPhase } from "./lib/stateful-phase";
import { getPlayheadFrames, setPlayheadFrames as publishPlayheadFrames, playheadFramesToSeconds, subscribePlayhead } from "./lib/playhead-store";
import { usePanelBus } from "./hooks/use-panel-bus";
import { useWebPlayback } from "./hooks/use-web-playback";
import { useCoReview, type ReviewMarkerView, type ReviewAnnotationView } from "./hooks/use-co-review";
import { QueueDrawer } from "./components/QueueDrawer";
import { CommandPalette } from "./components/CommandPalette";
import { ShortcutSheet } from "./components/ShortcutSheet";
import { DropTarget } from "./components/DropTarget";
import { VIDEO_EXTENSIONS, AUDIO_EXTENSIONS, TRANSCRIPT_EXTENSIONS } from "./lib/import-extensions";
import {
  recordTranscript,
  findForSource,
  touchEntry,
  getHistory as getTranscriptHistory,
  type TranscriptHistoryEntry,
} from "./lib/transcript-history";
import {
  deriveOnboardingSteps, onboardingComplete,
  loadOnboardingDismissed, saveOnboardingDismissed,
  type OnboardingStepId,
} from "./lib/onboarding";
import type { Command } from "./lib/commands";
import { buildCommands } from "./lib/commands";
import {
  loadKeybindings, saveKeybindings, buildComboMap, bindingsFor, formatCombo, eventToCombo,
  KEY_ACTION_BY_ID, type KeyActionId, type KeybindingOverrides,
} from "./lib/keybindings";
import { migrateLegacyStorageKeys } from "./lib/migrate-storage";
import { loadActiveTab } from "./lib/tab-state";
import { nextShuttleRate } from "./lib/shuttle";
import { sanitizePlaybackRate, stepPlaybackRate } from "./lib/playback-rate";
import { parseSrt } from "./lib/srt";
import { speakerLanes } from "./lib/speaker-stats";
import { speakerColor } from "./components/transcript/helpers";
import { MediaInfoModal } from "./components/MediaInfoModal";
import { loadReview, commentMarkers as reviewMarkersOf, annotationsOf, reviewFingerprint, resolveByFingerprint, linkFingerprint, upsertReviewHistory, loadReviewer, reviewerColorFor, initialsOf, REVIEW_CHANGED_EVENT, type AnnotationStrokes } from "./lib/review";
import { loadChapters, CHAPTERS_CHANGED_EVENT, type Chapter as ChapterMarker } from "./lib/chapters";
import { appUndo } from "./lib/undo";
import { loadJson, saveJson } from "./lib/storage";
import { loadRecentSources, saveRecentSources, upsertRecent, removeRecent, type RecentSource } from "./lib/recent-sources";
import {
  durationToTc, framesToTc, secondsToTc,
  tcToFrames, tcToSeconds,
} from "./lib/timecode";
import { isLikelyVideoUrl, normalizeUrl, hostnameOf, youTubeThumbnailUrl, isYouTubeBotError, needsCookiesError, looksLikeExtractorRot, prettyHost } from "./lib/validation";
import { sanitizeFilename, stripExt, suggestFilename } from "./lib/filename";
import { EXPECTED_BACKEND_BUILD_ID, type BuildIdCheck } from "./lib/build-id";
import { buildDiagnosticsReport, diagnosticsFilename } from "./lib/diagnostics";
import { extractFrameAsBlob, extractPosterBlob, canMediabunnyDecode } from "./lib/mediabunny-helpers";
import { chosenPosterFor } from "./lib/library";
import { exportLocalClipViaMediabunny } from "./lib/mediabunny-export";
import { extractAudioAsWav16k } from "./lib/mediabunny-audio";

const DEFAULT_FPS_FALLBACK: Record<string, number> = { "24": 24, "25": 25, "30": 30 };

/** Mirrors the Rust `YtdlpStatus` struct returned by `update_ytdlp` (same
 *  local-mirror convention as YouTubeSettings.tsx — the struct predates the
 *  ts-rs bindings and isn't exported through them). */
type YtdlpStatus = { version: string; updated: boolean };

function nowHms(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

/**
 * Detects the classic "stale Rust binary" error from Tauri's invoke handler.
 * Happens when frontend calls a newly-added Rust command but the dev server
 * still has the previous build loaded — cargo check passes but the running
 * process doesn't actually have the command registered.
 */
function isMissingCommandError(err: unknown): boolean {
  // r51 + r53 bug-fix sweep: formatError unwraps both legacy String errors
  // and the new AppError discriminated union, so the regex hits the
  // underlying "Command X not found" message in either world.
  const msg = formatError(err);
  return /Command [\w_]+ not found/i.test(msg);
}
function staleBinaryMessage(commandName: string): string {
  return `${commandName} hasn't been compiled into the running dev server yet. Stop and restart \`npm run tauri dev\` so cargo rebuilds the Rust backend.`;
}

// Map a stored captionFont pref to a current key. Old builds stored
// "sans"/"serif"/"mono"; new builds store named system fonts. Unknown/missing →
// "verdana" (the legibility default). Keeps a pre-existing pref meaningful.
const CAPTION_FONT_KEYS = ["verdana", "helvetica", "arial", "tahoma", "trebuchet", "georgia", "courier", "nunito"];
function migrateCaptionFont(raw: unknown): CaptionFontKey {
  const legacy: Record<string, CaptionFontKey> = { sans: "nunito", serif: "georgia", mono: "courier" };
  if (typeof raw === "string") {
    if (raw in legacy) return legacy[raw];
    if (CAPTION_FONT_KEYS.includes(raw)) return raw as CaptionFontKey;
  }
  return "verdana";
}

/**
 * Top-level views (nav rail): "home" = the Library (folder shelves + recents),
 * "clip" = the entire pre-rail app (toolbar + sidebar + monitor + drawer),
 * "coreview" = the Co-Review lobby (a first-class surface over the same
 * useCoReview session state the toolbar popover reads).
 * A state switch, NOT a router (CLAUDE.md) — and the Clip view is never
 * unmounted, only [hidden], so playback/jobs/listeners survive navigation.
 */
export type AppView = "home" | "clip" | "coreview";

// v2 bump: re-encode default flipped from ON to OFF. Older v1 settings are
// intentionally abandoned so users get the new, much faster default.
const DEFAULTS_KEY  = "cp-defaults-v2";
const RECENTS_KEY   = "cp-recents";
const ASPECT_KEY    = "cp-aspect";
const ACTIVE_VIEW_KEY = "saucebunny.activeView";

// One-shot rebrand migration (clippull.* → saucebunny.*). Runs at module load,
// before App renders so the default-loading useState initializers see the
// migrated keys. Body lives in lib/migrate-storage.ts.
migrateLegacyStorageKeys();


export default function App() {
  // ====== Persisted defaults (used to seed new fetches + Settings tab) ======
  const [defaults, setDefaultsState] = useState<Defaults>(() => {
    const stored = loadJson<Partial<Defaults>>(DEFAULTS_KEY, {});
    return {
      folder: stored.folder ?? null,
      format: stored.format ?? "1080",
      // Default OFF: lossless keyframe-aligned cut is much faster.
      // The user can opt into re-encode per-clip when they need frame accuracy.
      reencode: stored.reencode ?? false,
      captions: stored.captions ?? false,
      timecode: stored.timecode ?? "24",
      whisperModel: stored.whisperModel ?? "small.en",
      // Whisper is the bundled default; Parakeet is opt-in once its model is
      // downloaded (Settings → Transcription). Persisted across sessions.
      transcriptionEngine: stored.transcriptionEngine ?? "whisper",
      // Whisper `-l` language for every transcription/dictation run, plus the
      // preferred yt-dlp caption locale. "auto" = whisper.cpp auto-detect.
      transcriptionLanguage: stored.transcriptionLanguage ?? "auto",
      // AI Summary: default to the recommended small model; the user can
      // download + switch to a larger one in Settings → AI Summary.
      llmSummarizationModel: stored.llmSummarizationModel ?? "qwen3-4b-instruct",
      summaryFormat: stored.summaryFormat ?? "bullets",
      summaryLength: stored.summaryLength ?? "standard",
      // Default ON: mediabunny/WebCodecs is the faster import path. If
      // it ever causes regressions the user can toggle back to the
      // ffmpeg-prep + <video> path via Settings → Local playback.
      useWebCodecsDecoder: stored.useWebCodecsDecoder ?? true,
      // r72: HYBRID is the default — stream instantly to watch + mark in/out,
      // then download ONLY the marked clip on export (no full-video wait on
      // long videos). `streamPreview: true` = stream-first. Turning it OFF
      // (Settings → Web playback) gives the download-first path for max
      // reliability on flaky connections.
      streamPreview: stored.streamPreview ?? true,
      hybridMigrated: stored.hybridMigrated ?? false,
      // Default off — user must pick a browser explicitly because pulling
      // cookies prompts the OS keychain on Chrome/Brave/Edge.
      ytCookiesBrowser: stored.ytCookiesBrowser ?? "none",
      // r71: latches once the first-run "Connect YouTube" prompt is handled.
      ytAuthOnboarded: stored.ytAuthOnboarded ?? false,
      // Default off — diarization adds 10–60s per transcript and the
      // first-run model download is hundreds of MB. Opt-in via Sidebar.
      detectSpeakers: stored.detectSpeakers ?? false,
      // 0 = auto. ALWAYS start at auto each launch (never restore a stored
      // count): a sticky wrong count — e.g. 2 when the source has 4 speakers —
      // silently and severely degrades diarization. The Sidebar picker is a
      // per-session override only; auto is the reliable default the diarizer
      // estimates from the audio. (>0 still passes through as --num-speakers.)
      expectedSpeakers: 0,
      // Empty string here = "ask backend for the default and persist
      // it on first app boot." See the resolver effect just below.
      transcriptLibrary: stored.transcriptLibrary ?? "",
      // On-video caption look. Defaults: small (13px) white Verdana on a 75%
      // dark backing. captionFont migrates the old sans/serif/mono keys to the
      // named system fonts so a pre-existing pref still resolves.
      captionSizePx: stored.captionSizePx ?? 13,
      captionFont: migrateCaptionFont((stored as Record<string, unknown>).captionFont),
      captionBgOpacity: stored.captionBgOpacity ?? 0.75,
      captionColor: stored.captionColor ?? "#ffffff",
      // 480 by default: the preview is throwaway (scrub/mark only), so we
      // optimise for fast download over sharpness. Export uses real quality.
      previewMaxHeight: stored.previewMaxHeight ?? 480,
    };
  });
  const setDefaults = useCallback((d: Defaults | ((prev: Defaults) => Defaults)) => {
    setDefaultsState((prev) => {
      const next = typeof d === "function" ? (d as (p: Defaults) => Defaults)(prev) : d;
      saveJson(DEFAULTS_KEY, next);
      return next;
    });
  }, []);

  // ── Editable keyboard shortcuts (Settings → Commands) ──
  // Overrides only; an action with no override uses its defaults. The keydown
  // handler matches against `comboToAction`; the command registry overlays its
  // cosmetic hotkeys from the same source so the palette never drifts.
  const [keybindings, setKeybindingsState] = useState<KeybindingOverrides>(() => loadKeybindings());
  const setKeybindings = useCallback((next: KeybindingOverrides) => {
    setKeybindingsState(next);
    saveKeybindings(next);
  }, []);
  const comboToAction = useMemo(() => buildComboMap(keybindings), [keybindings]);

  // Lazily populate transcriptLibrary with the OS-correct default on
  // first boot. The default is `~/Documents/Sauce Bunny/Transcripts/` but
  // we resolve it via Tauri's path API so localized Documents folders
  // (Documenten / Documenti / 文档 / …) work correctly. After this
  // fires once the user can override it from Settings.
  useEffect(() => {
    if (defaults.transcriptLibrary) return;
    (async () => {
      try {
        const p = await invoke<string>("default_transcript_library_path");
        // Functional update: this resolves asynchronously, so merge against the
        // LATEST defaults — a stale-snapshot spread would clobber any change made
        // meanwhile (e.g. the hybrid-migration latch or a Settings toggle).
        if (p) setDefaults((prev) => prev.transcriptLibrary ? prev : { ...prev, transcriptLibrary: p });
      } catch { /* user can still set it manually from Settings */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // r72: one-shot — flip existing installs onto the hybrid (stream-first)
  // default, even if they saved the old download-first value. Latches so the
  // user's own Web-playback toggle is respected afterward.
  useEffect(() => {
    if (defaults.hybridMigrated) return;
    setDefaults((prev) => prev.hybridMigrated ? prev : { ...prev, streamPreview: true, hybridMigrated: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fallbackFps = DEFAULT_FPS_FALLBACK[defaults.timecode] ?? 24;

  // Live mirror of `defaults` for closures that outlive the render they were
  // created in. The cookie helpers below are captured by useCallbacks whose dep
  // arrays don't list ytCookiesBrowser, so reading `defaults` directly would
  // pin them to a stale value — connecting a browser in Settings then wouldn't
  // take effect for export/captions/transcript/snapshot. The ref is always current.
  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;

  /**
   * Returns the configured cookies-browser identifier, or undefined when
   * the user has it disabled. Threaded into every yt-dlp invoke so we
   * authenticate consistently across fetch / clip / captions / snapshot
   * / transcript. Backend treats undefined / "none" identically.
   * Reads defaultsRef so stale callback closures still see the live setting.
   */
  const cookiesBrowserOrNone = (): string | undefined =>
    defaultsRef.current.ytCookiesBrowser && defaultsRef.current.ytCookiesBrowser !== "none"
      ? defaultsRef.current.ytCookiesBrowser
      : undefined;

  /**
   * Run a cookie-taking yt-dlp command, then RETRY once WITHOUT cookies if it
   * failed while cookies were actually applied. Public social posts (LinkedIn,
   * many Reddit/IG/X) break when yt-dlp is handed auth cookies — it fetches a
   * logged-in page it can't parse ("Unable to extract video") — while the
   * public page resolves fine. Mirrors the backend resolver's cookie-fallback
   * (get_direct_stream_url / fetch_metadata) for the awaited download/export
   * commands. Cancellations are never retried. `buildArgs` is called with the
   * cookie value to use so the same arg shape serves both attempts.
   */
  async function invokeWithCookieRetry<T>(
    cmd: string,
    buildArgs: (cookies: string | undefined) => Record<string, unknown>,
  ): Promise<T> {
    const cookies = cookiesBrowserOrNone();
    try {
      return await invoke<T>(cmd, buildArgs(cookies));
    } catch (err) {
      if (cookies && !formatError(err).toLowerCase().includes("cancel")) {
        appendLog("info", "yt-dlp", `${cmd} failed with sign-in cookies — retrying without…`);
        return await invoke<T>(cmd, buildArgs(undefined));
      }
      throw err;
    }
  }

  // ====== YouTube sign-in (cookies-from-browser) — r71 ======
  // One modal (YouTubeAuthModal), three surfaces driven by `ytAuthMode`:
  //   • "welcome"  → FIRST RUN: ask the user to connect once so downloads
  //     stay reliable + they hit far fewer bot-checks. Shown until they make
  //     a choice (pick a browser OR dismiss), then `ytAuthOnboarded` latches
  //     so it never nags again.
  //   • "blocked"  → a fetch tripped YouTube's bot-check and NO browser is
  //     configured → "connect to continue".
  //   • "severed"  → a fetch tripped the bot-check but a browser IS already
  //     configured → the sign-in broke (cookies expired / signed out) →
  //     "reconnect".
  // Cookie-borrow ONLY — never passwords / account creation. The choice is
  // cached in `defaults.ytCookiesBrowser` (localStorage). `ytAuthRetry`
  // re-runs handleFetch once a browser is picked (after defaults update, so
  // no stale closure).
  const [ytAuthOpen, setYtAuthOpen] = useState(false);
  const [ytAuthMode, setYtAuthMode] = useState<"welcome" | "blocked" | "severed" | "site-login">("blocked");
  // Which site the cookie reminder is about ("YouTube", "Reddit", …). The
  // picker is identical (cookies are read per-browser, not per-site) — only the
  // copy changes so the reminder reads right for whatever the user just fetched.
  const [ytAuthSite, setYtAuthSite] = useState("YouTube");
  // Committed source URL, set SYNCHRONOUSLY at fetch time so the reminder can
  // name the host even within the same fetch (the state version would be stale).
  const activeSourceUrlRef = useRef<string | null>(null);
  const [ytAuthRetry, setYtAuthRetry] = useState(0);
  const ytAuthPromptedSeqRef = useRef(-1);

  // First-run prompt. Latches on `ytAuthOnboarded` (connect OR dismiss),
  // so it shows exactly once.
  useEffect(() => {
    if (defaults.ytAuthOnboarded) return;
    setYtAuthMode("welcome");
    setYtAuthOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const maybePromptYtAuth = useCallback((msg: string, seq: number) => {
    // Fire for ANY login-gated source (YouTube bot-check OR Reddit/other sites
    // that now require cookies) — that's the "remind me about cookies when
    // appropriate" behavior.
    if (!needsCookiesError(msg)) return;
    if (ytAuthPromptedSeqRef.current === seq) return; // one prompt per source load
    ytAuthPromptedSeqRef.current = seq;
    const host = hostnameOf(activeSourceUrlRef.current ?? "");
    // Decide by HOST first. The error text can contain "YouTube auth" (that's
    // the name of the cookies setting) even for a Reddit failure, so sniffing
    // the message would wrongly show the YouTube modal. Only fall back to the
    // message when we genuinely don't know the host.
    const isYouTube = host
      ? /youtube\.com|youtu\.be/.test(host)
      : isYouTubeBotError(msg);
    if (isYouTube) {
      setYtAuthSite("YouTube");
      // Already picked a browser but STILL bot-checked = the sign-in got severed.
      setYtAuthMode(defaults.ytCookiesBrowser !== "none" ? "severed" : "blocked");
    } else {
      setYtAuthSite(prettyHost(host));
      setYtAuthMode("site-login");
    }
    setYtAuthOpen(true);
  }, [defaults.ytCookiesBrowser]);

  const handleYtAuthPick = useCallback(
    (b: Exclude<Defaults["ytCookiesBrowser"], "none">) => {
      setDefaults({ ...defaults, ytCookiesBrowser: b, ytAuthOnboarded: true });
      setYtAuthOpen(false);
      ytAuthPromptedSeqRef.current = -1; // a fresh failure may re-prompt
      // Nothing to retry on the first-run welcome (no fetch in flight).
      if (ytAuthMode !== "welcome") setYtAuthRetry((n) => n + 1);
    },
    [defaults, setDefaults, ytAuthMode],
  );

  // Dismissing any surface counts as onboarded (so the welcome won't nag),
  // without changing the cookies choice.
  const handleYtAuthClose = useCallback(() => {
    setYtAuthOpen(false);
    if (!defaults.ytAuthOnboarded) setDefaults({ ...defaults, ytAuthOnboarded: true });
  }, [defaults, setDefaults]);

  // ====== yt-dlp extractor-rot recovery ======
  // yt-dlp's site extractors rot — YouTube changes something every few weeks
  // and yt-dlp ships the fix days later. A user on a stale copy just sees
  // "Couldn't resolve source" and blames the app, even though Settings → Web
  // sources has a working Update button. So when the surfaced error matches a
  // KNOWN rot signature (lib/validation.ts looksLikeExtractorRot — the
  // sign-in/bot-check flow and genuinely-unavailable videos are excluded and
  // keep their own surfaces), the canvas error overlay offers a one-click
  // "Update yt-dlp & retry":
  //   offer → busy (update_ytdlp runs; version → pipeline log) → automatic
  //   re-fetch of the SAME URL through handleFetch (fresh seq, full reset).
  // ONE cycle per source URL: a rot-match after that URL's update+retry has
  // already run renders the plain error plus an "engine is current" hint
  // instead — never a second offer (no update→fail→offer loops).
  type RotRecovery =
    | { phase: "offer"; url: string }
    | { phase: "busy"; url: string }
    | { phase: "spent"; version: string };
  const [rotRecovery, setRotRecovery] = useState<RotRecovery | null>(null);
  /** URL → yt-dlp version its one update+retry cycle installed (null = the
   *  update itself failed; those get the plain error, no "current" claim). */
  const rotSpentUrlsRef = useRef(new Map<string, string | null>());

  /** Classify a just-surfaced error for the current source: set the rot
   *  offer (or the post-cycle hint) when it matches, clear a stale non-busy
   *  flag when it doesn't — each surfaced error is authoritative for what
   *  the overlay shows. Stable — safe in the long-lived event listeners. */
  const classifyExtractorRot = useCallback((msg: string) => {
    const u = activeSourceUrlRef.current;
    if (!u || !looksLikeExtractorRot(msg)) {
      // Not rot (or no committed source): drop any leftover flag so an
      // unrelated later error can't render a misleading update button. An
      // in-flight update keeps its busy state — it resolves itself.
      setRotRecovery((prev) => (prev?.phase === "busy" ? prev : null));
      return;
    }
    const spent = rotSpentUrlsRef.current;
    if (spent.has(u)) {
      const version = spent.get(u) ?? null;
      setRotRecovery(version ? { phase: "spent", version } : null);
    } else {
      // Never downgrade busy → offer: a straggling error event from the
      // same dead source must not un-disable the button mid-update.
      setRotRecovery((prev) => (prev?.phase === "busy" ? prev : { phase: "offer", url: u }));
    }
  }, []);

  // ====== URL bar ======
  const [url, setUrl] = useState("");

  // ====== Metadata + status ======
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [status, setStatus] = useState<AppStatus>("empty");
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  // Animated toolbar-Fetch phase. The URL fetch mounts optimistically straight
  // to status "loaded" (never "fetching"), so the button's loading → success/
  // error flash rides this explicit state, set at handleFetch's lifecycle points.
  // `fetchButtonPhase` folds status "fetching" (local imports) back in as loading.
  const [fetchPhase, setFetchPhase] = useState<StatefulPhase>("idle");
  // YouTube source vs imported local file. Most paths key off this.
  const [sourceKind, setSourceKind] = useState<SourceKind>("youtube");
  const [localFilePath, setLocalFilePath] = useState<string | null>(null);
  // Byte size of the imported local file — folded into the review fingerprint so
  // two distinct same-length, same-dimension clips don't collide onto one review.
  const [localFileSize, setLocalFileSize] = useState<number | null>(null);
  /**
   * Path of the ffmpeg-normalised playback copy (WKWebView-compatible MP4 /
   * MP3). When set, the LocalMediaPlayer uses this; otherwise it falls back
   * to the original `localFilePath`. The original is always what we hand to
   * `transcribe_local_file` / export pipelines.
   */
  const [playbackPath, setPlaybackPath] = useState<string | null>(null);
  // (r80) Web-source stream/cache/codecs/download state now lives in the
  // useWebPlayback state machine (see the hook call above). Read its read-model
  // (webPlayback.streamUrl / cachePath / videoCodec / downloading / …).
  /**
   * Pre-cached source audio (r76): asset:// URL of the full audio track we
   * download in the background for a STREAMING web source. Playback is native
   * (the proxy-merged fMP4 carries the audio), so this is NOT used for playback
   * — it's a head start for Whisper (the same source-keyed file the transcript
   * pipeline reuses). Doubles as the per-source "already cached" guard so we
   * don't re-download. Null = not streaming / cached-to-disk / local file.
   */
  const [webAudioCachedSrc, setWebAudioCachedSrc] = useState<string | null>(null);
  /** The COMMITTED source page URL of the current fetch (what yt-dlp resolves),
   *  captured at fetch time. The audio-master effect keys off THIS, not the
   *  live `url` input — editing the input box mid-playback must not repoint the
   *  cached audio at a different (or empty) URL. Cleared by resetForNewSource. */
  const [activeSourceUrl, setActiveSourceUrl] = useState<string | null>(null);
  /** True once the active player has reported ready (loadedmetadata /
   *  SourceBuffer open). Drives the r62 "resolving / starting playback"
   *  overlay so the user sees a clear status over the poster during the
   *  yt-dlp resolve + MSE buffer window. Reset on every new source. */
  const [playerReady, setPlayerReady] = useState(false);
  /**
   * True while yt-dlp is still resolving the highest-quality stream URL in
   * the background. The IFrame player is already mounted and playable; this
   * flag drives a non-blocking pipeline badge + sidebar shimmer. Distinct
   * from `status === "fetching"` (which blocks the whole canvas).
   */
  const [metadataLoading, setMetadataLoading] = useState(false);
  /** True while ffmpeg is prepping a local import for WKWebView playback. */
  const [playbackPrepBusy, setPlaybackPrepBusy] = useState(false);
  /**
   * Per-import flag: when MediaBunnyPlayer reports a codec it can't decode
   * (opus-in-MP4, HEVC main10 on older Safari, etc.) we route THIS file
   * through the ffmpeg-prep + <video> path even if useWebCodecsDecoder is
   * globally on. Doesn't change the Settings toggle — next import tries
   * mediabunny again. Cleared by resetForNewSource.
   */
  const [webCodecsFallbackForImport, setWebCodecsFallbackForImport] = useState(false);

  /**
   * Which player the current local import resolved to (r93 — mediabunny-first
   * default). Set by `loadLocalPath` after a capability probe:
   *  - "native"    → LocalMediaPlayer (<video>) — native-friendly codecs, or
   *                  the ffmpeg-transcoded copy when mediabunny can't decode.
   *  - "mediabunny"→ MediaBunnyPlayer (WebCodecs video + in-app/WASM audio) —
   *                  plays the ORIGINAL with no transcode (AV1+Opus etc.).
   * Independent of the useWebCodecsDecoder toggle so mediabunny-first is the
   * default for everyone. Only governs local files; the web path is untouched.
   */
  const [localPlayer, setLocalPlayer] = useState<"native" | "mediabunny">("native");

  /**
   * Per-import guard: set once we've fallen back from a failed native
   * `<video>` load to MediaBunnyPlayer for THIS source. Native `<video>` over
   * asset:// isn't guaranteed even for "friendly" codecs (e.g. very large
   * files can log MEDIA_ERR_SRC_NOT_SUPPORTED and never load), so the first
   * native error on a local original swaps to mediabunny (which reads the file
   * via fetch(asset://) + ranged reads, sidestepping the <video> media loader).
   * This flag makes that swap fire at most once per source so it can't loop.
   * Cleared by resetForNewSource.
   */
  const [nativeFallbackTried, setNativeFallbackTried] = useState(false);

  // Effective fps and duration in frames.
  const fps = metadata?.fps && metadata.fps > 0 ? metadata.fps : fallbackFps;
  const durationFrames = useMemo(
    () => metadata?.duration != null ? Math.floor(metadata.duration * Math.max(1, Math.round(fps))) : 0,
    [metadata, fps]
  );
  const durationTc = useMemo(() => durationToTc(metadata?.duration ?? 0, fps), [metadata, fps]);

  // ====== Playback (driven by YouTube player when available) ======
  // The playhead itself is NOT App state — it lives in lib/playhead-store and
  // ticks up to 60×/sec straight from the player. Only the leaves that paint
  // it subscribe (Transport tc, Timeline cursor, captions, karaoke, the
  // annotation fade); App logic reads getPlayheadFrames() at action time.
  // This is what keeps playback from re-rendering the whole App tree.
  const playerRef = useRef<PlayerHandle>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  // ====== In/out + export form ======
  // null = mark not set. With both null the export is the full clip
  // (no --download-sections passed to yt-dlp) — fastest path for "just give
  // me the mp3" workflows.
  const [inFrames, setInFrames] = useState<number | null>(null);
  const [outFrames, setOutFrames] = useState<number | null>(null);

  // Undoable mark mutation — records the before/after pair on the app stack
  // (lib/undo.ts). Used by the I/O/G handlers and the queue-add mark clear.
  // TC-field edits are deliberately NOT recorded: the field is a text input
  // with its own native undo, and per-keystroke mark entries would flood the
  // stack. Values are absolute frames, so replay is order-independent.
  const pushMarksUndo = useCallback((
    label: string,
    prevIn: number | null, prevOut: number | null,
    nextIn: number | null, nextOut: number | null,
  ) => {
    appUndo.push({
      label,
      undo: () => { setInFrames(prevIn); setOutFrames(prevOut); },
      redo: () => { setInFrames(nextIn); setOutFrames(nextOut); },
    });
  }, []);

  const [exportOpts, setExportOpts] = useState<ExportOpts>(() => ({
    inTc: "",
    outTc: "",
    filename: "clip",
    // Prefer the Settings default; fall back to the last sidebar-picked folder
    // (persisted under "cp-folder" below) so a folder chosen only from the
    // sidebar survives relaunch instead of leaving Export disabled.
    folder: defaults.folder ?? (() => { try { return localStorage.getItem("cp-folder"); } catch { return null; } })(),
    format: defaults.format,
    captions: defaults.captions,
    reencode: defaults.reencode,
  }));

  // Persist the folder under the legacy key too so re-opens find it.
  useEffect(() => {
    if (exportOpts.folder) try { localStorage.setItem("cp-folder", exportOpts.folder); } catch { /* ignore */ }
  }, [exportOpts.folder]);

  // Timeline → TC fields (empty string when the mark is null)
  useEffect(() => {
    setExportOpts((prev) => {
      const nextIn  = inFrames  != null ? framesToTc(inFrames, fps)  : "";
      const nextOut = outFrames != null ? framesToTc(outFrames, fps) : "";
      if (prev.inTc === nextIn && prev.outTc === nextOut) return prev;
      return { ...prev, inTc: nextIn, outTc: nextOut };
    });
  }, [inFrames, outFrames, fps]);

  // TC field edit → timeline. Empty string clears the mark; a valid in-range
  // TC sets it. Invalid input is left alone (the field shows the bad value
  // styled in red until the user fixes it).
  useEffect(() => {
    const max = Math.max(0, durationFrames - 1);
    if (exportOpts.inTc === "") {
      if (inFrames !== null) setInFrames(null);
    } else {
      const inF = tcToFrames(exportOpts.inTc, fps);
      if (inF != null && inF !== inFrames && inF >= 0 && inF <= max) setInFrames(inF);
    }
    if (exportOpts.outTc === "") {
      if (outFrames !== null) setOutFrames(null);
    } else {
      const outF = tcToFrames(exportOpts.outTc, fps);
      if (outF != null && outF !== outFrames && outF >= 0 && outF <= max + 1) {
        setOutFrames(Math.min(outF, max));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportOpts.inTc, exportOpts.outTc]);

  // ====== Logs + progress ======
  const [logs, setLogs] = useState<ClientLog[]>([]);
  // Pipeline panel starts collapsed — most of the time the user just
  // wants to see the canvas and timeline. Toggle persists across launches.
  const [logsOpen, setLogsOpen] = useState<boolean>(() => loadJson<boolean>("cp-logs-open", false));
  useEffect(() => saveJson("cp-logs-open", logsOpen), [logsOpen]);
  const [progress, setProgress] = useState(0);
  const [jobId, setJobId] = useState<string | null>(null);
  const [resultPath, setResultPath] = useState<string | null>(null);
  // Animated Export-button phase — loading while the clip job runs, then a
  // success/error flash. Driven by the same clip-done event + local-export
  // return paths that already move `status`; user cancel goes straight to idle.
  const [exportPhase, setExportPhase] = useState<StatefulPhase>("idle");

  // ====== Captions / transcript ======
  const [captionsJobId, setCaptionsJobId] = useState<string | null>(null);
  const [captionsState, setCaptionsState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [captionsError, setCaptionsError] = useState<string | null>(null);

  // ====== Whisper transcript ======
  const [transcriptJobId, setTranscriptJobId] = useState<string | null>(null);
  const [transcriptState, setTranscriptState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [transcriptProgress, setTranscriptProgress] = useState(0);
  // Transient run outcome for the GenerateButton flash (drawn check/cross),
  // cleared by its onResolved. Separate from the persistent transcriptState
  // "done"/"error" (which keeps labelling the idle button "· run again").
  const [transcriptResolution, setTranscriptResolution] = useState<"success" | "error" | null>(null);
  /**
   * Current stage of the in-flight transcript pipeline. Reset to null
   * outside of a running job. The Sidebar phase indicator reads this
   * so the progress text says "Diarizing speakers…" instead of pinning
   * at 100% with whisper's last percent.
   *
   * Possible values map 1:1 with the `transcript-phase` event the Rust
   * shell emits: "whisper" | "diarize-prepare" | "diarize-process" |
   * "diarize-merge".
   */
  const [transcriptPhase, setTranscriptPhase] = useState<string | null>(null);
  const [whisperModels, setWhisperModels] = useState<WhisperModel[]>([]);

  // ====== Speaker-model pre-warm (Settings → Transcription) ======
  // Tracks the in-flight prepare_diarizer_models job. When done with
  // success, persist `diarizerReady = true` so the Sidebar's "Detect
  // speakers" toggle can show a "✓ Ready" hint instead of warning the
  // user about the first-run download.
  const [diarizerPrepareState, setDiarizerPrepareState] =
    useState<"idle" | "running" | "done" | "error">("idle");
  const [diarizerPrepareError, setDiarizerPrepareError] = useState<string | null>(null);
  const [diarizerPrepareJobId, setDiarizerPrepareJobId] = useState<string | null>(null);
  const [diarizerReady, setDiarizerReady] = useState<boolean>(() => {
    try { return localStorage.getItem("saucebunny.diarizerModelsReady") === "1"; }
    catch { return false; }
  });

  // ====== Frame snapshot ======
  const [snapshotBusy, setSnapshotBusy] = useState(false);

  // ====== Clip queue (multi-section export) ======
  const [clipQueue, setClipQueue] = useState<QueuedClip[]>([]);
  const [queueOpen, setQueueOpen] = useState(false);
  // ── Top-level view (nav rail): Home (Library) vs Clip (editor) ──
  // Single state switch — no router (CLAUDE.md). Persisted so the app
  // reopens where you left it; anything but a stored "home" (missing,
  // corrupt, future value) falls back to "clip", the working view.
  // The panel window (?window=panel) never mounts App, so it's untouched.
  const [activeView, setActiveViewState] = useState<AppView>(() =>
    loadJson<string>(ACTIVE_VIEW_KEY, "clip") === "home" ? "home" : "clip");
  const setActiveView = useCallback((v: AppView) => {
    setActiveViewState(v);
    saveJson(ACTIVE_VIEW_KEY, v);
  }, []);
  /**
   * Home-reset signal for the Library: bumped whenever Home is chosen
   * through a navigation surface (nav rail item, logo, palette command),
   * so the Library returns to its top level (clears drill-in + search)
   * even when it was already the active view. Deliberately NOT bumped by
   * plain setActiveView calls (e.g. "open URL bar" jumping to Clip).
   */
  const [homeResetTick, setHomeResetTick] = useState(0);
  const navigateView = useCallback((v: AppView) => {
    setActiveView(v);
    if (v === "home") setHomeResetTick((t) => t + 1);
  }, [setActiveView]);
  // Focus targets for keyboard view-switches (⌘1/⌘2): the outgoing view goes
  // [hidden] and would orphan focus to <body>, so the shortcut moves focus into
  // the newly-shown view's root (tabindex=-1 containers, see the JSX below).
  const homeViewRef = useRef<HTMLDivElement>(null);
  const clipViewRef = useRef<HTMLDivElement>(null);
  const coreviewViewRef = useRef<HTMLDivElement>(null);
  // Left source/export sidebar visibility — persisted, mirroring the right
  // drawer's toolbar toggle. Defaults open.
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    try { return localStorage.getItem("saucebunny.sidebarOpen") !== "0"; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem("saucebunny.sidebarOpen", sidebarOpen ? "1" : "0"); } catch { /* quota */ }
  }, [sidebarOpen]);
  const [queueRunning, setQueueRunning] = useState(false);
  /**
   * True when the side panel has been popped out into its own native
   * window (r44.B). While true the docked drawer doesn't render at all
   * — the user explicitly asked for "true detachment", so there's no
   * "minimized" placeholder. They get the panel back by closing the
   * floating window (Rust fires `panel:closed` → we flip this back).
   */
  const [panelDetached, setPanelDetached] = useState(false);
  const clipQueueRef = useRef<QueuedClip[]>([]);
  clipQueueRef.current = clipQueue;
  /**
   * Resolver for the currently-running queue item. When set, the global
   * clip-done listener routes the event here instead of the normal
   * single-export bookkeeping.
   */
  const queueResolverRef = useRef<
    | ((r: { success: boolean; path?: string; error?: string }) => void)
    | null
  >(null);
  /**
   * Resolver for the in-flight playback prep job. Receives the prepared path
   * (or an error message) via the `playback-prep-done` event listener.
   */
  const playbackPrepResolverRef = useRef<
    | { resolve: (path: string) => void; reject: (err: unknown) => void }
    | null
  >(null);
  /**
   * Monotonic counter incremented on every new source-load gesture (fetch
   * URL, import file). Async continuations (yt-dlp metadata resolve, ffmpeg
   * prep done) compare the seq they captured at start against the current
   * value before touching state — drops stale writes from previous loads.
   */
  const sourceSeqRef = useRef(0);
  /**
   * Cancel-token for the in-flight mediabunny local export. The token is
   * a tiny mutable object the export loop polls every ~150ms; flipping
   * `.cancelled = true` causes the next poll tick to call
   * `conversion.cancel()`. Stop / source-switch both flip it.
   */
  const localExportCancelRef = useRef<{ cancelled: boolean } | null>(null);
  /** Live ID of the playback prep job — drives progress + cancel routing. */
  const [playbackPrepJobId, setPlaybackPrepJobId] = useState<string | null>(null);
  const playbackPrepJobIdRef = useRef<string | null>(null);
  playbackPrepJobIdRef.current = playbackPrepJobId;
  const [playbackPrepProgress, setPlaybackPrepProgress] = useState(0);

  const refreshWhisperModels = useCallback(async () => {
    try {
      const list = await invoke<WhisperModel[]>("list_whisper_models");
      setWhisperModels(list);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    refreshWhisperModels();
  }, [refreshWhisperModels]);

  const selectedModel = whisperModels.find((m) => m.id === defaults.whisperModel);
  const whisperModelReady = !!selectedModel?.downloaded;
  const whisperModelLabel = selectedModel?.name ?? defaults.whisperModel;

  // ====== Recents ======
  const [recents, setRecents] = useState<RecentClip[]>(() => loadJson<RecentClip[]>(RECENTS_KEY, []));
  useEffect(() => saveJson(RECENTS_KEY, recents), [recents]);

  // ====== Recent sources (URL-bar history + "Resume last session") ======
  // Recorded only on SUCCESSFUL loads: web URLs when fetch_metadata resolves,
  // local files when probe_local_file succeeds. Failed loads never land here.
  const [recentSources, setRecentSources] = useState<RecentSource[]>(() => loadRecentSources());
  useEffect(() => saveRecentSources(recentSources), [recentSources]);
  const recordRecentSource = useCallback(
    (entry: { kind: RecentSource["kind"]; value: string; title: string; durationSeconds?: number }) => {
      setRecentSources((prev) => upsertRecent(prev, entry));
    }, []);

  // ====== Aspect crop guide + captions display ======
  const [aspect, setAspect] = useState<AspectId>(() => loadJson<AspectId>(ASPECT_KEY, "off"));
  useEffect(() => saveJson(ASPECT_KEY, aspect), [aspect]);
  const [captionsOn, setCaptionsOn] = useState<boolean>(() => loadJson<boolean>("cp-captions-on", false));
  useEffect(() => saveJson("cp-captions-on", captionsOn), [captionsOn]);
  // Timeline audio waveform lane (local files only) — ViewOptions toggle.
  const [waveformVisible, setWaveformVisible] = useState<boolean>(() => loadJson<boolean>("saucebunny.waveformVisible", true));
  useEffect(() => saveJson("saucebunny.waveformVisible", waveformVisible), [waveformVisible]);

  // ====== Volume (persisted) — drives both YT and local players ======
  // If a previous session left the volume at 0, bump it to 0.5 on launch so
  // users aren't silently muted (the explicit mute button is the way to mute).
  const [volume, setVolumeState] = useState<number>(() => {
    const v = loadJson<number>("cp-volume", 1);
    return v > 0 ? v : 0.5;
  });
  const [muted, setMutedState] = useState<boolean>(() => loadJson<boolean>("cp-muted", false));
  useEffect(() => saveJson("cp-volume", volume), [volume]);
  useEffect(() => saveJson("cp-muted", muted), [muted]);
  // Push to the active player whenever they change.
  useEffect(() => {
    const p = playerRef.current;
    if (!p) return;
    try {
      p.setVolume(volume);
      p.setMuted(muted);
    } catch { /* ignore */ }
  }, [volume, muted]);
  const handleVolumeChange = useCallback((v: number) => {
    setVolumeState(v);
    if (v > 0 && muted) setMutedState(false);
  }, [muted]);
  const handleMutedChange = useCallback((m: boolean) => setMutedState(m), []);

  // ====== Playback speed (persisted) ======
  // The user's "watch speed" (0.5–2×), distinct from the transient J-K-L
  // shuttle: the players restore THIS rate whenever a shuttle exits. Applies
  // to the <video>-backed players (local + MSE stream); MediaBunny/WebCodecs
  // playback can't honour it (PlayerHandle.supportsPlaybackRate), so the
  // speed UI disables itself while that player is active.
  const [playbackRate, setPlaybackRate] = useState<number>(() =>
    sanitizePlaybackRate(loadJson<number>("saucebunny.playbackRate", 1)));
  useEffect(() => saveJson("saucebunny.playbackRate", playbackRate), [playbackRate]);
  // Capability of the ACTIVE player — refreshed on every player-ready, reset
  // on source swap. False only while MediaBunnyPlayer (always 1×) is up.
  const [rateSupported, setRateSupported] = useState(true);
  // Transient on-video HUD (the shuttle-badge pill). Flashed directly by the
  // two rate handlers below — deliberately NOT an effect on `playbackRate`,
  // so the persisted rate never flashes on boot (the old armed-ref guard
  // double-fired under StrictMode) and a change flashes exactly once. The
  // player-ready path re-applies the rate when a player (re)mounts.
  const [rateHud, setRateHud] = useState<number | null>(null);
  const rateHudTimerRef = useRef(0);
  const flashRateHud = useCallback((r: number) => {
    setRateHud(r);
    if (rateHudTimerRef.current) window.clearTimeout(rateHudTimerRef.current);
    rateHudTimerRef.current = window.setTimeout(() => {
      rateHudTimerRef.current = 0;
      setRateHud(null);
    }, 1500);
  }, []);
  useEffect(() => () => {
    if (rateHudTimerRef.current) window.clearTimeout(rateHudTimerRef.current);
  }, []);
  const handlePlaybackRateChange = useCallback((r: number) => {
    if (!rateSupported) {
      // Honest no-op: the WebCodecs player always plays at 1× — surface a
      // note instead of flashing a rate badge that isn't true.
      setToast({ id: ++toastIdRef.current, kind: "info",
        title: "Speed control isn't available for the WebCodecs player" });
      return;
    }
    const next = sanitizePlaybackRate(r);
    if (next === playbackRate) return;
    setPlaybackRate(next);
    try { playerRef.current?.setPlaybackRate(next); } catch { /* ignore */ }
    flashRateHud(next);
  }, [rateSupported, playbackRate, flashRateHud]);
  const handlePlaybackRateStep = useCallback(
    (dir: 1 | -1) => handlePlaybackRateChange(stepPlaybackRate(playbackRate, dir)),
    [handlePlaybackRateChange, playbackRate]);

  // ====== Command palette (⌘K) ======
  const [paletteOpen, setPaletteOpen] = useState(false);

  // ====== Shortcut cheat-sheet (⌘/) ======
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // ====== First-run checklist (Monitor empty state) ======
  // Step completion derives from existing signals; only the manual
  // dismissal is persisted (saucebunny.onboarding).
  const [onboardingDismissed, setOnboardingDismissed] = useState<boolean>(() => loadOnboardingDismissed());

  // ====== Settings modal ======
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<"general" | "transcription" | "ai-summary" | "commands" | "about">("general");

  // ====== Media info modal ======
  // Deep inspector over the ORIGINAL local source file (never the ffmpeg
  // playback copy — the user wants the truth about their file on disk).
  const [mediaInfoOpen, setMediaInfoOpen] = useState(false);

  // ====== Active transcript ======
  // The Transcript tab in the right drawer reads from here. We track the
  // file on disk + which producer made it (yt-dlp captions vs Whisper)
  // so the viewer can render an "origin" badge. `arrivedTick` bumps on
  // every successful generation so the drawer can pulse / auto-switch.
  const [activeTranscript, setActiveTranscript] = useState<{
    path: string;
    origin: "captions" | "whisper" | "unknown";
  } | null>(null);
  const [transcriptArrivedTick, setTranscriptArrivedTick] = useState(0);
  // Open the right drawer the first time a transcript arrives in this
  // session, so the user actually sees the new tab populate. Subsequent
  // arrivals don't re-open it (respects a user who hid the panel on
  // purpose) — the pulse + tab-switch inside the drawer handle those.
  const queueAutoOpenedForTranscript = useRef(false);
  useEffect(() => {
    if (transcriptArrivedTick === 0) return;
    if (!queueAutoOpenedForTranscript.current) {
      queueAutoOpenedForTranscript.current = true;
      setQueueOpen(true);
    }
  }, [transcriptArrivedTick]);

  // ====== Speaker lanes (timeline) ======
  // Thin per-speaker bands along the bottom of the scrub track, derived
  // from the active transcript's cues. Recomputed when the transcript file
  // changes (path) or is rewritten in place (arrivedTick bump). Lanes only
  // render for diarized / speaker-labelled transcripts — an all-null strip
  // would just be one solid bar of noise.
  const [speakerLaneData, setSpeakerLaneData] = useState<
    { startMs: number; endMs: number; color: string; speaker: string | null }[]
  >([]);
  const transcriptPath = activeTranscript?.path ?? null;
  useEffect(() => {
    if (!transcriptPath) { setSpeakerLaneData([]); return; }
    let alive = true;
    void (async () => {
      try {
        const text = await invoke<string>("read_text_file_capped", {
          path: transcriptPath,
          maxBytes: 8 * 1024 * 1024,
        });
        if (!alive) return;
        const cues = parseSrt(text);
        if (!cues.some((c) => c.speaker !== null)) { setSpeakerLaneData([]); return; }
        setSpeakerLaneData(
          speakerLanes(cues).map((lane) => ({ ...lane, color: speakerColor(lane.speaker) })),
        );
      } catch {
        if (alive) setSpeakerLaneData([]);
      }
    })();
    return () => { alive = false; };
  }, [transcriptPath, transcriptArrivedTick]);

  // ====== Backend build ID handshake ======
  // Persistent banner state when the running Rust binary doesn't match the
  // frontend's expectations (i.e. the user changed Rust code but didn't
  // restart the dev server). null = healthy / not yet checked.
  const [buildCheck, setBuildCheck] = useState<BuildIdCheck | null>(null);

  // ====== In-app notifications + canvas toast ======
  // The notification bell holds a session history of completion events; the
  // toast is the transient confirmation that pops over the canvas.
  const [notifications, setNotifications] = useState<Notif[]>([]);
  // `id` is a monotonic counter so Monitor can KEY the CanvasToast on it —
  // replacing a visible toast then remounts (fresh countdown) instead of
  // reusing the old instance's nearly-expired timer (which made the new
  // toast flash and vanish).
  const [toast, setToast] = useState<{ id: number; kind: ToastKind; title: string; body?: string } | null>(null);
  const toastIdRef = useRef(0);

  const pushNotification = useCallback(
    (kind: ToastKind, title: string, body: string, path?: string) => {
      const n: Notif = {
        id: Math.random().toString(36).slice(2),
        kind,
        title,
        body,
        path,
        timestamp: Date.now(),
        read: false,
      };
      setNotifications((prev) => [n, ...prev].slice(0, 20));
      setToast({ id: ++toastIdRef.current, kind, title, body });
      if (kind === "success") playSuccess();
      else if (kind === "error") playError();
      else playInfo();
    },
    [],
  );

  const onMarkAllRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }, []);
  const onClearNotifications = useCallback(() => setNotifications([]), []);
  const onDismissNotification = useCallback(
    (id: string) => setNotifications((prev) => prev.filter((n) => n.id !== id)),
    [],
  );

  // ====== Append log ======
  const logIdRef = useRef(0);
  // A "progress" line is one carrying a percentage (yt-dlp `[download] 12.3%`,
  // ffmpeg/whisper `... 47%`). Sidecars emit hundreds of these per second with
  // `--newline`, which used to flood the Pipeline panel with a new row per tick.
  // We collapse a run of progress lines from the SAME source into ONE row that
  // updates in place (id preserved → React updates, doesn't remount), so the
  // user sees a single live "downloading … 87%" line instead of thousands. Any
  // non-progress line (start, "Cached preview ready", an error) appends normally
  // and naturally ends the run.
  const appendLog = useCallback((tag: ClientLog["tag"], source: string, message: string) => {
    const isProgress = /\d{1,3}(?:\.\d+)?%/.test(message);
    setLogs((prev) => {
      const last = prev[prev.length - 1];
      if (
        isProgress &&
        last &&
        last.source === source &&
        /\d{1,3}(?:\.\d+)?%/.test(last.message)
      ) {
        const updated: ClientLog = { ...last, ts: nowHms(), tag, message };
        return [...prev.slice(0, -1), updated];
      }
      logIdRef.current += 1;
      return [...prev, { id: logIdRef.current, ts: nowHms(), tag, source, message }];
    });
  }, []);

  // ====== Web-source playback (r80) — stream ↔ download state machine ======
  // Owns the entire web stream → resolve → download-fallback → watchdog →
  // cache lifecycle that used to be ~300 lines of boolean/ref soup in this
  // file. Exposes a read-model (streamUrl/cachePath/codecs/downloading/…) the
  // Monitor consumes, plus stable actions. See src/hooks/use-web-playback.ts.
  const webPlayback = useWebPlayback({
    appendLog,
    pushNotification,
    maybePromptYtAuth,
    cookiesBrowser: cookiesBrowserOrNone,
    previewMaxHeight: defaults.previewMaxHeight,
  });
  const {
    loadWeb: loadWebPlayback,
    reset: resetWebPlayback,
    stop: stopWebPlayback,
    onPlayerReady: webOnPlayerReady,
    onMediaError: webOnMediaError,
  } = webPlayback;
  // True while actively MSE-streaming a web source (not yet downloaded to
  // cache). Gates the audio pre-cache, caption auto-fetch, caption-sync offset.
  const webStreaming = webPlayback.state.kind === "streaming";

  // A web source is DEAD once the playback machine reaches its terminal
  // `failed` state (the stream resolve AND the download fallback both lost —
  // nothing is playing, nothing will). When that terminal failure carries a
  // stale-extractor signature, escalate from today's two transient toasts
  // over a frozen poster to the canvas error overlay, where the one-click
  // "Update yt-dlp & retry" renders. Non-rot terminal failures keep the
  // existing quiet behavior (notification bell + pipeline log). Re-runs on
  // errorDetail changes so a late-landing metadata error can't strand or
  // clobber the verdict (classifyExtractorRot re-resolves it).
  useEffect(() => {
    const s = webPlayback.state;
    if (s.kind !== "failed" || s.seq !== sourceSeqRef.current) return;
    const rotMsg = looksLikeExtractorRot(s.message)
      ? s.message
      : errorDetail != null && looksLikeExtractorRot(errorDetail)
        ? errorDetail
        : null;
    if (!rotMsg) return;
    classifyExtractorRot(rotMsg);
    // Keep the (usually richer) metadata error if one already surfaced;
    // otherwise show the download failure that killed playback.
    setErrorDetail((prev) => prev ?? s.message);
    setStatus("error");
  }, [webPlayback.state, errorDetail, classifyExtractorRot]);

  // ====== Backend build check ======
  // Runs once on mount. If the running Rust binary's BACKEND_BUILD_ID
  // doesn't match what the frontend expects, the user almost certainly
  // forgot to restart `npm run tauri dev` after a Rust change — and the
  // symptoms (640×360 metadata, missing commands, null snapshot results,
  // etc) will look like app bugs. Surfacing this as a loud red banner +
  // pipeline error saves hours of fruitless debugging.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const got = await invoke<string>("get_backend_build_id");
        if (cancelled) return;
        if (got === EXPECTED_BACKEND_BUILD_ID) {
          setBuildCheck({ kind: "ok", id: got });
          appendLog("ok", "build", `Backend build: ${got}`);
        } else {
          setBuildCheck({ kind: "mismatch", expected: EXPECTED_BACKEND_BUILD_ID, got });
          appendLog("err", "build",
            `Backend build mismatch — frontend expects "${EXPECTED_BACKEND_BUILD_ID}" but binary reports "${got}". Restart \`npm run tauri dev\` to rebuild.`);
        }
      } catch (err) {
        if (cancelled) return;
        const msg = formatError(err);
        if (isMissingCommandError(err)) {
          // The build-ID command itself doesn't exist → very stale binary.
          setBuildCheck({ kind: "missing" });
          appendLog("err", "build",
            `Backend is stale (pre-build-handshake). Restart \`npm run tauri dev\` so cargo rebuilds the Rust backend.`);
        } else {
          setBuildCheck({ kind: "error", error: msg });
          appendLog("warn", "build", `Backend build check failed: ${msg}`);
        }
      }
    })();
    return () => { cancelled = true; };
    // appendLog is stable (empty deps) so this runs exactly once.
  }, [appendLog]);

  // ====== Notifications ======
  // Cache the permission state to avoid hitting the OS for every event.
  const notifPermissionRef = useRef<"granted" | "denied" | "default" | null>(null);
  const notify = useCallback(async (title: string, body: string) => {
    try {
      if (notifPermissionRef.current === null) {
        const granted = await isPermissionGranted();
        if (granted) {
          notifPermissionRef.current = "granted";
        } else {
          const res = await requestPermission();
          notifPermissionRef.current = res;
        }
      }
      if (notifPermissionRef.current === "granted") {
        sendNotification({ title, body });
      }
    } catch (err) {
      console.warn("notify failed", err);
    }
  }, []);

  // ====== Backend events ======
  // Refs let the long-lived event listeners read the latest state without
  // re-subscribing on every keystroke into a TC field.
  const jobIdRef = useRef<string | null>(null);
  jobIdRef.current = jobId;
  const captionsJobIdRef = useRef<string | null>(null);
  captionsJobIdRef.current = captionsJobId;
  const transcriptJobIdRef = useRef<string | null>(null);
  transcriptJobIdRef.current = transcriptJobId;
  // Pipeline-log channel label for transcription ("whisper" | "parakeet"), in a
  // ref so the long-lived transcript-log listener tags lines with the engine
  // that's actually running rather than a hardcoded "whisper".
  const txChannelRef = useRef<"whisper" | "parakeet">("whisper");
  txChannelRef.current = defaults.transcriptionEngine === "parakeet" ? "parakeet" : "whisper";
  // Snapshot of the source's title/thumbnail taken when a SINGLE clip export
  // starts, so the Recent entry is attributed to the source that was exported
  // even if the user switches sources before clip-done fires (the listener
  // guards only on job_id, which we must keep live to resolve the queue).
  const clipJobMetaRef = useRef<{ title: string; thumbnail: RecentClip["thumbnail"] } | null>(null);
  const diarizerPrepareJobIdRef = useRef<string | null>(null);
  diarizerPrepareJobIdRef.current = diarizerPrepareJobId;
  // Ref for transcript-history bookkeeping — captions/whisper listeners
  // read localFilePath off this so they pick up the current source
  // rather than a stale closure copy. `metadataRef` already exists
  // further down (preexisting); we reuse it.
  const localFilePathRef = useRef<string | null>(null);
  localFilePathRef.current = localFilePath;
  const metadataRef = useRef<Metadata | null>(null);
  metadataRef.current = metadata;
  const fpsRef = useRef(fps);
  fpsRef.current = fps;
  const exportOptsRef = useRef(exportOpts);
  exportOptsRef.current = exportOpts;

  useEffect(() => {
    const unlistens: UnlistenFn[] = [];
    let mounted = true;
    (async () => {
      const a = await listen<LogEvent>("clip-log", (e) => {
        if (!mounted || e.payload.job_id !== jobIdRef.current) return;
        const sourceHint =
          e.payload.line.startsWith("[ffmpeg]") || e.payload.line.startsWith("[Merger]") ? "ffmpeg" :
          e.payload.line.startsWith("[") ? "yt-dlp" :
          e.payload.stream === "stderr" ? "stderr" : "yt-dlp";
        appendLog(asLogTag(e.payload.tag), sourceHint, e.payload.line);
      });
      const b = await listen<ProgressEvent>("clip-progress", (e) => {
        if (!mounted || e.payload.job_id !== jobIdRef.current) return;
        setProgress(e.payload.percent);
      });
      const c = await listen<DoneEvent>("clip-done", (e) => {
        if (!mounted || e.payload.job_id !== jobIdRef.current) return;
        // If we're running the queue, route the event into the queue runner
        // and skip the single-export bookkeeping below.
        if (queueResolverRef.current) {
          const resolver = queueResolverRef.current;
          queueResolverRef.current = null;
          resolver({
            success: e.payload.success,
            path: e.payload.path ?? undefined,
            error: e.payload.error ?? undefined,
          });
          return;
        }
        if (e.payload.success && e.payload.path) {
          // Stay on "loaded" so the canvas video stays visible; the toast +
          // notification bell announce completion non-blockingly.
          setStatus("loaded");
          setExportPhase("success"); // Export button → check flash
          setResultPath(e.payload.path);
          setProgress(0);
          const filename = e.payload.path.split("/").pop() ?? "Done.";
          pushNotification("success", "Clip exported", filename, e.payload.path);
          notify("Clip exported", filename);
          // Title/thumbnail snapshot from export start — NOT metadataRef, which
          // may now point at a different source the user switched to mid-export.
          const m = clipJobMetaRef.current;
          const f = fpsRef.current;
          const opts = exportOptsRef.current;
          if (m) {
            const span =
              (tcToSeconds(opts.outTc, f) ?? 0) - (tcToSeconds(opts.inTc, f) ?? 0);
            const dur = span > 0 ? secondsToTc(span, f) : "Full";
            const r: RecentClip = {
              id: Math.random().toString(36).slice(2),
              title: m.title,
              path: e.payload.path,
              dur,
              when: Date.now(),
              thumbnail: m.thumbnail,
            };
            setRecents((prev) => [r, ...prev].slice(0, 6));
          }
        } else if (e.payload.error === "Cancelled") {
          setStatus("loaded");
          setExportPhase("idle"); // user cancel → straight to idle, no error flash
          setErrorDetail(null);
          setProgress(0);
          appendLog("warn", "ffmpeg", "Export cancelled");
          pushNotification("info", "Export cancelled", "");
        } else {
          setStatus("error");
          setExportPhase("error"); // Export button → cross flash
          setErrorDetail(e.payload.error ?? "Export failed");
          // A yt-dlp export can be the first place stale-extractor breakage
          // surfaces (fetch worked off a cached/streaming path) — offer the
          // one-click update+retry on the overlay this just raised.
          classifyExtractorRot(e.payload.error ?? "");
          notify("Export failed", e.payload.error ?? "Unknown error");
          pushNotification("error", "Export failed", e.payload.error ?? "Unknown error");
        }
      });
      const d = await listen<LogEvent>("captions-log", (e) => {
        if (!mounted || e.payload.job_id !== captionsJobIdRef.current) return;
        appendLog(asLogTag(e.payload.tag), "captions", e.payload.line);
      });
      const f = await listen<DoneEvent>("captions-done", (e) => {
        if (!mounted || e.payload.job_id !== captionsJobIdRef.current) return;
        if (e.payload.success && e.payload.path) {
          setCaptionsState("done");
          setCaptionsError(null);
          appendLog("ok", "captions", `Transcript saved → ${e.payload.path}`);
          // Load into the Transcript tab. Bumping arrivedTick triggers
          // the drawer to pulse / auto-switch tabs so the user sees the
          // result of the action they just took without having to hunt.
          setActiveTranscript({ path: e.payload.path, origin: "captions" });
          setTranscriptArrivedTick((n) => n + 1);
          // Append to history so the Transcript-tab popover lists it
          // and a future import of the same URL auto-loads it.
          try {
            const meta = metadataRef.current;
            recordTranscript({
              srtPath: e.payload.path,
              sourceUrl: meta?.webpage_url ?? null,
              sourcePath: null,
              title: meta?.title || (e.payload.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "transcript"),
              origin: "captions",
            });
          } catch { /* localStorage quota — non-fatal */ }
          // (No Finder reveal — the transcript loads into the panel; popping
          // Finder on every download was intrusive, especially on the auto
          // fetch from the CC toggle.)
        } else {
          setCaptionsState("error");
          const msg = e.payload.error ?? "Caption download failed";
          setCaptionsError(msg);
          appendLog("err", "captions", msg);
        }
      });
      const g = await listen<LogEvent>("transcript-log", (e) => {
        if (!mounted || e.payload.job_id !== transcriptJobIdRef.current) return;
        appendLog(asLogTag(e.payload.tag), txChannelRef.current, e.payload.line);
      });
      const h = await listen<DoneEvent>("transcript-done", (e) => {
        if (!mounted || e.payload.job_id !== transcriptJobIdRef.current) return;
        if (e.payload.success && e.payload.path) {
          setTranscriptState("done");
          setTranscriptResolution("success"); // GenerateButton → check flash
          setTranscriptError(null);
          setTranscriptProgress(100);
          setTranscriptPhase(null);
          const filename = e.payload.path.split("/").pop() ?? "Transcript ready.";
          appendLog("ok", txChannelRef.current, `Transcript saved → ${e.payload.path}`);
          // Load into the Transcript tab (same pulse-and-switch behavior
          // as the captions path above).
          setActiveTranscript({ path: e.payload.path, origin: "whisper" });
          setTranscriptArrivedTick((n) => n + 1);
          // Append to history (per-source) so the Transcript-tab popover
          // surfaces it and a re-import auto-loads it.
          try {
            const meta = metadataRef.current;
            recordTranscript({
              srtPath: e.payload.path,
              sourcePath: localFilePathRef.current,
              sourceUrl: meta?.webpage_url ?? null,
              title: meta?.title || (e.payload.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "transcript"),
              origin: "whisper",
            });
          } catch { /* quota */ }
          // Native OS notification keeps the filename for cross-window
          // context, but the in-app popover is intentionally one-line —
          // the new Transcript tab + pulse already shows the user where
          // the result landed, so the body text was redundant chrome.
          notify("Transcript ready", filename);
          pushNotification("success", "Transcript ready", "", e.payload.path);
          // Diarization is non-fatal: on success the backend still puts a note
          // in `error` if speaker detection was skipped. Surface it so a user
          // who asked for speakers isn't left wondering why there are none —
          // previously this only appeared in the pipeline log.
          if (e.payload.error) {
            appendLog("warn", txChannelRef.current, e.payload.error);
            pushNotification("info", "Speakers not detected", e.payload.error);
          }
        } else if (e.payload.error === "Cancelled") {
          // User Stop — the Rust Terminated handlers map signal-kills to
          // "Cancelled", so a bare exit-code message is a REAL crash (corrupt
          // model, unreadable WAV, OOM) and must fall through to the error
          // branch, not be silently absorbed as a cancel.
          setTranscriptState("idle");
          setTranscriptResolution(null); // cancel → no flash
          setTranscriptError(null);
          setTranscriptProgress(0);
          setTranscriptPhase(null);
          appendLog("warn", txChannelRef.current, "Transcription cancelled");
        } else {
          setTranscriptState("error");
          setTranscriptResolution("error"); // GenerateButton → cross flash
          setTranscriptPhase(null);
          const msg = e.payload.error ?? "Transcription failed";
          setTranscriptError(msg);
          appendLog("err", txChannelRef.current, msg);
          notify("Transcript failed", msg);
          pushNotification("error", "Transcript failed", msg);
        }
      });
      const i = await listen<DoneEvent>("model-download-done", (e) => {
        if (!mounted) return;
        if (e.payload.success) {
          refreshWhisperModels();
          const filename = e.payload.path?.split("/").pop() ?? "Downloaded.";
          notify("Whisper model ready", filename);
          pushNotification("success", "Whisper model ready", filename, e.payload.path ?? undefined);
        } else if (e.payload.error) {
          pushNotification("error", "Model download failed", e.payload.error);
        }
      });
      const j = await listen<ProgressEvent>("transcript-progress", (e) => {
        if (!mounted || e.payload.job_id !== transcriptJobIdRef.current) return;
        setTranscriptProgress(e.payload.percent);
      });
      // Transcript stage marker — drives the Sidebar phase indicator.
      // Backend emits this at well-known transitions; the frontend
      // doesn't need to scrape pipeline log strings.
      type TranscriptPhasePayload = { job_id: string; phase: string };
      const jPhase = await listen<TranscriptPhasePayload>("transcript-phase", (e) => {
        if (!mounted || e.payload.job_id !== transcriptJobIdRef.current) return;
        setTranscriptPhase(e.payload.phase);
      });
      // Speaker-model pre-warm channel (Settings → Transcription).
      type DiarizeProgressPayload = { job_id: string; line: string };
      const mPrep = await listen<DiarizeProgressPayload>("diarize-prepare-progress", () => {
        // Today we only need the on/off state — the per-phase progress
        // payload is preserved for a future indeterminate-bar pulse.
      });
      const nPrep = await listen<DoneEvent>("diarize-prepare-done", (e) => {
        if (!mounted) return;
        if (diarizerPrepareJobIdRef.current && e.payload.job_id !== diarizerPrepareJobIdRef.current) return;
        if (e.payload.success) {
          setDiarizerPrepareState("done");
          setDiarizerPrepareError(null);
          setDiarizerReady(true);
          try { localStorage.setItem("saucebunny.diarizerModelsReady", "1"); } catch { /* quota */ }
          pushNotification("success", "Speaker models ready", "FluidAudio cached. Future diarizations skip the download step.");
        } else if (e.payload.error === "Cancelled") {
          setDiarizerPrepareState("idle");
          setDiarizerPrepareError(null);
        } else {
          setDiarizerPrepareState("error");
          setDiarizerPrepareError(e.payload.error ?? "Model preparation failed");
        }
      });
      // Playback prep events — independent channel so this never collides
      // with the main export/transcript pipelines.
      const k = await listen<ProgressEvent>("playback-prep-progress", (e) => {
        if (!mounted || e.payload.job_id !== playbackPrepJobIdRef.current) return;
        setPlaybackPrepProgress(e.payload.percent);
      });
      const l = await listen<DoneEvent>("playback-prep-done", (e) => {
        if (!mounted || e.payload.job_id !== playbackPrepJobIdRef.current) return;
        const resolver = playbackPrepResolverRef.current;
        playbackPrepResolverRef.current = null;
        if (e.payload.success && e.payload.path) {
          resolver?.resolve(e.payload.path);
        } else {
          resolver?.reject(e.payload.error ?? "Playback prep failed");
        }
      });
      // Playback prep ffmpeg log lines — surface in the pipeline panel so
      // the user can see what's happening (codec choice, errors, etc).
      const m = await listen<LogEvent>("playback-prep-log", (e) => {
        if (!mounted || e.payload.job_id !== playbackPrepJobIdRef.current) return;
        appendLog(asLogTag(e.payload.tag), "playback-prep", e.payload.line);
      });
      unlistens.push(a, b, c, d, f, g, h, i, j, k, l, m, jPhase, mPrep, nPrep);
    })();
    return () => {
      mounted = false;
      unlistens.forEach((u) => u());
    };
    // appendLog / refreshWhisperModels / notify / classifyExtractorRot are
    // all stable (empty deps), so this effect runs exactly once for the
    // app's lifetime.
  }, [appendLog, refreshWhisperModels, notify, pushNotification, classifyExtractorRot]);

  // ====== Player callbacks ======
  // Sync our playhead from the YouTube player's current time while it's playing.
  const onPlayerTimeUpdate = useCallback((seconds: number) => {
    const r = Math.max(1, Math.round(fps));
    publishPlayheadFrames(Math.floor(seconds * r));
  }, [fps]);

  const onPlayerStateChange = useCallback((playing: boolean) => {
    setIsPlaying(playing);
  }, []);

  const onPlayerReady = useCallback((dur: number) => {
    // Player opened — tell the web machine (disarms its stall watchdog so we
    // don't trigger an unnecessary download fallback). No-op for local files.
    webOnPlayerReady();
    // Player is up → drop the resolving/buffering overlay (r62).
    setPlayerReady(true);
    // Apply persisted volume + mute + playback speed as soon as a player
    // becomes ready, and record whether it can honour a rate at all (drives
    // the speed UI's disabled state — MediaBunny always plays at 1×).
    const p = playerRef.current;
    setRateSupported(p?.supportsPlaybackRate ?? true);
    if (p) {
      // Rate FIRST, and isolated from the volume/mute try: the <video>
      // players seed their shuttle-exit restore rate (userRateRef) inside
      // setPlaybackRate, so it must land even if setVolume/setMuted throws —
      // otherwise a shuttle exit would snap back to 1× while the badge
      // still shows the persisted rate.
      try { p.setPlaybackRate(playbackRate); } catch { /* ignore */ }
      try {
        p.setVolume(volume);
        p.setMuted(muted);
      } catch { /* ignore */ }
    }
    // Fill in the duration immediately from whichever player just loaded so
    // the timeline becomes scrubbable even before yt-dlp returns metadata.
    // We only overwrite if we don't have a real value yet — yt-dlp's number
    // (when it arrives) is authoritative.
    if (dur > 0) {
      setMetadata((prev) => {
        if (!prev) return prev;
        if (prev.duration != null && prev.duration > 0) return prev;
        return { ...prev, duration: dur };
      });
    }
  }, [volume, muted, playbackRate, webOnPlayerReady]);

  // ====== Actions ======
  /**
   * Tears down everything tied to the previous source so a new one starts
   * from a clean slate. Critically resets `sourceKind` + `localFilePath` so
   * the Monitor doesn't render the old player while the new source loads.
   */
  const resetForNewSource = useCallback(() => {
    // Stop any currently-playing media before swapping components.
    try { playerRef.current?.pause(); } catch { /* ignore */ }
    // Kill any in-flight ffmpeg playback-prep job from the previous source —
    // otherwise its `playback-prep-done` event would fire after the new
    // source is loaded and clobber `playbackPath` with the wrong file.
    // The done listener still fires for accounting (we just ignore it via
    // the sourceSeq guard below).
    const stalePrepId = playbackPrepJobIdRef.current;
    if (stalePrepId) {
      invoke("cancel_job", { jobId: stalePrepId }).catch(() => { /* best-effort */ });
    }
    // Any pending resolver from the old prep is now dead — reject it so
    // the old handleImportFile's await unwinds cleanly.
    if (playbackPrepResolverRef.current) {
      playbackPrepResolverRef.current.reject(new Error("Source changed"));
      playbackPrepResolverRef.current = null;
    }
    // Cancel AND disown any in-flight captions/transcript job from the previous
    // source. The long-lived 'captions-done'/'transcript-done' listeners guard
    // only on job_id, so without NULLING these refs an OLD job completing after
    // a source switch would load the wrong SRT over the new source AND record it
    // in transcript history against the new URL (poisoning its auto-load).
    const staleCap = captionsJobIdRef.current;
    if (staleCap) invoke("cancel_job", { jobId: staleCap }).catch(() => { /* best-effort */ });
    setCaptionsJobId(null);
    const staleTx = transcriptJobIdRef.current;
    if (staleTx) invoke("cancel_job", { jobId: staleTx }).catch(() => { /* best-effort */ });
    setTranscriptJobId(null);
    setMetadata(null);
    setErrorDetail(null);
    // New source = a fresh rot verdict (the spent-URL map persists — one
    // update+retry cycle per URL, not per attempt).
    setRotRecovery(null);
    setLogs([]);
    setResultPath(null);
    setProgress(0);
    setCaptionsState("idle");
    setCaptionsError(null);
    setTranscriptState("idle");
    setTranscriptError(null);
    setTranscriptProgress(0);
    setTranscriptPhase(null);
    // Per-source button flashes: clear the Fetch/Export/Generate phase state so
    // a stale check/cross can't stick to the new source or falsely flash. Each
    // run re-derives its own phase; a fresh source starts idle.
    setFetchPhase("idle");
    setExportPhase("idle");
    setTranscriptResolution(null);
    // Drop the previous video's transcript so the Transcript tab doesn't
    // show stale captions over a different source. The next successful
    // generate/download repopulates it (and bumps arrivedTick to switch
    // the tab back into view).
    setActiveTranscript(null);
    setMetadataLoading(false);
    publishPlayheadFrames(0);
    setInFrames(null);
    setOutFrames(null);
    setIsPlaying(false);
    setSourceKind("youtube");
    setLocalFilePath(null);
    setLocalFileSize(null);
    setPlaybackPath(null);
    setPlaybackPrepBusy(false);
    setPlaybackPrepJobId(null);
    setPlaybackPrepProgress(0);
    setWebCodecsFallbackForImport(false);
    setNativeFallbackTried(false);
    setLocalPlayer("native");
    // Tear down the web-playback machine (cancels any in-flight resolve/
    // download + watchdog, → inactive). r80.
    resetWebPlayback();
    webAudioCachedPathRef.current = null;
    setWebAudioCachedSrc(null);
    setActiveSourceUrl(null);
    setPlayerReady(false);
    // Speed UI capability is per-player; assume supported until the next
    // player reports otherwise on ready.
    setRateSupported(true);
    // Cancel any in-flight mediabunny local export tied to the previous
    // source — without this, switching sources mid-export would leave
    // the Conversion writing into a buffer for a file the user no
    // longer cares about (and the success notification would surface
    // against the wrong source).
    if (localExportCancelRef.current) {
      localExportCancelRef.current.cancelled = true;
      localExportCancelRef.current = null;
    }
    // Cancel any in-flight ffmpeg clip export (create_clip) from the previous
    // source for the same reason as the mediabunny export above — otherwise its
    // clip-done event would resolve against the wrong source. Mirrors the
    // captions/transcript stale-job cancels: read the ref, cancel best-effort,
    // null the state handle.
    const staleClip = jobIdRef.current;
    if (staleClip) invoke("cancel_job", { jobId: staleClip }).catch(() => { /* best-effort */ });
    setJobId(null);
  }, [resetWebPlayback]);

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
      setErrorDetail("Paste a video URL (YouTube, Vimeo, TikTok, Twitter/X, Reddit, Instagram, or any page with embedded video).");
      setStatus("error");
      setFetchPhase("error");
      return;
    }
    resetForNewSource();
    // Committed source URL for the audio-master cache (keyed off this, not the
    // live `url` input, which can change without a re-fetch). The ref mirror is
    // set synchronously so the cookie reminder can name the host mid-fetch.
    activeSourceUrlRef.current = full;
    setActiveSourceUrl(full);
    // Capture this load's sequence — any await continuation below must
    // re-check the ref before calling setState to avoid clobbering a newer
    // source the user has since started.
    const seq = ++sourceSeqRef.current;

    // ─── Optimistic mount ────────────────────────────────────────────────
    // The Monitor extracts a video ID from `metadata.webpage_url` and mounts
    // the IFrame player as soon as one is present. So instead of blocking on
    // yt-dlp's metadata fetch (which can take 1–3s while it probes manifests),
    // we seed a stub metadata object that's just enough to render the player.
    // The user can hit play and watch immediately; we hydrate width/height/
    // duration/title/thumbnail in the background and reflow when they arrive.
    const stub: Metadata = {
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
      has_subs: false,
    };
    setMetadata(stub);
    setSourceKind("youtube");
    setStatus("loaded");
    publishPlayheadFrames(0);
    setInFrames(null);
    setOutFrames(null);
    // NOTE: we deliberately do NOT auto-load a prior transcript on fetch.
    // resetForNewSource() above clears it, so every fetch starts with a clean
    // transcript panel — no holdover from the previous video. A past transcript
    // is still one click away via the Transcript tab's History popover.
    // Seed a sensible filename from the URL right away; replaced once title arrives.
    setExportOpts((prev) => ({
      ...prev,
      folder: prev.folder ?? defaults.folder,
      format: defaults.format,
      reencode: defaults.reencode,
      captions: defaults.captions,
      filename: prev.filename && stripExt(prev.filename) && prev.filename !== "clip"
        ? prev.filename
        : "clip",
    }));
    appendLog("info", "yt-dlp", `Extracting URL: ${full}`);
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
    appendLog(
      "info",
      "yt-dlp",
      defaults.streamPreview
        ? `Resolving stream URL for ${hostnameOf(full)}…`
        : `Downloading ${hostnameOf(full)} for in-app playback…`,
    );
    loadWebPlayback(full, defaults.streamPreview ? "stream-first" : "download-first", seq);

    // ─── Background metadata hydration ───────────────────────────────────
    // If this fails we leave the player visible (the user is probably already
    // watching) and surface the error via the notification bell instead of
    // tearing the canvas down.
    try {
      const m = await invoke<Metadata>("fetch_metadata", {
        url: full,
        cookiesBrowser: cookiesBrowserOrNone(),
      });
      if (sourceSeqRef.current !== seq) return; // user already moved on
      setMetadata(m);
      setFetchPhase("success"); // metadata hydrated → success flash
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
        // Only auto-suggest a filename if the user hasn't typed their own.
        filename: prev.filename && prev.filename !== "clip"
          ? prev.filename
          : suggestFilename(m.title),
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
  }, [url, appendLog, defaults, fallbackFps, resetForNewSource, pushNotification, maybePromptYtAuth, classifyExtractorRot, loadWebPlayback, recordRecentSource]);

  // Re-run the current fetch after the user picks a browser in the YouTube
  // auth modal. By the time this fires, `defaults.ytCookiesBrowser` (and thus
  // a freshly-rebuilt handleFetch) already reflect the choice.
  useEffect(() => {
    if (ytAuthRetry === 0) return;
    void handleFetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ytAuthRetry]);

  /**
   * One-click recovery for a rot-flagged failure (the error-overlay CTA):
   * run `update_ytdlp` (the exact command behind Settings → Web sources →
   * Update yt-dlp — the backend resolves the freshly installed copy on the
   * next spawn), log the resulting version, then re-run the SAME fetch
   * through handleFetch — the true retry seam (fresh seq, full source
   * reset). The URL's single cycle is spent whichever way the update ends,
   * so the offer can never loop; and a different source started while the
   * update ran wins (seq guard skips the retry rather than clobber it).
   */
  const handleUpdateYtdlpAndRetry = useCallback(async () => {
    if (rotRecovery?.phase !== "offer") return;
    const u = rotRecovery.url;
    const seqAtClick = sourceSeqRef.current;
    setRotRecovery({ phase: "busy", url: u });
    appendLog("info", "yt-dlp", "Extractor failure looks like a stale yt-dlp — downloading the latest release…");
    let version: string;
    try {
      version = (await invoke<YtdlpStatus>("update_ytdlp")).version;
    } catch (err) {
      // The update itself failed (offline, GitHub unreachable…). Spend the
      // cycle with no version — plain error display, no "engine is current"
      // claim we can't back up — and surface why.
      rotSpentUrlsRef.current.set(u, null);
      const msg = formatError(err);
      appendLog("err", "yt-dlp", `yt-dlp update failed: ${msg}`);
      pushNotification("error", "yt-dlp update failed", msg);
      setRotRecovery(null);
      return;
    }
    rotSpentUrlsRef.current.set(u, version);
    appendLog("ok", "yt-dlp", `yt-dlp updated to ${version} — retrying ${hostnameOf(u)}…`);
    // The user may have started a different source while the update ran —
    // never yank it away with an automatic retry of the old URL.
    if (sourceSeqRef.current !== seqAtClick) return;
    void handleFetch(u);
  }, [rotRecovery, appendLog, pushNotification, handleFetch]);

  /**
   * Shared local-clip export core (single Export button + queued items):
   * mediabunny Conversion → bytes → write_bytes_to_path. Owns the cancel
   * token (Stop / source-switch flip it via localExportCancelRef); callers
   * keep their own status/notification/recents bookkeeping. There is no
   * ffmpeg fallback for local clips — "unsupported" surfaces as-is.
   */
  const runLocalClipExport = useCallback(async (args: {
    inputPath: string;
    startSeconds: number | null;
    endSeconds: number | null;
    format: "video-mp4" | "audio-mp3";
    destPath: string;
    /** 0..100 */
    onProgress: (pct: number) => void;
  }): Promise<
    | { kind: "ok"; bytesWritten: number }
    | { kind: "cancelled" }
    | { kind: "unsupported"; reason: string }
    | { kind: "error"; message: string }
  > => {
    const cancelToken = { cancelled: false };
    localExportCancelRef.current = cancelToken;
    try {
      const result = await exportLocalClipViaMediabunny({
        inputPath: args.inputPath,
        startSeconds: args.startSeconds,
        endSeconds: args.endSeconds,
        format: args.format,
        onProgress: (p) => args.onProgress(p * 100),
      }, cancelToken);
      if (result.kind !== "ok") return result;
      // Persist via the small bytes-writer command we already have.
      // For >50MB clips this is a one-shot invoke; large but works.
      // ifNotExists: destPath is derived (not saveDialog-vetted) — refuse
      // to clobber an existing file, matching create_clip's behavior.
      await invoke("write_bytes_to_path", {
        path: args.destPath,
        bytes: Array.from(result.bytes),
        ifNotExists: true,
      });
      return { kind: "ok", bytesWritten: result.bytes.byteLength };
    } catch (err) {
      // formatError handles Error / AppError / string — `err instanceof Error`
      // alone misses the r51 discriminated-union shape.
      return { kind: "error", message: formatError(err) };
    } finally {
      // Ownership-checked release — a concurrently started export may have
      // installed ITS token; blindly nulling would strand its Stop button.
      if (localExportCancelRef.current === cancelToken) localExportCancelRef.current = null;
    }
  }, []);

  const handleExport = useCallback(async () => {
    if (!metadata || !exportOpts.folder) return;

    // ─── Local-file branch ──────────────────────────────────────────
    // Drive the clip via mediabunny's Conversion API (demux + stream-
    // copy or WebCodecs re-encode, no ffmpeg subprocess). MP3 rides
    // Mp3OutputFormat (the mp3-encoder extension registered in main.tsx);
    // everything else writes MP4 — Conversion handles passthrough vs.
    // re-encode internally based on codec compatibility.
    if (sourceKind === "file") {
      if (!localFilePath) {
        pushNotification("error", "Local file missing", "Re-import the file and try again.");
        return;
      }

      const r = Math.max(1, Math.round(fps));
      const startSec = inFrames  != null ? inFrames  / r : null;
      const endSec   = outFrames != null ? outFrames / r : null;
      const safe = sanitizeFilename(exportOpts.filename);
      if (!safe) {
        pushNotification("error", "Filename is empty", "Pick a filename before exporting.");
        return;
      }
      const isAudioOnly = exportOpts.format === "audio";
      const destPath = `${exportOpts.folder}/${safe}.${isAudioOnly ? "mp3" : "mp4"}`;

      setErrorDetail(null);
      setResultPath(null);
      setProgress(0);
      setStatus("exporting");
      setExportPhase("loading");
      appendLog("info", "mediabunny",
        `Exporting local clip ${startSec != null && endSec != null ? `${startSec.toFixed(2)}s → ${endSec.toFixed(2)}s` : "full"} → ${destPath}`);

      const result = await runLocalClipExport({
        inputPath: localFilePath,
        startSeconds: startSec,
        endSeconds: endSec,
        format: isAudioOnly ? "audio-mp3" : "video-mp4",
        destPath,
        onProgress: setProgress,
      });

      if (result.kind === "cancelled") {
        setStatus("loaded");
        setExportPhase("idle"); // user cancel → idle, no error flash
        setProgress(0);
        appendLog("warn", "mediabunny", "Local export cancelled.");
        pushNotification("info", "Export cancelled", "");
        return;
      }
      if (result.kind === "unsupported") {
        // Future: fall back to a Rust ffmpeg-based local-clip command.
        // For now surface clearly so the user knows what happened.
        appendLog("err", "mediabunny", `Unsupported for mediabunny export: ${result.reason}`);
        setStatus("error");
        setExportPhase("error");
        setErrorDetail(result.reason);
        pushNotification("error", "Local export not supported",
          "This file's codecs aren't compatible with the in-browser exporter yet. ffmpeg fallback for local clips is on the roadmap.");
        return;
      }
      if (result.kind === "error") {
        setErrorDetail(result.message);
        appendLog("err", "mediabunny", result.message);
        setStatus("error");
        setExportPhase("error");
        pushNotification("error", "Local export failed", result.message);
        return;
      }

      setStatus("loaded");
      setExportPhase("success"); // local clip written → check flash
      setResultPath(destPath);
      setProgress(0);
      const filename = destPath.split("/").pop() ?? "Done.";
      appendLog("ok", "mediabunny",
        `Wrote ${(result.bytesWritten / 1_000_000).toFixed(1)} MB → ${destPath}`);
      pushNotification("success", "Clip exported", filename, destPath);
      notify("Clip exported", filename);

      // Add to recents.
      const m = metadataRef.current;
      if (m) {
        const dur = (endSec != null && startSec != null)
          ? secondsToTc(endSec - startSec, fps)
          : (m.duration != null ? secondsToTc(m.duration, fps) : "Full");
        const rc: RecentClip = {
          id: Math.random().toString(36).slice(2),
          title: m.title,
          path: destPath,
          dur,
          when: Date.now(),
          thumbnail: m.thumbnail,
        };
        setRecents((prev) => [rc, ...prev].slice(0, 6));
      }
      return;
    }

    setErrorDetail(null);
    setResultPath(null);
    setProgress(0);
    setStatus("exporting");
    setExportPhase("loading"); // success/error flash arrives via the clip-done event
    const hasRange = inFrames != null && outFrames != null;
    const label = hasRange
      ? `${exportOpts.inTc} → ${exportOpts.outTc}`
      : "full clip";
    appendLog(
      "info",
      "ffmpeg",
      `Exporting ${label} · ${exportOpts.format}${hasRange && exportOpts.format !== "audio" ? (exportOpts.reencode ? " · re-encode" : " · lossless cut") : ""}`,
    );
    try {
      const id = await invoke<string>("new_job_id");
      setJobId(id);
      // Attribute the Recent entry to THIS source now (see clipJobMetaRef) so a
      // source switch before clip-done can't stamp the new source's title on it.
      clipJobMetaRef.current = metadataRef.current
        ? { title: metadataRef.current.title, thumbnail: metadataRef.current.thumbnail }
        : null;
      // Marks may be null (full-clip export) — pass null through, the
      // backend skips --download-sections so yt-dlp just grabs the whole stream.
      const startStr = inFrames  != null ? framesToTc(inFrames,  fps) : null;
      const endStr   = outFrames != null ? framesToTc(outFrames, fps) : null;
      // create_clip is fire-and-forget (reports via the clip-done event), so a
      // frontend cookie-retry can't observe its failure — the backend owns the
      // cookie-fallback for the clip download (see spawn_video_clip).
      await invoke<string>("create_clip", {
        args: {
          url: metadata.webpage_url,
          start: startStr,
          end: endStr,
          fps,
          output_dir: exportOpts.folder,
          filename: sanitizeFilename(exportOpts.filename),
          job_id: id,
          format: exportOpts.format,
          reencode: exportOpts.reencode,
          captions: exportOpts.captions,
          cookies_browser: cookiesBrowserOrNone(),
        },
      });
    } catch (err) {
      // r51 / Vimeo-export bug: raw `String(err)` printed "[object Object]"
      // in both the canvas overlay AND the FFMPEG pipeline log because
      // the create_clip command now rejects with an AppError discriminated
      // union, not a string.
      const msg = formatError(err);
      setErrorDetail(msg);
      // Same rot check as the clip-done listener — create_clip can also
      // reject synchronously with yt-dlp's extractor error.
      classifyExtractorRot(msg);
      appendLog("err", "ffmpeg", msg);
      setStatus("error");
      setExportPhase("error"); // create_clip rejected synchronously → cross flash
    }
  }, [metadata, sourceKind, localFilePath, exportOpts, fps, inFrames, outFrames, runLocalClipExport, appendLog, pushNotification, classifyExtractorRot]);

  const handleReveal = useCallback(() => {
    if (!resultPath) return;
    invoke("reveal_in_finder", { path: resultPath }).catch((err) => appendLog("err", "reveal", formatError(err)));
  }, [resultPath, appendLog]);

  /**
   * Kick off ffmpeg playback-prep for a freshly probed (or fallback-
   * triggered) local file. Awaits the resolver attached by the
   * `playback-prep-done` listener; on success sets `playbackPath` so the
   * Monitor swaps the player. `seq` is the source generation captured at
   * the call site so stale completions are ignored.
   */
  const runPlaybackPrep = useCallback(async (
    inputPath: string,
    hasVideo: boolean,
    durationSeconds: number | null,
    seq: number,
  ) => {
    try {
      setPlaybackPrepBusy(true);
      setPlaybackPrepProgress(0);
      const jobId = await invoke<string>("new_job_id");
      setPlaybackPrepJobId(jobId);
      appendLog("info", "import", `Preparing playback copy (h264_videotoolbox)…`);
      const prepared = await new Promise<string>((resolve, reject) => {
        playbackPrepResolverRef.current = { resolve, reject };
        invoke("prepare_local_for_playback", {
          args: {
            input_path: inputPath,
            has_video: hasVideo,
            duration_seconds: durationSeconds,
            job_id: jobId,
          },
        }).catch((err) => {
          if (playbackPrepResolverRef.current) {
            playbackPrepResolverRef.current = null;
            reject(err);
          }
        });
      });
      if (sourceSeqRef.current !== seq) return;
      setPlaybackPath(prepared);
      // ── DO NOT clear webCodecsFallbackForImport here ─────────────────
      //
      // The earlier version of this code reset the flag with the comment
      // "the prep output is h264/aac MP4 — mediabunny CAN decode that".
      // That's true for sources that failed on the VIDEO codec (e.g. AV1
      // on a pre-M3 Mac — prep re-encodes to h264, MediaBunny is happy).
      // It is catastrophically wrong for sources that failed on the AUDIO
      // codec (the common case: AAC on macOS WKWebView). The current
      // prep pipeline always re-encodes audio to AAC, so an AAC-decode
      // failure becomes an infinite loop:
      //
      //   MediaBunny: "can't decode aac" → prep → prep done →
      //   clear flag → MediaBunny re-mounts on prep file →
      //   "can't decode aac" → prep → … (every ~2s forever)
      //
      // Until the prep pipeline grows codec-aware output (re-encode audio
      // to MP3/opus when the WebCodecs fallback was triggered by an audio
      // failure), the safe rule is: if MediaBunny said no, trust it for
      // the rest of this import. Frame-accurate scrubbing via the prep
      // file would be nice for the AV1-style case but isn't worth the
      // loop risk for the AAC-style case.
      appendLog("ok", "import", `Playback copy ready → ${prepared}`);
    } catch (err) {
      if (sourceSeqRef.current !== seq) return;
      const msg = formatError(err);
      if (msg.includes("Source changed")) return;
      if (isMissingCommandError(err)) {
        const hint = staleBinaryMessage("prepare_local_for_playback");
        appendLog("err", "import", hint);
        pushNotification("error", "Rust backend out of date", hint);
      } else if (msg.includes("Cancelled") || msg === "Error: Cancelled") {
        appendLog("warn", "import", "Playback prep cancelled by user");
      } else {
        appendLog("warn", "import", `Playback prep failed, using original: ${msg}`);
      }
      setPlaybackPath(null);
    } finally {
      if (sourceSeqRef.current === seq) {
        setPlaybackPrepBusy(false);
        setPlaybackPrepJobId(null);
        setPlaybackPrepProgress(0);
      }
    }
  }, [appendLog, pushNotification]);

  // Load a local file by absolute path — the import core, shared by the
  // file-picker import and the Review version switcher (which loads a chosen
  // version's file straight into the existing player; A/B toggle compare).
  /** Import a local file. Resolves to null on success (or a superseded
   *  load), or the failure — the display string plus the typed AppError
   *  kind when the backend provided one, so callers that need to react to
   *  a failed load (e.g. stale recent-source pruning on NotFound) can
   *  branch on the kind instead of matching prose; the error UI itself is
   *  fully handled in here. */
  const loadLocalPath = useCallback(async (
    picked: string,
    // When an explicit transcript will be attached by the caller (Library
    // transcript-shelf open), skip the newest-transcript auto-loader so the
    // user's chosen entry wins the race instead of the auto-loaded one.
    skipAutoTranscript = false,
  ): Promise<{ message: string; kind: AppError["kind"] | null } | null> => {
    try {
      // Loading a local source belongs in the Clip view — surface it so a
      // drop / File-menu import / recent open from the Library is visible.
      setActiveView("clip");
      resetForNewSource();
      const seq = ++sourceSeqRef.current;
      setStatus("fetching");
      appendLog("info", "import", `Probing local file: ${picked}`);

      const lf = await invoke<LocalFileMeta>("probe_local_file", { path: picked });
      if (sourceSeqRef.current !== seq) return null;

      // Adapt the local file shape to the existing Metadata so the rest of
      // the UI (sidebar, monitor, settings) can stay agnostic. webpage_url
      // is set to a file:// marker so URL-keyed paths know to bail out.
      const m: Metadata = {
        title: lf.filename,
        duration: lf.duration,
        thumbnail: null,
        uploader: lf.has_video ? "Local video" : "Local audio",
        upload_date: null,
        view_count: null,
        webpage_url: `file://${lf.path}`,
        width: lf.width,
        height: lf.height,
        fps: lf.fps,
        vcodec: lf.vcodec,
        acodec: lf.acodec,
        ext: lf.filename.split(".").pop() ?? null,
        has_subs: false,
      };
      setMetadata(m);

      // Fire-and-forget thumbnail extraction — fills in the blank sidebar
      // square without blocking the rest of the import.
      //
      // Two paths, mediabunny preferred (no ffmpeg subprocess):
      //   1. extractPosterBlob → object URL → set as data thumbnail (a chosen
      //      poster time, else the representative frame — never a black fade)
      //   2. generate_local_thumbnail (ffmpeg) → asset:// URL (legacy
      //      fallback for codecs WebCodecs can't decode). Has its own
      //      hash-based cache so re-imports stay instant.
      if (lf.has_video) {
        (async () => {
          // Respect a user-chosen poster; otherwise the representative frame
          // (extractPosterBlob skips black intro fades) — never frame 0.
          const chosen = chosenPosterFor(lf.path);
          try {
            // Step 1: try mediabunny if the user has it enabled.
            const blob = defaults.useWebCodecsDecoder
              ? await extractPosterBlob(lf.path, { atSeconds: chosen ?? undefined, maxWidth: 640, quality: 0.85 })
              : null;
            if (blob) {
              if (sourceSeqRef.current !== seq) return;
              // Object URLs are auto-revoked when the page unloads. For
              // a thumbnail that lives for the session this is fine; the
              // small leak (one URL per import) is bounded by recents
              // and gets purged on app close.
              const objectUrl = URL.createObjectURL(blob);
              setMetadata((prev) => (prev ? { ...prev, thumbnail: objectUrl } : prev));
              return;
            }
            // Step 2: ffmpeg fallback (legacy path).
            const thumbPath = await invoke<string>("generate_local_thumbnail", {
              args: { input_path: lf.path, duration_seconds: lf.duration, time_seconds: chosen ?? null },
            });
            if (sourceSeqRef.current !== seq) return;
            const { convertFileSrc } = await import("@tauri-apps/api/core");
            setMetadata((prev) => (prev ? { ...prev, thumbnail: convertFileSrc(thumbPath) } : prev));
          } catch (err) {
            if (sourceSeqRef.current !== seq) return;
            appendLog("warn", "import", `Thumbnail generation failed: ${formatError(err)}`);
          }
        })();
      }
      setSourceKind("file");
      setLocalFilePath(lf.path);
      setLocalFileSize(lf.size_bytes ?? null);
      setUrl("");
      publishPlayheadFrames(0);
      setInFrames(null);
      setOutFrames(null);
      setExportOpts((prev) => ({
        ...prev,
        folder: prev.folder ?? defaults.folder,
        // Audio→1080 reset on import is intentional even though MP3
        // export now works for local files: if the user was on Audio
        // for a YouTube extraction and now imports a video file, video
        // is overwhelmingly the more likely target. They can click MP3
        // back on if they actually want audio-only.
        format: prev.format === "audio" ? "1080" : prev.format,
        filename:
          prev.filename && prev.filename !== "clip"
            ? prev.filename
            : suggestFilename(lf.filename.replace(/\.[^.]+$/, "")),
      }));
      appendLog(
        "ok",
        "import",
        `${lf.has_video ? `${lf.width ?? "?"}×${lf.height ?? "?"} · ${lf.fps ?? "?"} fps · ${lf.vcodec ?? "?"} · ` : ""}${
          lf.acodec ?? "no audio"
        } · ${lf.duration?.toFixed(1) ?? "?"}s`
      );
      // Auto-load any prior transcript we generated for this exact file
      // path. Silent miss — first-time imports proceed normally. seq-guarded
      // so a source switch mid-probe can't attach this file's transcript to
      // the next source. Skipped when the caller will attach an explicit one.
      if (!skipAutoTranscript) void tryAutoLoadTranscript({ sourcePath: picked }, seq);
      setStatus("loaded");
      // Probe succeeded → the import is a successful load; record it.
      recordRecentSource({
        kind: "file",
        value: lf.path,
        title: lf.filename,
        durationSeconds: lf.duration ?? undefined,
      });

      // ─── Playback prep ─────────────────────────────────────────────
      // WKWebView often can't decode arbitrary MP4s (HEVC, High-10, missing
      // faststart, etc.) — symptom is a black canvas while the transport
      // counter ticks. We always normalise through ffmpeg into a known-good
      // H.264 baseline-equivalent + yuv420p + faststart file. Original is
      // kept for transcribe/export.
      //
      // ─── Smart playback path selection ─────────────────────────────
      // Pick the cheapest viable strategy based on the codecs we just
      // probed. The expensive option (full transcode) is reserved for
      // codecs WKWebView genuinely can't handle.
      //
      // What Safari/WKWebView decodes natively in <video> (2026):
      //   • Video: H.264 (all Macs), HEVC (most modern Macs), AV1 (M3+ only)
      //   • Audio: AAC, MP3 in MP4 container; Opus in WebM/Ogg ONLY
      // See: https://webkit.org/blog/16574/webkit-features-in-safari-18-4/
      //
      // Strategy (revised r107): MEDIABUNNY-FIRST for local files. The old
      // r93 native-first short-circuit (h264/aac → play the original via a
      // native <video src="asset://…">) proved UNRELIABLE — WKWebView's media
      // element hangs on large local originals ("duration 0.0s", black canvas,
      // never loads) and often doesn't even fire an `error` event, so it can't
      // be caught and recovered. MediaBunnyPlayer instead reads the file via
      // a CustomSource (native byte-range reads, r107) and decodes with
      // WebCodecs — which on Safari 26 covers h264/hevc/av1/vp9 + aac/mp3/opus
      // and works regardless of file size. So we probe mediabunny FIRST; only
      // when WebCodecs genuinely can't decode do we ffmpeg-transcode to a
      // small normalised cache copy and play THAT via native <video> (small
      // copies load fine over asset://).
      //
      // What WKWebView/WebCodecs decodes (2026): H.264 (all Macs), HEVC (most),
      // AV1 (M3+); AAC/MP3/Opus audio (Safari 26 has the WebCodecs AudioDecoder).
      const vc = (lf.vcodec ?? "").toLowerCase();
      const ac = (lf.acodec ?? "").toLowerCase();
      const videoNative = !lf.has_video || vc.startsWith("h264") || vc.startsWith("avc");
      const audioNative = !lf.has_audio || ac.startsWith("aac") || ac.startsWith("mp3");
      const ext = (lf.filename.split(".").pop() ?? "").toLowerCase();
      const containerOk = lf.has_video
        ? ["mp4", "m4v", "mov"].includes(ext)
        : ["mp3", "m4a", "aac", "wav", "mp4", "m4v", "mov"].includes(ext);

      // Probe whether WebCodecs (+ our registered WASM decoders) can decode
      // this file IN-APP. If so, play the original directly via MediaBunnyPlayer
      // with NO ffmpeg transcode — the reliable path for any local file.
      const canMb = await canMediabunnyDecode(lf.path);
      if (sourceSeqRef.current !== seq) return null;
      if (canMb) {
        setLocalPlayer("mediabunny");
        appendLog("ok", "import",
          `In-app decode via mediabunny (${vc || "?"} / ${ac || "?"}) — no transcode.`);
        return null;
      }

      // Mediabunny can't decode this file here (e.g. a codec WebCodecs lacks
      // and we don't polyfill). Fall back to the ffmpeg-prep + <video> path.
      setLocalPlayer("native");

      // Surface what we're transcoding and why so the user understands the wait.
      const reasonParts: string[] = [];
      if (!videoNative) reasonParts.push(`video ${vc || "?"} → h264`);
      if (!audioNative) reasonParts.push(`audio ${ac || "?"} → aac`);
      if (!containerOk)  reasonParts.push(`container .${ext} → .mp4`);
      appendLog("info", "import",
        `Transcoding for playback: ${reasonParts.join(", ")}.`);
      await runPlaybackPrep(lf.path, lf.has_video, lf.duration, seq);
      return null;
    } catch (err) {
      const msg = formatError(err);
      setErrorDetail(msg);
      appendLog("err", "import", msg);
      setStatus("error");
      return { message: msg, kind: isAppError(err) ? err.kind : null };
    }
  }, [appendLog, defaults.folder, defaults.useWebCodecsDecoder, resetForNewSource, runPlaybackPrep, recordRecentSource, setActiveView]);

  const handleImportFile = useCallback(async () => {
    const picked = await import("@tauri-apps/plugin-dialog").then((m) =>
      m.open({
        multiple: false,
        directory: false,
        filters: [
          { name: "Video", extensions: VIDEO_EXTENSIONS },
          { name: "Audio", extensions: AUDIO_EXTENSIONS },
          { name: "All", extensions: ["*"] },
        ],
      })
    );
    if (typeof picked === "string") await loadLocalPath(picked);
  }, [loadLocalPath]);

  // Re-open a clip from the review history popover — local path via the import
  // core, a web source via the URL fetch. Its notes load automatically (the
  // fingerprint / URL resolves to the same review).
  const handleOpenReviewSource = useCallback((path: string) => {
    if (/^https?:\/\//i.test(path)) { setUrl(path); void handleFetch(path); }
    else void loadLocalPath(path);
  }, [handleFetch, loadLocalPath]);

  // Open a recent source through the SAME handlers as paste/import — no
  // parallel loading path. Staleness choice for file recents: auto-remove on
  // confirmed not-found. probe_local_file existence-checks the path before
  // touching ffmpeg and rejects with a typed AppError::NotFound, which
  // loadLocalPath surfaces as `kind` — so we branch on that, not on message
  // prose. Any other failure (codec, ffmpeg, permissions) keeps the entry
  // since the file may still be perfectly loadable later. The normal error UI
  // (Monitor overlay + pipeline log) still fires from loadLocalPath itself.
  const handleOpenRecentSource = useCallback((entry: RecentSource) => {
    if (entry.kind === "url") {
      setUrl(entry.value);
      void handleFetch(entry.value);
      return;
    }
    void (async () => {
      const err = await loadLocalPath(entry.value);
      if (err?.kind === "NotFound") {
        setRecentSources((prev) => removeRecent(prev, entry.value));
        pushNotification("info", "Removed from recents",
          `"${entry.title}" no longer exists at its saved location.`);
      }
    })();
  }, [handleFetch, loadLocalPath, pushNotification]);

  const handleRemoveRecentSource = useCallback((value: string) => {
    setRecentSources((prev) => removeRecent(prev, value));
  }, []);

  const handleClearRecentSources = useCallback(() => {
    setRecentSources([]);
  }, []);

  const handleStop = useCallback(async () => {
    const ids = [jobId, transcriptJobId, playbackPrepJobId].filter((x): x is string => !!x);
    const hasLocalExport = !!localExportCancelRef.current;
    const hadPlaybackPrep = !!playbackPrepJobId;
    const webDownloading = webPlayback.downloading;
    if (ids.length === 0 && !hasLocalExport && !webDownloading) return;
    appendLog("warn", "control",
      `Stopping ${ids.length + (hasLocalExport ? 1 : 0) + (webDownloading ? 1 : 0)} job(s)…`);
    // Cancel an in-flight web-preview download (the hook SIGKILLs its yt-dlp
    // job + resets the machine). No-op for streaming/cached/local.
    if (webDownloading) stopWebPlayback();
    // Flip the cancel-token for the in-browser mediabunny export — its
    // poll loop sees the flip within 150ms and triggers Conversion.cancel().
    if (hasLocalExport) localExportCancelRef.current!.cancelled = true;
    // r55: synchronously tear down playback-prep UI state instead of
    // waiting on the Rust round-trip + the playback-prep-done event.
    // Before this, the user clicked Stop, the spinner kept spinning, and
    // buffered stderr lines from yt-dlp could keep appending to the
    // pipeline log for another second or two — making it look like the
    // cancel did nothing. The Rust `cancel_job` invoke still runs below
    // and SIGKILLs yt-dlp; this just makes the UI react immediately.
    if (hadPlaybackPrep) {
      if (playbackPrepResolverRef.current) {
        playbackPrepResolverRef.current.reject(new Error("Cancelled"));
        playbackPrepResolverRef.current = null;
      }
      setPlaybackPrepBusy(false);
      setPlaybackPrepJobId(null);
      setPlaybackPrepProgress(0);
    }
    for (const id of ids) {
      try {
        await invoke<boolean>("cancel_job", { jobId: id });
      } catch (err) {
        appendLog("err", "control", `Cancel failed: ${formatError(err)}`);
      }
    }
  }, [jobId, transcriptJobId, playbackPrepJobId, appendLog, webPlayback.downloading, stopWebPlayback]);

  /** Add the current active selection as a new queued item, then clear marks.
   *  The item captures its SOURCE (web URL or local path), fps, and title at
   *  add time, so the queue survives source switches and mixed queues export
   *  each clip from the right place. */
  const handleAddToQueue = useCallback(() => {
    if (sourceKind === "file" && !localFilePath) {
      pushNotification("error", "Local file missing", "Re-import the file and try again.");
      return;
    }
    if (sourceKind !== "file" && !metadata?.webpage_url) {
      pushNotification("info", "Load a source first",
        "Fetch a URL or import a file, then mark the section you want to queue.");
      return;
    }
    if (inFrames == null || outFrames == null) {
      pushNotification("info", "Set Mark in and Mark out first",
        "Use the I and O keys to mark the section you want to queue.");
      return;
    }
    if (outFrames <= inFrames) {
      pushNotification("error", "Invalid range", "Mark out must be after Mark in.");
      return;
    }
    const baseName = sanitizeFilename(exportOpts.filename || "clip");
    // Bump until unique WITHIN the queue — a bare length+1 collides after a
    // remove-then-add (clip-1, clip-2; remove clip-1; add → length+1 = 2 →
    // another clip-2) and Export All would silently overwrite the first file.
    const nameFor = (n: number) => baseName === "clip" ? `clip-${n}` : `${baseName}-${n}`;
    let nextIndex = clipQueueRef.current.length + 1;
    while (clipQueueRef.current.some((c) => c.filename === nameFor(nextIndex))) nextIndex++;
    const source: QueueSource = sourceKind === "file"
      ? { kind: "file", path: localFilePath! }
      : { kind: "web", url: metadata!.webpage_url };
    const item: QueuedClip = {
      id: Math.random().toString(36).slice(2),
      source,
      fps,
      title: metadata?.title ?? nameFor(nextIndex),
      thumbnail: metadata?.thumbnail ?? null,
      inFrames,
      outFrames,
      filename: nameFor(nextIndex),
      format: exportOpts.format,
      // reencode/captions are yt-dlp features — meaningless for the
      // mediabunny local path, so file items pin them off.
      reencode: sourceKind === "file" ? false : exportOpts.reencode,
      captions: sourceKind === "file" ? false : exportOpts.captions,
      status: "queued",
    };
    setClipQueue((prev) => [...prev, item]);
    // Queueing consumes the selection — record the clear so ⌘Z restores the
    // marks (the queued item itself stays put; queue ops aren't undoable).
    pushMarksUndo("clear marks", inFrames, outFrames, null, null);
    setInFrames(null);
    setOutFrames(null);
    setQueueOpen(true);
    appendLog("info", "queue", `Queued ${item.filename} (${framesToTc(item.inFrames, fps)} → ${framesToTc(item.outFrames, fps)})`);
  }, [sourceKind, localFilePath, metadata, inFrames, outFrames, fps, exportOpts.filename, exportOpts.format, exportOpts.reencode, exportOpts.captions, appendLog, pushNotification, pushMarksUndo]);

  const handleQueueRemove = useCallback((id: string) => {
    setClipQueue((prev) => prev.filter((c) => c.id !== id));
  }, []);

  /** Rename one queued clip (double-click in the drawer). Sanitizes; empty →
   *  no-op; a collision with a sibling bumps a numeric suffix until unique so
   *  Export All can't overwrite one file with another. */
  const handleQueueRename = useCallback((id: string, name: string) => {
    const base = sanitizeFilename(name);
    if (!base) return;
    setClipQueue((prev) => {
      const taken = new Set(prev.filter((c) => c.id !== id).map((c) => c.filename));
      let next = base;
      let n = 2;
      while (taken.has(next)) next = `${base}-${n++}`;
      return prev.map((c) => c.id === id ? { ...c, filename: next } : c);
    });
  }, []);

  /** Bulk rename: every QUEUED item becomes base-1..N in queue order.
   *  Running/done/error items keep their names — their files may already
   *  exist on disk under them. */
  const handleQueueRenameAll = useCallback((rawBase: string) => {
    const base = sanitizeFilename(rawBase);
    if (!base) return;
    setClipQueue((prev) => {
      let n = 1;
      return prev.map((c) => c.status === "queued" ? { ...c, filename: `${base}-${n++}` } : c);
    });
  }, []);

  const handleQueueClearAll = useCallback(() => {
    setClipQueue([]);
  }, []);

  /** Run every "queued" item sequentially — web items through create_clip
   *  (yt-dlp/ffmpeg, per-item cookie retry), local items through the shared
   *  mediabunny core. Each item carries its own source + fps, so the queue
   *  is independent of whatever is currently loaded. */
  const handleExportQueue = useCallback(async () => {
    if (!exportOpts.folder) return;
    if (queueRunning) return;
    // A single local export owns the shared cancel token — running the queue
    // concurrently would clobber it and strand the Stop button for both.
    if (localExportCancelRef.current) {
      pushNotification("info", "Export in progress", "Wait for the current export to finish before running the queue.");
      return;
    }
    const eligible = clipQueueRef.current.filter((c) => c.status === "queued");
    if (eligible.length === 0) return;
    setQueueRunning(true);
    setStatus("exporting");
    setProgress(0);
    let okCount = 0;
    let failCount = 0;
    let cancelled = false;
    for (const item of eligible) {
      // Bail out if user cleared the queue mid-run.
      if (!clipQueueRef.current.some((c) => c.id === item.id)) continue;
      setClipQueue((prev) => prev.map((c) => c.id === item.id ? { ...c, status: "running" } : c));
      setProgress(0);
      const itemR = Math.max(1, Math.round(item.fps));
      appendLog("info", "queue", `Exporting ${item.filename} (${framesToTc(item.inFrames, item.fps)} → ${framesToTc(item.outFrames, item.fps)})…`);
      const pushQueueRecent = (path: string) => {
        const rc: RecentClip = {
          id: Math.random().toString(36).slice(2),
          title: item.title,
          path,
          dur: secondsToTc((item.outFrames - item.inFrames) / itemR, item.fps),
          when: Date.now(),
          thumbnail: item.thumbnail,
        };
        setRecents((prev) => [rc, ...prev].slice(0, 6));
      };

      // ── Local item → in-browser mediabunny export ──────────────────
      if (item.source.kind === "file") {
        const isAudio = item.format === "audio";
        const destPath = `${exportOpts.folder}/${item.filename}.${isAudio ? "mp3" : "mp4"}`;
        const result = await runLocalClipExport({
          inputPath: item.source.path,
          startSeconds: item.inFrames / itemR,
          endSeconds: item.outFrames / itemR,
          format: isAudio ? "audio-mp3" : "video-mp4",
          destPath,
          onProgress: setProgress,
        });
        if (result.kind === "cancelled") {
          cancelled = true;
          setClipQueue((prev) => prev.map((c) => c.id === item.id ? { ...c, status: "queued" } : c));
          break;
        }
        if (result.kind === "ok") {
          setClipQueue((prev) => prev.map((c) => c.id === item.id ? { ...c, status: "done", path: destPath, error: undefined } : c));
          appendLog("ok", "mediabunny", `Wrote ${(result.bytesWritten / 1_000_000).toFixed(1)} MB → ${destPath}`);
          pushQueueRecent(destPath);
          okCount++;
        } else {
          // "unsupported" and "error" both land here — there is no ffmpeg
          // fallback for local clips (mirrors the single-export behavior).
          const msg = result.kind === "unsupported" ? result.reason : result.message;
          setClipQueue((prev) => prev.map((c) => c.id === item.id ? { ...c, status: "error", error: msg } : c));
          appendLog("err", "mediabunny", msg);
          failCount++;
        }
        continue;
      }

      // ── Web item → create_clip (yt-dlp/ffmpeg subprocess) ──────────
      const webUrl = item.source.url;
      // One clip attempt for a given cookie setting (fresh job id each time so
      // cancellation tracks the live attempt). Resolves via the queue done-event
      // resolver, or via the invoke's own rejection.
      const runClip = (cookies: string | undefined) =>
        new Promise<{ success: boolean; path?: string; error?: string }>((resolve) => {
          void (async () => {
            const jobId = await invoke<string>("new_job_id");
            setJobId(jobId);
            queueResolverRef.current = resolve;
            invoke("create_clip", {
              args: {
                url: webUrl,
                start: framesToTc(item.inFrames, item.fps),
                end: framesToTc(item.outFrames, item.fps),
                fps: item.fps,
                output_dir: exportOpts.folder,
                filename: item.filename,
                job_id: jobId,
                format: item.format,
                reencode: item.reencode,
                captions: item.captions,
                cookies_browser: cookies,
              },
            }).catch((err) => {
              if (queueResolverRef.current) {
                queueResolverRef.current = null;
                resolve({ success: false, error: formatError(err) });
              }
            });
          })();
        });
      let result = await runClip(cookiesBrowserOrNone());
      // Public social posts (LinkedIn…) break with auth cookies — retry public.
      if (
        !result.success &&
        cookiesBrowserOrNone() &&
        !(result.error ?? "").toLowerCase().includes("cancel")
      ) {
        appendLog("info", "queue", "create_clip failed with sign-in cookies — retrying without…");
        result = await runClip(undefined);
      }
      if (result.error === "Cancelled") {
        cancelled = true;
        setClipQueue((prev) => prev.map((c) => c.id === item.id ? { ...c, status: "queued" } : c));
        break;
      }
      setClipQueue((prev) => prev.map((c) => c.id === item.id ? {
        ...c,
        status: result.success ? "done" : "error",
        path: result.path,
        error: result.error,
      } : c));
      if (result.success) {
        okCount++;
        if (result.path) pushQueueRecent(result.path);
      } else {
        failCount++;
      }
    }
    setQueueRunning(false);
    // Restore status only if the queue still owns it — a source switch
    // mid-run (which cancels the current item) has already set "fetching"
    // and will complete its own loaded/error transition. And a stale queue
    // can export with no source loaded — don't fake "loaded" then.
    setStatus((prev) => prev === "exporting" ? (metadataRef.current ? "loaded" : "empty") : prev);
    setProgress(0);
    if (cancelled) {
      pushNotification("info", "Queue stopped", `${okCount} exported, ${failCount} failed, rest still queued.`);
    } else if (failCount === 0) {
      pushNotification("success", "Queue complete", `${okCount} ${okCount === 1 ? "clip" : "clips"} exported.`);
    } else {
      pushNotification("error", "Queue finished with errors", `${okCount} ok · ${failCount} failed.`);
    }
  }, [exportOpts.folder, queueRunning, runLocalClipExport, appendLog, pushNotification]);

  const handleSnapshot = useCallback(async () => {
    if (!metadata || snapshotBusy) return;
    const r = Math.max(1, Math.round(fps));
    // Action-time store read: grab the frame that's on screen when the user
    // clicks, not a closure value from the last App render.
    const playheadNow = getPlayheadFrames();
    const seconds = playheadNow / r;
    const base = sanitizeFilename(metadata.title || "frame");
    const tcLabel = framesToTc(playheadNow, fps).replace(/:/g, "");
    const defaultName = `${base}_${tcLabel}.jpg`;
    try {
      const dest = await saveDialog({
        defaultPath: exportOpts.folder ? `${exportOpts.folder}/${defaultName}` : defaultName,
        filters: [{ name: "Image", extensions: ["jpg", "jpeg", "png"] }],
      });
      if (!dest) return;
      setSnapshotBusy(true);
      appendLog("info", "snapshot", `Grabbing frame at ${framesToTc(playheadNow, fps)} (${seconds.toFixed(2)}s)…`);
      // Defensive cast — a stale dev server still has the old `extract_frame`
      // signature (returns void), which surfaces here as a null result and
      // the .width access would TypeError out. We treat any non-object
      // return as the legacy shape and skip the resolution log.
      // Branch on source:
      //   • Local file + mediabunny available    → in-browser frame grab (no subprocess)
      //   • Local file + mediabunny unavailable  → ffmpeg subprocess via extract_local_frame
      //   • YouTube / web URL                    → ffmpeg + yt-dlp via extract_frame
      //
      // The mediabunny path is preferred for local files because it
      // skips the ~200ms ffmpeg cold-start, runs entirely in-process,
      // and uses the file the MediaBunnyPlayer already has open when
      // present. Falls back to ffmpeg the moment WebCodecs can't decode
      // the codec or anything throws.
      let raw: unknown = null;
      if (sourceKind === "file" && localFilePath) {
        // Step 1: try the active player's exposed frame grab (zero file IO).
        const fromActive = await playerRef.current?.getFrameBlob?.(seconds).catch(() => null);
        // Step 2: try a fresh mediabunny pass on the original file.
        const blob = fromActive ?? (defaults.useWebCodecsDecoder
          ? await extractFrameAsBlob(localFilePath, seconds).catch(() => null)
          : null);
        if (blob) {
          // Marshal the blob to bytes and let Rust persist it. Avoids
          // pulling in @tauri-apps/plugin-fs + its capability scope for
          // a one-shot write. saveDialog already vetted the path is
          // writable by the user.
          const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
          await invoke("write_bytes_to_path", { path: dest, bytes });
          // Synthesise a result shape matching the ffmpeg path so the
          // success log + notification code below works uniformly.
          // Width/height come from probe metadata when available.
          raw = {
            path: dest,
            width: metadata.width,
            height: metadata.height,
            vcodec: metadata.vcodec,
            format_id: "mediabunny",
          };
          appendLog("info", "snapshot", "Using mediabunny (in-browser WebCodecs decode).");
        } else {
          // Fallback: ffmpeg sidecar. Slower but supports every codec.
          appendLog("info", "snapshot", "Mediabunny couldn't decode this codec — falling back to ffmpeg.");
          raw = await invoke("extract_local_frame", {
            args: {
              input_path: localFilePath,
              timestamp_seconds: seconds,
              dest,
            },
          });
        }
      } else {
        raw = await invokeWithCookieRetry("extract_frame", (cookies) => ({
          args: {
            url: metadata.webpage_url,
            timestamp_seconds: seconds,
            dest,
            cookies_browser: cookies,
          },
        }));
      }
      const result = (raw && typeof raw === "object" ? raw : {}) as {
        path?: string;
        width?: number | null;
        height?: number | null;
        vcodec?: string | null;
        format_id?: string | null;
      };
      const filename = dest.split("/").pop() ?? "Snapshot ready.";
      const resLabel = result.width && result.height
        ? `${result.width}×${result.height}`
        : null;
      const codecLabel = result.vcodec && result.vcodec !== "none" ? ` · ${result.vcodec}` : "";
      const fmtLabel = result.format_id ? ` · fmt ${result.format_id}` : "";
      appendLog("ok", "snapshot",
        resLabel ? `Saved ${resLabel}${codecLabel}${fmtLabel} → ${dest}` : `Saved → ${dest}`);
      const notifBody = resLabel ? `${filename} · ${resLabel}` : filename;
      notify("Frame saved", notifBody);
      pushNotification("success", "Frame saved", notifBody, dest);
    } catch (err) {
      const msg = isMissingCommandError(err)
        ? staleBinaryMessage("extract_frame")
        : formatError(err);
      appendLog("err", "snapshot", msg);
      notify("Snapshot failed", msg);
      pushNotification("error", "Snapshot failed", msg);
    } finally {
      setSnapshotBusy(false);
    }
  }, [metadata, sourceKind, localFilePath, snapshotBusy, fps, exportOpts.folder, defaults.useWebCodecsDecoder, appendLog, notify, pushNotification]);

  /**
   * Resolve the per-month subdirectory inside the transcript library
   * (creating it on disk if missing) and return the absolute path.
   * All transcript writers route through this so:
   *   - The library structure stays consistent (Library / YYYY-MM / …)
   *   - The user can find any transcript by date in Finder
   *   - The Rust commands keep their existing `output_dir` interface
   * Returns null when the library path isn't set yet (very first
   * post-install boot before the resolver effect lands) — caller
   * should fall back to a safe alternative.
   */
  const resolveTranscriptOutDir = useCallback(async (): Promise<string | null> => {
    const lib = defaults.transcriptLibrary;
    if (!lib) return null;
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const sub = `${lib}/${yyyy}-${mm}`;
    try {
      await invoke("ensure_dir_exists", { path: sub });
      return sub;
    } catch (e) {
      appendLog("warn", "transcripts", `Couldn't create ${sub}: ${e}. Falling back to library root.`);
      try {
        await invoke("ensure_dir_exists", { path: lib });
        return lib;
      } catch {
        return null;
      }
    }
  }, [defaults.transcriptLibrary, appendLog]);

  const handleGenerateTranscript = useCallback(async () => {
    if (!metadata) {
      setTranscriptState("error");
      setTranscriptError("Load a source URL first.");
      return;
    }
    // Web sources with no out-mark transcribe up to the source duration. If
    // the user clicks Transcribe during the optimistic-mount window (duration
    // not hydrated → durationFrames 0), start == end == 00:00:00:00 and the
    // backend rejects it with a baffling "Mark out must be after mark in".
    if (sourceKind !== "file" && outFrames == null && durationFrames === 0) {
      setTranscriptState("error");
      setTranscriptError(metadataLoading
        ? "Source info is still loading — try again in a moment."
        : "This source has no known duration — set an out-mark to transcribe a range.");
      return;
    }
    // Resolve the per-month transcript-library subdir. Falls back to
    // exportOpts.folder for the brief moment between first launch and
    // the library-default-resolver effect landing.
    const outDir = await resolveTranscriptOutDir() ?? exportOpts.folder;
    if (!outDir) {
      setTranscriptState("error");
      setTranscriptError("Transcript library isn't set up yet — open Settings → Transcription and pick a folder.");
      return;
    }
    // Engine gate — Parakeet needs its Core ML model on disk; Whisper needs
    // the selected ggml model. Either way, missing → bounce to Settings.
    const engine = defaults.transcriptionEngine;
    if (engine === "parakeet") {
      const ready = await invoke<boolean>("parakeet_model_downloaded").catch(() => false);
      if (!ready) {
        setTranscriptState("error");
        setTranscriptError("The Parakeet model isn't downloaded yet. Opening Settings → Transcription.");
        setSettingsInitialTab("transcription");
        setSettingsOpen(true);
        return;
      }
    } else if (!selectedModel?.downloaded) {
      setTranscriptState("error");
      setTranscriptError(`Whisper model "${defaults.whisperModel}" is not downloaded. Opening Settings → Transcription.`);
      setSettingsInitialTab("transcription");
      setSettingsOpen(true);
      return;
    }
    setTranscriptState("running");
    setTranscriptResolution(null); // clear any prior flash before a new run
    setTranscriptError(null);
    setTranscriptProgress(0);
    setTranscriptPhase(null); // backend emits "whisper"/"parakeet" then "diarize-*"
    const engineLabel = engine === "parakeet" ? "Parakeet" : (selectedModel?.name ?? "Whisper");
    const txChannel = engine === "parakeet" ? "parakeet" : "whisper";
    const srcLabel = sourceKind === "file" ? metadata.title : `${exportOpts.inTc || "00:00:00:00"} → ${exportOpts.outTc || "end"}`;
    appendLog("info", txChannel, `Transcribing ${srcLabel} with ${engineLabel}…`);
    try {
      const id = await invoke<string>("new_job_id");
      setTranscriptJobId(id);
      if (sourceKind === "file" && localFilePath) {
        // Two paths, mediabunny preferred:
        //   • mediabunny: in-browser audio decode → OfflineAudioContext
        //     resample to 16kHz mono → WAV bytes → whisper-cli on the
        //     pre-staged WAV. Skips the ffmpeg subprocess entirely for
        //     the audio extraction step.
        //   • ffmpeg fallback: existing transcribe_local_file which
        //     handles the ffmpeg subprocess + whisper-cli inline.
        // Parakeet runs only via transcribe_local_file (ffmpeg WAV); the
        // WebCodecs prepared-WAV fast-path is whisper-only.
        const wavBlob = (engine !== "parakeet" && defaults.useWebCodecsDecoder)
          ? await extractAudioAsWav16k(localFilePath).catch(() => null)
          : null;
        if (wavBlob) {
          appendLog("info", txChannel,
            `Audio extracted via mediabunny (${(wavBlob.size / 1_000_000).toFixed(1)} MB WAV) — skipping ffmpeg.`);
          const bytes = Array.from(new Uint8Array(await wavBlob.arrayBuffer()));
          await invoke<string>("transcribe_prepared_wav", {
            args: {
              wav_bytes: bytes,
              output_dir: outDir,
              filename: sanitizeFilename(exportOpts.filename || "transcript"),
              model_id: defaults.whisperModel,
              job_id: id,
              detect_speakers: defaults.detectSpeakers,
              expected_speakers: defaults.expectedSpeakers > 0 ? defaults.expectedSpeakers : null,
              language: defaults.transcriptionLanguage,
            },
          });
        } else {
          if (engine !== "parakeet") {
            appendLog("info", txChannel, "Mediabunny can't decode this audio codec — falling back to ffmpeg.");
          }
          await invoke<string>("transcribe_local_file", {
            args: {
              input_path: localFilePath,
              output_dir: outDir,
              filename: sanitizeFilename(exportOpts.filename || "transcript"),
              model_id: defaults.whisperModel,
              job_id: id,
              detect_speakers: defaults.detectSpeakers,
              expected_speakers: defaults.expectedSpeakers > 0 ? defaults.expectedSpeakers : null,
              engine,
              language: defaults.transcriptionLanguage,
            },
          });
        }
      } else {
        // YouTube source: existing 3-phase yt-dlp path.
        const dur = durationFrames > 0 ? durationFrames - 1 : 0;
        const startStr = inFrames  != null ? framesToTc(inFrames,  fps) : framesToTc(0, fps);
        const endStr   = outFrames != null ? framesToTc(outFrames, fps) : framesToTc(dur, fps);
        await invoke<string>("generate_transcript", {
          args: {
            url: metadata.webpage_url,
            start: startStr,
            end: endStr,
            fps,
            output_dir: outDir,
            filename: sanitizeFilename(exportOpts.filename || "transcript"),
            model_id: defaults.whisperModel,
            job_id: id,
            cookies_browser: cookiesBrowserOrNone(),
            detect_speakers: defaults.detectSpeakers,
            expected_speakers: defaults.expectedSpeakers > 0 ? defaults.expectedSpeakers : null,
            engine,
            language: defaults.transcriptionLanguage,
          },
        });
      }
    } catch (err) {
      const msg = formatError(err);
      setTranscriptState("error");
      setTranscriptError(msg);
      appendLog("err", txChannel, msg);
    }
  }, [metadata, metadataLoading, exportOpts, fps, selectedModel, defaults.whisperModel,
      defaults.transcriptionEngine, defaults.useWebCodecsDecoder,
      defaults.detectSpeakers, defaults.expectedSpeakers, defaults.transcriptionLanguage,
      appendLog, resolveTranscriptOutDir, localFilePath, sourceKind,
      durationFrames, inFrames, outFrames]);

  // Re-detect speakers WITHOUT re-transcribing: reuses the cached source audio
  // (web) or the local file + the EXISTING SRT, runs only the diarizer, and
  // merges fresh speaker labels in place. Seconds instead of a full Whisper
  // pass on a long source. Reuses the same transcript-* event listeners (set up
  // via setTranscriptJobId), so progress + reload-on-done are already handled.
  const handleRediarize = useCallback(async () => {
    const tx = activeTranscript;
    if (!tx) return;
    if (!metadata) { setTranscriptState("error"); setTranscriptError("Load a source first."); return; }
    const isFile = sourceKind === "file";
    const url = metadata.webpage_url ?? null;
    if (!isFile && !url) {
      setTranscriptState("error");
      setTranscriptError("No source to re-detect speakers against.");
      return;
    }
    setTranscriptState("running");
    setTranscriptResolution(null); // clear any prior flash before a new run
    setTranscriptError(null);
    setTranscriptProgress(0);
    setTranscriptPhase(null);
    appendLog("info", "diarize", "Re-detecting speakers (reusing the existing transcript)…");
    try {
      const id = await invoke<string>("new_job_id");
      setTranscriptJobId(id);
      await invoke<string>("re_diarize_transcript", {
        args: {
          transcript_path: tx.path,
          job_id: id,
          // Auto by default; only pass a count if the user set one this session.
          expected_speakers: defaults.expectedSpeakers > 0 ? defaults.expectedSpeakers : null,
          url: isFile ? null : url,
          input_path: isFile ? localFilePath : null,
        },
      });
    } catch (err) {
      const msg = formatError(err);
      setTranscriptState("error");
      setTranscriptError(msg);
      appendLog("err", "diarize", msg);
    }
  }, [activeTranscript, metadata, sourceKind, localFilePath, defaults.expectedSpeakers, appendLog]);

  // r84: "Fix accuracy" — manually re-time loose YouTube captions with Whisper.
  // YouTube auto-caption cue times are ASR-biased ~150–700ms late and variable
  // (the caption-sync research proved our clock is correct; the offset is in the
  // cue data). This re-derives word-accurate timing from the SAME cached audio
  // the player uses (start_time 0 → onset matches the heard speech), over the
  // FULL video (ignores in/out marks — captions cover the whole clip, unlike the
  // marked-range export transcript). The whisper-done handler swaps
  // activeTranscript origin "captions" → "whisper", so the banner self-dismisses
  // and captions snap into sync. Surfaced via the TranscriptViewer banner.
  const handleFixCaptionTiming = useCallback(async () => {
    if (!metadata?.webpage_url) return;
    // Full-range re-time needs a real duration — see handleGenerateTranscript's
    // identical guard (start == end would be rejected as a marks error).
    if (durationFrames === 0) {
      setTranscriptState("error");
      setTranscriptError(metadataLoading
        ? "Source info is still loading — try again in a moment."
        : "This source has no known duration — captions can't be re-timed.");
      return;
    }
    const outDir = await resolveTranscriptOutDir() ?? exportOpts.folder;
    if (!outDir) {
      // Must flip state to "error" too — the Sidebar only renders transcriptError
      // when transcriptState === "error" (matches handleGenerateTranscript).
      setTranscriptState("error");
      setTranscriptError("Transcript library isn't set up yet — open Settings → Transcription and pick a folder.");
      return;
    }
    // Engine gate — mirrors handleGenerateTranscript so re-timing works with
    // whichever engine is active (Parakeet has no Whisper model, so the old
    // Whisper-only check always bounced Parakeet users to Settings).
    const engine = defaults.transcriptionEngine;
    if (engine === "parakeet") {
      const ready = await invoke<boolean>("parakeet_model_downloaded").catch(() => false);
      if (!ready) {
        setTranscriptState("error");
        setTranscriptError("The Parakeet model isn't downloaded yet. Opening Settings → Transcription.");
        setSettingsInitialTab("transcription");
        setSettingsOpen(true);
        return;
      }
    } else if (!selectedModel?.downloaded) {
      setTranscriptState("error");
      setTranscriptError(`Whisper model "${defaults.whisperModel}" is not downloaded. Opening Settings → Transcription.`);
      setSettingsInitialTab("transcription");
      setSettingsOpen(true);
      return;
    }
    setTranscriptState("running");
    setTranscriptResolution(null); // clear any prior flash before a new run
    setTranscriptError(null);
    setTranscriptProgress(0);
    setTranscriptPhase(null);
    const engineLabel = engine === "parakeet" ? "Parakeet" : "Whisper";
    const txChannel = engine === "parakeet" ? "parakeet" : "whisper";
    appendLog("info", txChannel, `Re-transcribing for accurate caption timing with ${engineLabel} (reusing the cached audio)…`);
    try {
      const id = await invoke<string>("new_job_id");
      setTranscriptJobId(id);
      const dur = durationFrames > 0 ? durationFrames - 1 : 0;
      await invoke<string>("generate_transcript", {
        args: {
          url: metadata.webpage_url,
          start: framesToTc(0, fps),
          end: framesToTc(dur, fps),
          fps,
          output_dir: outDir,
          filename: sanitizeFilename(exportOpts.filename || "transcript"),
          model_id: defaults.whisperModel,
          engine,
          job_id: id,
          cookies_browser: cookiesBrowserOrNone(),
          detect_speakers: defaults.detectSpeakers,
          expected_speakers: defaults.expectedSpeakers > 0 ? defaults.expectedSpeakers : null,
          language: defaults.transcriptionLanguage,
        },
      });
    } catch (err) {
      setTranscriptState("error");
      setTranscriptError(formatError(err));
      appendLog("warn", txChannel, `Caption-timing fix failed (${formatError(err)}); keeping the existing captions.`);
    }
  }, [metadata, metadataLoading, exportOpts.folder, exportOpts.filename, resolveTranscriptOutDir, selectedModel,
      durationFrames, fps, defaults.whisperModel, defaults.transcriptionEngine, defaults.detectSpeakers,
      defaults.expectedSpeakers, defaults.transcriptionLanguage, appendLog]);

  const handleOpenTranscriptionSettings = useCallback(() => {
    setSettingsInitialTab("transcription");
    setSettingsOpen(true);
  }, []);

  // ── Transcript history wiring ───────────────────────────────────
  // Auto-load a prior transcript when the user re-opens a source
  // we've transcribed before. We verify the SRT still exists on disk
  // (via the bounded read command — it returns an error for missing
  // files which we catch). Done as a soft attempt: failure is silent
  // so importing a brand-new file feels exactly the same as it does
  // today.
  const tryAutoLoadTranscript = useCallback(async (input: {
    sourcePath?: string | null;
    sourceUrl?: string | null;
  }, seq: number) => {
    const entry = findForSource(input);
    if (!entry) return;
    try {
      // Probe existence/readability. Use the SAME 8 MB cap the viewer
      // reads with — read_text_file_capped *errors* when a file exceeds
      // the cap, so a tiny cap (the old 64 bytes) rejected every real
      // transcript with "File too large". We don't keep the result; the
      // viewer fetches the file itself when the path changes.
      await invoke<string>("read_text_file_capped", { path: entry.srtPath, maxBytes: 8 * 1024 * 1024 });
      // The probe is an awaited IPC disk read — if the user switched sources
      // meanwhile, attaching the OLD source's transcript to the NEW source
      // (and pulsing the Transcript tab open over it) would be wrong.
      if (sourceSeqRef.current !== seq) return;
      setActiveTranscript({
        path: entry.srtPath,
        origin: entry.origin === "captions" ? "captions"
              : entry.origin === "whisper"  ? "whisper"
              : "unknown",
      });
      setTranscriptArrivedTick((n) => n + 1);
      touchEntry(entry.id);
      appendLog("ok", "transcripts", `Auto-loaded prior transcript from ${entry.srtPath}`);
    } catch {
      // SRT was deleted or moved — leave activeTranscript null. The
      // user can re-generate or pick another from the history popover.
    }
  }, [appendLog]);

  const handleClearTranscript = useCallback(() => {
    setActiveTranscript(null);
  }, []);

  /**
   * Open a transcript file (.srt or .vtt) from anywhere on disk and
   * load it into the Transcript tab. Records it in history so it
   * shows up alongside generated ones. The source is recorded as
   * "unknown" (we don't know which producer made it) — the viewer
   * dropped the origin badge in r31 so that distinction isn't shown
   * anywhere user-facing anyway.
   *
   * Triggered from the empty-state Import button, the macOS File menu
   * (r42), AND a dropped .srt/.vtt (DropTarget) — the path core is
   * `loadTranscriptPath` so all three land in the same place.
   */
  const loadTranscriptPath = useCallback(async (picked: string) => {
    try {
      // The transcript lands in the Clip view's Transcript tab — surface that
      // view so a drop / File-menu import from the Library is visible.
      setActiveView("clip");
      // Probe — read_text_file_capped errors clearly if the file is
      // missing / too large. We don't load the bytes here; the viewer
      // will read them itself on the path change.
      await invoke<string>("read_text_file_capped", { path: picked, maxBytes: 8 * 1024 * 1024 });
      const title = picked.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "Imported transcript";
      recordTranscript({
        srtPath: picked,
        sourcePath: null,
        sourceUrl: null,
        title,
        origin: "unknown",
      });
      setActiveTranscript({ path: picked, origin: "unknown" });
      setTranscriptArrivedTick((n) => n + 1);
      appendLog("ok", "transcripts", `Imported transcript from ${picked}`);
    } catch (e) {
      pushNotification("error", "Couldn't open transcript", formatError(e));
    }
  }, [appendLog, pushNotification, setActiveView]);

  const handleImportTranscript = useCallback(async () => {
    const picked = await import("@tauri-apps/plugin-dialog").then((m) =>
      m.open({
        multiple: false,
        directory: false,
        filters: [{ name: "Transcript", extensions: TRANSCRIPT_EXTENSIONS }],
        title: "Import transcript",
      })
    );
    if (typeof picked !== "string" || !picked) return;
    await loadTranscriptPath(picked);
  }, [loadTranscriptPath]);

  const handleLoadFromHistory = useCallback(async (entry: TranscriptHistoryEntry) => {
    try {
      await invoke<string>("read_text_file_capped", { path: entry.srtPath, maxBytes: 8 * 1024 * 1024 });
      setActiveTranscript({
        path: entry.srtPath,
        origin: entry.origin === "captions" ? "captions"
              : entry.origin === "whisper"  ? "whisper"
              : "unknown",
      });
      setTranscriptArrivedTick((n) => n + 1);
      touchEntry(entry.id);
    } catch (e) {
      pushNotification("error", "Transcript file missing",
        `${entry.srtPath} was moved or deleted. Remove it from the history list to clean up.`);
    }
  }, [pushNotification]);

  // ====== Library (Home view) open-handlers ======
  // Every Library open switches to the Clip view first, then routes through
  // the SAME load cores as the toolbar/monitor surfaces (loadLocalPath /
  // handleFetch / handleOpenRecentSource) — no parallel load paths. The
  // Library owns its own scan/search state; App only supplies these levers.
  const handleLibraryOpenLocalPath = useCallback((path: string) => {
    setActiveView("clip");
    void loadLocalPath(path);
  }, [setActiveView, loadLocalPath]);

  const handleLibraryOpenRecent = useCallback((entry: RecentSource) => {
    setActiveView("clip");
    handleOpenRecentSource(entry);
  }, [setActiveView, handleOpenRecentSource]);

  // Transcript-shelf open: load the SOURCE through the existing handlers, then
  // attach THIS entry via the same handler the Transcript-tab history popover
  // uses. loadLocalPath is told to skip its newest-transcript auto-loader
  // (skipAutoTranscript) so it can't race and clobber the user's explicit
  // (possibly older) choice; handleFetch clears the transcript up front but
  // never auto-attaches for web sources, so no skip flag is needed there.
  const handleLibraryOpenTranscript = useCallback((entry: TranscriptHistoryEntry) => {
    setActiveView("clip");
    if (entry.sourcePath) void loadLocalPath(entry.sourcePath, true);
    else if (entry.sourceUrl) { setUrl(entry.sourceUrl); void handleFetch(entry.sourceUrl); }
    void handleLoadFromHistory(entry);
  }, [setActiveView, loadLocalPath, handleFetch, handleLoadFromHistory]);

  // Hero "Paste a URL" → the same focus lever as the File-menu "Open URL…".
  const handleSwitchToClip = useCallback((focusUrl?: boolean) => {
    setActiveView("clip");
    if (!focusUrl) return;
    setTimeout(() => {
      const el = document.querySelector<HTMLInputElement>(".cp-url input");
      el?.focus();
      el?.select();
    }, 0);
  }, [setActiveView]);

  /**
   * Trigger the FluidAudio Core ML model download via the
   * `saucebunny-diarize --prepare-models` sidecar flag. Wired to the
   * "Download speaker models" button in Settings → Transcription. The
   * `diarize-prepare-done` listener flips `diarizerReady` to true on
   * success so the Sidebar's "Detect speakers" affordance can label
   * itself "✓ Models cached".
   */
  const handlePrepareDiarizerModels = useCallback(async () => {
    if (diarizerPrepareState === "running") return;
    setDiarizerPrepareState("running");
    setDiarizerPrepareError(null);
    try {
      const id = await invoke<string>("new_job_id");
      setDiarizerPrepareJobId(id);
      await invoke<string>("prepare_diarizer_models", { jobId: id });
      // Resolution arrives via the diarize-prepare-done listener,
      // which flips state to "done" / "error" depending on the payload.
    } catch (e) {
      setDiarizerPrepareState("error");
      setDiarizerPrepareError(formatError(e));
    }
  }, [diarizerPrepareState]);

  const handleCancelDiarizerPrepare = useCallback(async () => {
    const id = diarizerPrepareJobIdRef.current;
    if (!id) return;
    try { await invoke("cancel_job", { jobId: id }); } catch { /* ignore */ }
  }, []);

  const handleClear = useCallback(() => {
    resetForNewSource();
    setStatus("empty");
    setExportOpts((prev) => ({
      ...prev,
      inTc: "",
      outTc: "",
      filename: "clip",
    }));
    setUrl("");
    setClipQueue([]);
    setQueueOpen(false);
  }, [resetForNewSource]);

  const handleDownloadCaptions = useCallback(async () => {
    if (!metadata) {
      setCaptionsState("error");
      setCaptionsError("Load a source URL first.");
      return;
    }
    // Transcripts route to the library (separate from clip exports).
    // Falls back to exportOpts.folder for users who customised before
    // the library system existed and haven't restarted yet.
    const outDir = await resolveTranscriptOutDir() ?? exportOpts.folder;
    if (!outDir) {
      setCaptionsState("error");
      setCaptionsError("Transcript library isn't set up yet — open Settings → Transcription and pick a folder.");
      return;
    }
    setCaptionsState("running");
    setCaptionsError(null);
    appendLog("info", "captions", "Requesting transcript from yt-dlp…");
    try {
      const id = await invoke<string>("new_job_id");
      setCaptionsJobId(id);
      // Plain invoke, no frontend cookie-retry wrapper: download_captions is
      // fire-and-forget (resolves at spawn, reports via captions-done), so a
      // wrapper could never observe the real failure. The BACKEND retries
      // without cookies inside its monitor task when the cookied attempt
      // writes no caption files.
      await invoke<string>("download_captions", {
        args: {
          url: metadata.webpage_url,
          output_dir: outDir,
          filename: sanitizeFilename(exportOpts.filename || "transcript"),
          job_id: id,
          cookies_browser: cookiesBrowserOrNone(),
          // Preferred caption locale = the transcription language. Auto →
          // omit (keeps the battle-tested English defaults); otherwise pass
          // the bare code — the backend adds base/regional forms itself
          // (caption_lang_prefs in download.rs).
          locale: defaults.transcriptionLanguage === "auto"
            ? undefined
            : defaults.transcriptionLanguage,
        },
      });
    } catch (err) {
      const msg = formatError(err);
      setCaptionsState("error");
      setCaptionsError(msg);
      appendLog("err", "captions", msg);
    }
    // Captions only needs the source URL + where to write the .srt — none
    // of the playback/transcription state matters here.
  }, [metadata, exportOpts.folder, exportOpts.filename, defaults.transcriptionLanguage, appendLog, resolveTranscriptOutDir]);

  // Captions are "active" (button green) only when they're actually on
  // SCREEN — toggled on AND a transcript is loaded to draw from. A bare
  // captionsOn flag with no transcript shows nothing, so it shouldn't read
  // as active.
  const captionsActive = captionsOn && !!activeTranscript;

  // The toggle operates on what the user SEES: live captions → turn off;
  // otherwise turn on and auto-fetch a transcript if we don't have one. Web
  // sources pull their own captions (fast, carries creator speaker labels);
  // we don't auto-run Whisper here (heavy multi-minute job) — just nudge.
  const onToggleCaptions = useCallback(() => {
    if (captionsActive) { setCaptionsOn(false); return; }
    setCaptionsOn(true);
    // Captions ride the single native <video> clock (audio + picture + captions
    // share it), so on-video captions track the audio you hear by construction.
    if (activeTranscript || captionsState === "running") return;
    if (sourceKind === "youtube" && metadata) {
      pushNotification("info", "Fetching captions…",
        "Grabbing this source's transcript so captions can show on the video.");
      void handleDownloadCaptions();
    } else if (sourceKind === "file") {
      pushNotification("info", "No transcript yet",
        "Generate a transcript (Transcribe) to show captions for this file.");
    }
  }, [captionsActive, activeTranscript, captionsState, sourceKind, metadata, pushNotification, handleDownloadCaptions]);

  // ── Pre-stage the source audio for Whisper (r74 → r76) ──────────────
  // For every streaming web source we download + cache the full audio track in
  // the background. Playback itself is NATIVE (the proxy-merged fMP4 carries the
  // audio, and the <video>'s currentTime tracks it — see MSEStreamPlayer), so
  // this cache is purely a HEAD START for transcription: it's source-keyed and
  // persistent, so when you hit Transcribe the audio is already on disk and the
  // Whisper transcript is clocked against the exact track you heard. See
  // download_audio_track / generate_transcript (source_audio_prefix) sharing.
  const audioCacheJobRef = useRef<string | null>(null);
  // Raw fs path of the cached audio-master track (webAudioCachedSrc holds only
  // the asset:// URL). Clear-cache passes this as an exclusion so it can't
  // delete the file the streaming clock is playing from.
  const webAudioCachedPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (!webStreaming || !activeSourceUrl) {
      webAudioCachedPathRef.current = null;
      setWebAudioCachedSrc(null);
      return;
    }
    if (webAudioCachedSrc) return; // already cached for this source
    let cancelled = false;
    const seq = sourceSeqRef.current;
    (async () => {
      try {
        const jobId = await invoke<string>("new_job_id");
        if (cancelled || sourceSeqRef.current !== seq) return;
        audioCacheJobRef.current = jobId;
        appendLog("info", "audio-cache", "Pre-caching the audio track for fast, aligned transcription…");
        const path = await invokeWithCookieRetry<string>("download_audio_track", (cookies) => ({
          args: { url: activeSourceUrl, job_id: jobId, cookies_browser: cookies },
        }));
        if (cancelled || sourceSeqRef.current !== seq) return;
        const { convertFileSrc } = await import("@tauri-apps/api/core");
        // Keep the RAW fs path too — Clear cache excludes the files the
        // current session is playing from, and it matches on raw paths.
        webAudioCachedPathRef.current = path;
        setWebAudioCachedSrc(convertFileSrc(path));
        appendLog("ok", "audio-cache", "Audio cached — Transcribe will be instant for this source.");
      } catch (err) {
        if (cancelled || sourceSeqRef.current !== seq) return;
        appendLog("warn", "audio-cache",
          `Audio pre-cache skipped (${formatError(err)}) — Transcribe will fetch it on demand.`);
      } finally {
        audioCacheJobRef.current = null;
      }
    })();
    return () => {
      cancelled = true;
      const j = audioCacheJobRef.current;
      if (j) { audioCacheJobRef.current = null; invoke("cancel_job", { jobId: j }).catch(() => { /* best-effort */ }); }
    };
  }, [webStreaming, activeSourceUrl, webAudioCachedSrc, appendLog]);

  const handleClearLogs = useCallback(() => setLogs([]), []);
  const handleCopyLogs = useCallback(() => {
    const text = logs.map((l) => `${l.ts} ${l.source.padEnd(8)} ${l.message}`).join("\n");
    navigator.clipboard.writeText(text).catch(() => { /* ignore */ });
  }, [logs]);

  // "Export diagnostics" (Pipeline panel) — saves a plain-text report the
  // user attaches to a bug report BY HAND: versions + build-id handshake,
  // the full settings snapshot, sidecar versions, and the recent pipeline
  // log. This is the no-telemetry answer to remote bug reports; assembly is
  // pure + unit-tested in lib/diagnostics.ts. Every piece is best-effort so
  // a dead backend still produces a (maximally useful) report.
  const handleExportDiagnostics = useCallback(async () => {
    try {
      const now = new Date();
      const path = await saveDialog({
        defaultPath: diagnosticsFilename(now),
        filters: [{ name: "Text", extensions: ["txt"] }],
      });
      if (!path) return; // user cancelled
      const appVersion = await getVersion().catch(() => "unknown");
      // Ask the live binary rather than reusing the startup check — the
      // report should reflect whatever is running at export time.
      const backendBuildId = await invoke<string>("get_backend_build_id")
        .catch((e) => `(unavailable: ${formatError(e)})`);
      const sidecars: { name: string; version: string }[] = [];
      try {
        // yt-dlp is the only sidecar with a version command today; the rest
        // are pinned by the build scripts and identified by the app version.
        const yt = await invoke<YtdlpStatus>("ytdlp_version");
        sidecars.push({
          name: "yt-dlp",
          version: `${yt.version}${yt.updated ? " (self-updated copy)" : " (bundled)"}`,
        });
      } catch { /* report is still useful without it */ }
      const report = buildDiagnosticsReport({
        appVersion,
        expectedBuildId: EXPECTED_BACKEND_BUILD_ID,
        backendBuildId,
        userAgent: navigator.userAgent,
        generatedAt: now,
        settings: { ...defaultsRef.current },
        sidecars,
        logLines: logs,
      });
      const bytes = Array.from(new TextEncoder().encode(report));
      await invoke("write_bytes_to_path", { path, bytes });
      pushNotification("success", "Diagnostics saved", "Attach this file to a bug report.");
    } catch (err) {
      pushNotification("error", "Diagnostics export failed", formatError(err));
    }
  }, [logs, pushNotification]);

  const handlePickRecent = useCallback((r: RecentClip) => {
    invoke("reveal_in_finder", { path: r.path }).catch(() => { /* ignore */ });
  }, []);

  /** Wipes the sidebar's Recent list. Files on disk are not touched. */
  const handleClearRecents = useCallback(() => {
    setRecents([]);
    appendLog("info", "control", "Cleared recent exports history.");
  }, [appendLog]);

  // ====== Transport ======
  // ── Variable-speed shuttle (NLE-grade J-K-L) ────────────────────────
  // rate: 0 = normal · >0 = fast-forward × · <0 = rewind ×. Each J/L press
  // walks the Premiere-style ladder (lib/shuttle.ts): 1-2-4-8× in the pressed
  // direction, opposite presses step back down, landing on +1 resumes REAL
  // playback. K+J / K+L nudge a single frame. Routed to the live player, which
  // honors it per-engine (MediaBunny does true smooth reverse; WebKit
  // fast-forwards natively + scans backward — see PlayerHandle).
  const shuttleRateRef = useRef(0);
  // Mirrored into state so the Monitor can render the "◀◀ 4×" badge.
  const [shuttleRate, setShuttleRate] = useState(0);
  // Physical K held? Turns the next J/L into a frame-step (set on keydown,
  // cleared on keyup/window-blur in the keyboard effect below).
  const kHeldRef = useRef(false);

  // ── Timecode entry HUD (type digits → snap playhead) ──
  // Raw digits typed so far; null = HUD closed. A bare number key opens it;
  // digits fill right-to-left into HH:MM:SS:FF (last two = frames), Return
  // snaps the playhead, Esc cancels. Mirrored into a ref so the window
  // keydown handler reads the live value without re-binding every keystroke.
  const [tcEntry, setTcEntry] = useState<string | null>(null);
  const tcEntryRef = useRef<string | null>(null);
  useEffect(() => { tcEntryRef.current = tcEntry; }, [tcEntry]);
  const applyShuttle = useCallback((rate: number) => {
    shuttleRateRef.current = rate;
    setShuttleRate(rate);
    playerRef.current?.setShuttle?.(rate);
  }, []);
  const exitShuttle = useCallback(() => {
    if (shuttleRateRef.current !== 0) applyShuttle(0);
  }, [applyShuttle]);

  const onPlayToggle = useCallback(() => {
    // K / Space / the play button while shuttling → just stop the shuttle.
    if (shuttleRateRef.current !== 0) { applyShuttle(0); return; }
    if (status !== "loaded" && status !== "exporting" && status !== "success") return;
    const p = playerRef.current;
    if (p && p.isReady()) {
      if (isPlaying) p.pause();
      else p.play();
    } else {
      setIsPlaying((x) => !x);
    }
  }, [status, isPlaying, applyShuttle]);

  const onStep = useCallback((delta: number) => {
    exitShuttle();
    const p = playerRef.current;
    const r = Math.max(1, Math.round(fps));
    // Read the live position from the store (action-time read — never a stale
    // closure), compute, THEN write. Also keeps the seek side effect out of a
    // React updater, where StrictMode's double-invoke used to double-seek.
    const next = Math.max(0, Math.min(Math.max(0, durationFrames - 1), getPlayheadFrames() + delta));
    if (p && p.isReady()) {
      p.pause();
      p.seekTo(next / r);
    }
    publishPlayheadFrames(next);
  }, [durationFrames, fps, exitShuttle]);

  const seekBySeconds = useCallback((deltaSec: number) => {
    exitShuttle();
    const r = Math.max(1, Math.round(fps));
    const p = playerRef.current;
    const currentSec = p?.isReady() ? (p.getCurrentTime?.() ?? 0) : getPlayheadFrames() / r;
    const targetSec = Math.max(0, Math.min((durationFrames - 1) / r, currentSec + deltaSec));
    publishPlayheadFrames(Math.floor(targetSec * r));
    if (p?.isReady()) p.seekTo(targetSec);
  }, [fps, durationFrames, exitShuttle]);

  // Max |shuttle rate| for the ACTIVE player. The MSE web stream caps at 4× —
  // reverse scans only the buffered window and forward playbackRate beyond
  // that outruns the proxy's fMP4 remux. Local/downloaded playback takes 8×.
  // Mirrors Monitor's player choice: MSE mounts only for an http(s) web
  // stream URL (the download-fallback cachePath is a local file → 8×).
  const playerShuttleCap = useCallback(() => {
    const webSrc = webPlayback.cachePath ?? webPlayback.streamUrl;
    const usesMse = !(sourceKind === "file" && localFilePath)
      && !!webSrc && /^https?:\/\//i.test(webSrc);
    return usesMse ? 4 : 8;
  }, [sourceKind, localFilePath, webPlayback.cachePath, webPlayback.streamUrl]);

  /**
   * J/L transport press. K held → single-frame nudge (the K+J / K+L editor
   * convention); otherwise walk the shuttle ladder in `direction`. Landing on
   * +1 exits the shuttle into REAL playback (native clock + audio).
   */
  const shuttleStep = useCallback((direction: 1 | -1, isRepeat = false) => {
    if (kHeldRef.current) { onStep(direction); return; } // frame-step (pauses + kills shuttle)
    // Holding J/L auto-repeats the keydown — hold sustains the current rate;
    // only discrete presses climb the ladder (matches Premiere/Resolve).
    if (isRepeat) return;
    const p = playerRef.current;
    const playing = p?.isReady() ? p.isPlaying() : isPlaying;
    const cur = shuttleRateRef.current !== 0 ? shuttleRateRef.current : (playing ? 1 : 0);
    const next = nextShuttleRate(cur, direction, playerShuttleCap());
    if (next === 1) {
      // +1 = normal play, not a 1× shuttle — same start path onPlayToggle uses.
      applyShuttle(0);
      if (p?.isReady()) p.play();
      else setIsPlaying(true);
      return;
    }
    applyShuttle(next);
  }, [isPlaying, onStep, applyShuttle, playerShuttleCap]);

  // The players self-terminate a shuttle at the media bounds (reverse hits 0 /
  // forward hits the end) without a callback; watch the playhead STORE while a
  // shuttle is active so the badge clears and the next J/L starts from a clean
  // slate. A subscription, not state — the per-tick edge check must not
  // re-render App.
  useEffect(() => {
    if (shuttleRate === 0 || durationFrames <= 0) return;
    const check = () => {
      const f = getPlayheadFrames();
      if ((shuttleRate < 0 && f <= 0)
       || (shuttleRate > 1 && f >= durationFrames - 1)) applyShuttle(0);
    };
    check(); // the edge may already be behind us the moment the shuttle starts
    return subscribePlayhead(check);
  }, [shuttleRate, durationFrames, applyShuttle]);

  const onMarkIn = useCallback(() => {
    const r = Math.max(1, Math.round(fps));
    // Action-time store read: mark the frame on screen when the key lands.
    const f = getPlayheadFrames();
    // If an out mark already exists and the playhead is past it, bump out a frame.
    const next = (outFrames != null && f >= outFrames)
      ? Math.max(0, outFrames - r)
      : f;
    if (next !== inFrames) pushMarksUndo("mark in", inFrames, outFrames, next, outFrames);
    setInFrames(next);
  }, [inFrames, outFrames, fps, pushMarksUndo]);

  const onMarkOut = useCallback(() => {
    const r = Math.max(1, Math.round(fps));
    // Action-time store read: mark the frame on screen when the key lands.
    const f = getPlayheadFrames();
    const next = (inFrames != null && f <= inFrames)
      ? Math.min(Math.max(0, durationFrames - 1), inFrames + r)
      : f;
    if (next !== outFrames) pushMarksUndo("mark out", inFrames, outFrames, inFrames, next);
    setOutFrames(next);
  }, [inFrames, outFrames, fps, durationFrames, pushMarksUndo]);

  // Clear literally clears — no selection at all.
  const onClearMarks = useCallback(() => {
    if (inFrames != null || outFrames != null) {
      pushMarksUndo("clear marks", inFrames, outFrames, null, null);
    }
    setInFrames(null);
    setOutFrames(null);
  }, [inFrames, outFrames, pushMarksUndo]);

  const onGotoIn = useCallback(() => {
    if (inFrames == null) return;
    exitShuttle();
    const r = Math.max(1, Math.round(fps));
    publishPlayheadFrames(inFrames);
    playerRef.current?.seekTo?.(inFrames / r);
  }, [inFrames, fps, exitShuttle]);

  const onGotoOut = useCallback(() => {
    if (outFrames == null) return;
    exitShuttle();
    const r = Math.max(1, Math.round(fps));
    publishPlayheadFrames(outFrames);
    playerRef.current?.seekTo?.(outFrames / r);
  }, [outFrames, fps, exitShuttle]);

  const onSeek = useCallback((f: number) => {
    exitShuttle();
    const r = Math.max(1, Math.round(fps));
    const clamped = Math.max(0, Math.min(Math.max(0, durationFrames - 1), f));
    publishPlayheadFrames(clamped);
    playerRef.current?.seekTo?.(clamped / r);
  }, [durationFrames, fps, exitShuttle]);

  // ====== Undo / redo (scoped — see lib/undo.ts) ======
  // One app-wide stack: mark entries (pushed above) and the user's own review
  // ops (pushed by ReviewPanel) interleave chronologically. The annotation
  // DRAFT keeps a separate lightweight in-composer history (registered into
  // this ref where the draft state lives, further down): draft snapshots die
  // with the draft — posted, cleared, or draw-mode exit — so global entries
  // for them would rot into confusing zombies. While drawing, ⌘Z steps the
  // draft first and falls through to the app stack when it's exhausted.
  const draftUndoRef = useRef<{ undo: () => boolean; redo: () => boolean } | null>(null);
  // Transient HUD over the canvas — toast only, no bell entry, no sound
  // (undo feedback is ephemeral confirmation, not a completion event).
  const showUndoHud = useCallback((title: string) => {
    setToast({ id: ++toastIdRef.current, kind: "success", title });
  }, []);
  const performUndo = useCallback(() => {
    if (draftUndoRef.current?.undo()) return;
    const label = appUndo.undo();
    if (label) showUndoHud(`Undid: ${label}`);
  }, [showUndoHud]);
  const performRedo = useCallback(() => {
    if (draftUndoRef.current?.redo()) return;
    const label = appUndo.redo();
    if (label) showUndoHud(`Redid: ${label}`);
  }, [showUndoHud]);
  // Live canUndo/canRedo + next labels for the palette (subscribe-based so a
  // push from ReviewPanel re-renders the registry too).
  const undoSnap = useSyncExternalStore(appUndo.subscribe, appUndo.getSnapshot);

  // ====== Keyboard ======
  // Review comment-range hotkeys (⇧I/⇧O) — ReviewPanel registers its handlers
  // here (the range state lives in the panel; App only forwards intent). The
  // gate values ride a companion latest-value ref because reviewSourceKey is
  // derived later in this file than the keyboard effect below.
  const reviewRangeKeysRef = useRef<{ markIn: () => void; markOut: () => void } | null>(null);
  const registerReviewRangeKeys = useCallback(
    (h: { markIn: () => void; markOut: () => void } | null) => { reviewRangeKeysRef.current = h; }, []);
  const reviewRangeGateRef = useRef({ panelDetached: false, queueOpen: false, reviewSourceKey: null as string | null, hasSource: false });
  // Latest-value mirror of co-review screening for the keyboard effect — like
  // reviewRangeGateRef, `screening` is derived later than this effect, so it
  // can't be a dep. Read in the view-switch cases to no-op ⌘1/⌘2 while the
  // co-review theater owns the window.
  const screeningRef = useRef(false);
  // Data-driven: the live event is serialized to a combo and matched against the
  // user-editable binding map (Settings → Commands). The three things that aren't
  // simple action triggers — the timecode-entry HUD, Esc-closes-Settings, and
  // bare-digit-opens-HUD — stay hand-coded around the dispatch.
  useEffect(() => {
    // Run a matched action with the exact behavior of its hand-coded predecessor
    // (the shuttle ladder on back/fwd, the export status gate, etc.).
    function runAction(id: KeyActionId, e: KeyboardEvent) {
      e.preventDefault();
      switch (id) {
        case "app.palette":  setPaletteOpen((p) => !p); break;
        case "app.shortcuts": setShortcutsOpen((p) => !p); break;
        case "app.settings": setSettingsOpen((p) => !p); break;
        // ⌘Z / ⇧⌘Z — non-global on purpose: in a text field these cases never
        // run (and nothing is preventDefault-ed), so the keystroke falls
        // through to the native Edit ▸ Undo/Redo menu items and the field's
        // own undo manager. Outside fields the DOM keydown arrives BEFORE the
        // menu's key equivalent and runAction's preventDefault suppresses it —
        // the same ordering the ⌘,/⌘K/⌘\ registry-vs-menu twins already rely on.
        case "edit.undo": performUndo(); break;
        case "edit.redo": performRedo(); break;
        case "src.fetch":    handleFetch(); break;
        // ⌘1/⌘2/⌘3 — top-level view switch (nav rail). Global: navigation has
        // to work from a text field too. The Clip view stays mounted either
        // way, so this never interrupts playback or a running job.
        case "view.home":
        case "view.clip":
        case "view.coreview": {
          // During a co-review screening the theater owns the whole window
          // (nav rail is CSS-hidden and the theater-exit control lives in the
          // Clip view) — ⌘1/⌘2/⌘3 would strand the user with no way back, so
          // no-op until they leave screening.
          if (screeningRef.current) break;
          const v: AppView = id === "view.home" ? "home" : id === "view.coreview" ? "coreview" : "clip";
          // Route through navigateView (not raw setActiveView) so Home also
          // bumps homeResetTick like every other nav surface does.
          navigateView(v);
          // The outgoing view is about to be [hidden]; if focus lived inside
          // it, it orphans to <body>. Move focus into the newly-shown view's
          // root once React commits the unhide (rAF lands after the paint).
          const viewRef = v === "home" ? homeViewRef : v === "coreview" ? coreviewViewRef : clipViewRef;
          requestAnimationFrame(() => viewRef.current?.focus());
          break;
        }
        case "view.logs":    setLogsOpen((p) => !p); break;
        case "queue.add":    handleAddToQueue(); break;
        case "queue.toggle": setQueueOpen((p) => !p); break;
        case "export.clip":  if (status === "loaded") handleExport(); break;
        case "play.toggle":  onPlayToggle(); break;
        // J / L — NLE transport: each press walks the shuttle ladder
        // (1-2-4-8×, opposite press steps down, +1 resumes real playback);
        // with K held it's a single-frame nudge instead. Repeats (key held)
        // sustain the current rate rather than laddering to the cap.
        case "play.back5": shuttleStep(-1, e.repeat); break;
        case "play.fwd5":  shuttleStep(1, e.repeat); break;
        case "mark.in":      onMarkIn(); break;
        case "mark.out":     onMarkOut(); break;
        // ⇧I/⇧O — review comment-range marks, only when the review UI is
        // actually in front of the user: docked drawer open, Review tab
        // active, a source loaded. loadActiveTab() reads the write-through
        // persisted tab (lib/tab-state) — no reactive plumbing needed. When
        // the panel is floated the docked drawer is unmounted and the
        // floated Review tab is a stub, so these no-op there.
        case "review.rangeIn":
        case "review.rangeOut": {
          const g = reviewRangeGateRef.current;
          // hasSource matters beyond reviewSourceKey: metadata (and thus the
          // key) survives status="error", but the playhead is null there —
          // marks would silently land at 0:00.
          if (g.panelDetached || !g.queueOpen || loadActiveTab() !== "review" || !g.reviewSourceKey || !g.hasSource) break;
          const h = reviewRangeKeysRef.current;
          if (id === "review.rangeIn") h?.markIn(); else h?.markOut();
          break;
        }
        case "mark.clear":   onClearMarks(); break;
        case "mark.gotoIn":  onGotoIn(); break;
        case "mark.gotoOut": onGotoOut(); break;
        case "play.frameBack":  onStep(-1); break;
        case "play.frameFwd":   onStep(1); break;
        case "play.secondBack": onStep(-Math.round(fps)); break;
        case "play.secondFwd":  onStep(Math.round(fps)); break;
        case "play.toStart": onSeek(0); break;
        case "play.toEnd":   onSeek(Math.max(0, durationFrames - 1)); break;
        // Persistent playback speed ([ / ] / \) — steps the 0.5–2× list.
        case "play.rateDown":  handlePlaybackRateStep(-1); break;
        case "play.rateUp":    handlePlaybackRateStep(1); break;
        case "play.rateReset": handlePlaybackRateChange(1); break;
      }
    }

    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const inField = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

      // Physical-K tracking for K+J/K+L frame-stepping. Tracked by e.code so
      // layout/Shift can't alias it; cleared on keyup + window blur below.
      if (e.code === "KeyK") kHeldRef.current = true;

      // ── Timecode entry HUD (modal text entry; not rebindable) ──
      // While open: digits append, Backspace deletes, Return snaps the playhead,
      // Esc cancels; everything else is swallowed so shortcuts can't fire mid-entry.
      if (tcEntryRef.current != null) {
        if (e.key >= "0" && e.key <= "9") { e.preventDefault(); setTcEntry((s) => ((s ?? "") + e.key).slice(-8)); return; }
        if (e.key === "Backspace")        { e.preventDefault(); setTcEntry((s) => (s ?? "").slice(0, -1)); return; }
        if (e.key === "Escape")           { e.preventDefault(); setTcEntry(null); return; }
        if (e.key === "Enter") {
          e.preventDefault();
          const d = (tcEntryRef.current || "0").slice(-8).padStart(8, "0");
          const r = Math.max(1, Math.round(fps));
          const frames = ((+d.slice(0, 2) * 3600 + +d.slice(2, 4) * 60 + +d.slice(4, 6)) * r) + +d.slice(6, 8);
          setTcEntry(null);
          onSeek(frames);
          return;
        }
        return;
      }

      // ── Esc closes Settings (universal; not rebindable) ──
      if (e.key === "Escape" && settingsOpen) { e.preventDefault(); setSettingsOpen(false); return; }

      // ── Rebindable shortcuts ──
      // global actions (⌘-combos) fire even in a field / with Settings open;
      // transport & marking only when neither is true (so typing never scrubs).
      const combo = eventToCombo(e);
      const actionId = combo ? comboToAction.get(combo) : undefined;
      if (actionId) {
        const action = KEY_ACTION_BY_ID[actionId];
        if (action.global || (!inField && !settingsOpen)) { runAction(actionId, e); return; }
      }

      if (inField || settingsOpen) return;

      // ── Bare number opens the TC-entry HUD (seeded with the digit) ──
      if (e.key >= "0" && e.key <= "9" && durationFrames > 0) {
        e.preventDefault();
        setTcEntry(e.key);
        return;
      }
    }
    // Keyup/blur companions exist solely for the K-held bookkeeping — the
    // action dispatch itself stays keydown-only.
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === "KeyK") kHeldRef.current = false;
    }
    function onBlur() { kHeldRef.current = false; }
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [
    comboToAction, handleFetch, handleExport, handleAddToQueue, status, fps, durationFrames, settingsOpen,
    onPlayToggle, shuttleStep, onMarkIn, onMarkOut, onClearMarks,
    onGotoIn, onGotoOut, onStep, onSeek,
    handlePlaybackRateStep, handlePlaybackRateChange,
    performUndo, performRedo, navigateView,
  ]);

  // ── Native menubar event wiring ─────────────────────────────────
  // The Rust shell emits `menu:<id>` window events when a menu item
  // is clicked. Most route to existing handlers; a couple toggle
  // local state. This effect re-attaches when those handlers change
  // — which is rarely, since they're stable useCallbacks.
  useEffect(() => {
    let mounted = true;
    const unlistens: Array<() => void> = [];
    (async () => {
      const bind = async (id: string, fn: () => void) => {
        const off = await listen(`menu:${id}`, () => { if (mounted) fn(); });
        unlistens.push(off);
      };
      await Promise.all([
        bind("open_url_bar",        () => {
          // The URL bar lives in the Clip view's toolbar — surface that view
          // first (a [hidden] subtree can't take focus), then focus once
          // React has committed the unhide (setTimeout lands after the
          // microtask-flushed render).
          setActiveView("clip");
          setTimeout(() => {
            const el = document.querySelector<HTMLInputElement>(".cp-url input");
            el?.focus();
            el?.select();
          }, 0);
        }),
        bind("import_local",        () => handleImportFile()),
        bind("import_transcript",   () => handleImportTranscript()),
        bind("reveal_library",      () => {
          const lib = defaults.transcriptLibrary;
          if (!lib) return;
          invoke("ensure_dir_exists", { path: lib })
            .then(() => invoke("reveal_in_finder", { path: lib }))
            .catch(() => { /* ignore */ });
        }),
        bind("open_settings",       () => setSettingsOpen(true)),
        bind("toggle_pipeline",     () => setLogsOpen((p) => !p)),
        bind("toggle_queue",        () => setQueueOpen((p) => !p)),
        bind("show_command_palette", () => setPaletteOpen(true)),
      ]);
    })();
    return () => { mounted = false; unlistens.forEach((u) => u()); };
  }, [handleImportFile, handleImportTranscript, defaults.transcriptLibrary, setActiveView]);

  // ── Suppress WKWebView's native context menu on UI chrome ──────
  // WKWebView shows "Look Up", "Translate", "Search with Google" when
  // you right-click any text it can select — including tab labels and
  // button text. We let it through on inputs + on the genuine prose
  // surfaces (transcript body, logs) where Copy / Look Up actually
  // make sense. Everywhere else, swallow the event so the user gets
  // app-native context menus only (or nothing).
  useEffect(() => {
    function onContextMenu(e: MouseEvent) {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      // Walk up to find any explicitly opted-in container. Mirror the
      // CSS allowlist (cp-tx-body, cp-tx-cue, cp-tx-turn-body, cp-logs-area).
      let cur: HTMLElement | null = t;
      while (cur && cur !== document.body) {
        const tag = cur.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        if (cur.isContentEditable) return;
        if (cur.classList.contains("cp-tx-body")
         || cur.classList.contains("cp-tx-cue")
         || cur.classList.contains("cp-tx-turn-body")
         || cur.classList.contains("cp-logs-area")) return;
        cur = cur.parentElement;
      }
      e.preventDefault();
    }
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  // ====== Command palette registry ======
  // Single source of truth for the ⌘K palette AND the Settings →
  // Shortcuts list. Each command is a stable id + label + group + run
  // handler bound to current closures. Disabled predicates use the
  // same checks the toolbar/sidebar buttons would use, so the palette
  // never offers actions that wouldn't work.
  const hasSource = status === "loaded" || status === "exporting" || status === "success";
  // Registry body lives in lib/commands.ts (buildCommands); App just injects
  // its current state + handlers. The dependency array below is unchanged from
  // when the array was inline, so memoization behaves identically.
  const commands: Command[] = useMemo(() => buildCommands({
    url, hasSource, isPlaying, inFrames, outFrames, durationFrames, fps,
    captionsOn, playbackRate, activeView, onNavigateView: navigateView,
    logsOpen, clipQueueLength: clipQueue.length, queueRunning,
    activeTranscriptPath: activeTranscript?.path ?? null,
    exportFolder: exportOpts.folder, sourceKind, status, transcriptState, playbackPrepBusy,
    handleFetch, handleImportFile, handleClear, onPlayToggle, seekBySeconds, shuttleStep,
    onPlaybackRateStep: handlePlaybackRateStep,
    onPlaybackRateReset: () => handlePlaybackRateChange(1),
    onStep, onSeek, onMarkIn, onMarkOut, onClearMarks, onGotoIn, onGotoOut,
    handleExport, handleSnapshot, handleAddToQueue, handleExportQueue,
    handleQueueClearAll, handleImportTranscript, handleGenerateTranscript,
    handleDownloadCaptions, handleStop,
    setQueueOpen, setTranscriptArrivedTick, setCaptionsOn, setLogsOpen,
    setSettingsOpen, setPaletteOpen,
    onShowShortcuts: () => setShortcutsOpen(true),
    canUndo: undoSnap.canUndo, canRedo: undoSnap.canRedo,
    undoLabel: undoSnap.undoLabel, redoLabel: undoSnap.redoLabel,
    onUndo: performUndo, onRedo: performRedo,
    onProbeDiarizer: async () => {
      try {
        const ver = await invoke<string>("probe_diarizer");
        pushNotification("success", "Diarizer ready", ver);
      } catch (e) {
        pushNotification("error", "Diarizer probe failed", formatError(e));
      }
    },
    // Overlay the live (user-editable) hotkey onto each rebindable command so the
    // palette + Settings list always show the real binding, never a stale literal.
  }).map((c) => {
    if (c.id in KEY_ACTION_BY_ID) {
      const combos = bindingsFor(c.id as KeyActionId, keybindings);
      return { ...c, hotkey: combos[0] ? formatCombo(combos[0]) : undefined };
    }
    return c;
  }), [
    url, hasSource, isPlaying, inFrames, outFrames, durationFrames, fps,
    captionsOn, playbackRate, activeView, navigateView,
    logsOpen, clipQueue.length, queueRunning, activeTranscript,
    exportOpts.folder, sourceKind, status, transcriptState, playbackPrepBusy,
    handleFetch, handleImportFile, handleClear, onPlayToggle, seekBySeconds, shuttleStep,
    handlePlaybackRateStep, handlePlaybackRateChange,
    onStep, onSeek, onMarkIn, onMarkOut, onClearMarks, onGotoIn, onGotoOut,
    handleExport, handleSnapshot, handleAddToQueue, handleExportQueue,
    handleQueueClearAll, handleGenerateTranscript, handleDownloadCaptions, handleImportTranscript,
    handleStop, keybindings, undoSnap, performUndo, performRedo,
  ]);

  // ====== First-run checklist derivation ======
  // Null hides the card (dismissed, or every step done at least once). All
  // three signals already persist elsewhere — recents, the folder setting,
  // transcript history — so nothing here duplicates state.
  // transcriptArrivedTick re-derives after a transcript lands mid-session.
  const onboardingSteps = useMemo(() => {
    if (onboardingDismissed) return null;
    const steps = deriveOnboardingSteps({
      recentsCount: recentSources.length,
      exportFolder: exportOpts.folder ?? defaults.folder,
      transcriptCount: getTranscriptHistory().length,
    });
    return onboardingComplete(steps) ? null : steps;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboardingDismissed, recentSources.length, exportOpts.folder, defaults.folder, transcriptArrivedTick]);

  // Route a pending checklist step to the surface that completes it.
  const handleOnboardingStep = useCallback((id: OnboardingStepId) => {
    if (id === "source") {
      // Same focus lever the File-menu "Open URL…" item uses.
      const el = document.querySelector<HTMLInputElement>(".cp-url input");
      el?.focus();
      el?.select();
    } else if (id === "folder") {
      setSettingsInitialTab("general");
      setSettingsOpen(true);
    } else {
      // Transcript tab: its empty state explains Generate (and gates on a
      // source being loaded first). arrivedTick is the "show this tab" lever.
      setQueueOpen(true);
      setTranscriptArrivedTick((n) => n + 1);
    }
  }, []);

  // ====== Side-panel pop-out (r44.B + r52 extract) ======
  // Cross-window state-sync bridge lives in src/hooks/use-panel-bus.ts.
  // We hand it the rendered snapshot + freshly-bound handlers; the hook
  // owns the listeners, the ref discipline, and the popout dispatch.
  //
  // The popped-out panel is a separate webview — it can't subscribe to this
  // window's playhead store, so the playhead reaches it as data on two
  // channels, neither of which re-renders App: the snapshot below carries
  // the store's position AS OF THE LAST RENDER (the boot seed + the value
  // that rides pause/seek-adjacent publishes), and use-panel-bus's 4 Hz
  // `panel:playhead` heartbeat streams the live motion between renders.
  // Playback therefore causes ZERO App re-renders — the docked UI reads the
  // store directly, the panel steps at heartbeat cadence.
  const transcriptPlayhead = hasSource
    ? playheadFramesToSeconds(getPlayheadFrames(), fps)
    : null;
  // Source duration in seconds for the auto-chapters clamp (null = unknown).
  const sourceDurationSec = durationFrames > 0
    ? durationFrames / Math.max(1, Math.round(fps))
    : null;

  // Review comment markers for the monitor timeline — re-read whenever the
  // source changes or the Review panel mutates (REVIEW_CHANGED_EVENT, mirrors
  // the speaker-overrides bus). Keeps the timeline dots in sync with the panel
  // without sharing state across the two components.
  // Reviews are keyed by source, but a clip's content fingerprint (filename +
  // duration + dims, location-independent) maps to a prior review's key — so
  // re-opening a clip you've reviewed before (even moved/renamed folder)
  // re-loads its notes. Falls back to the path on first encounter.
  const reviewSourceKey = (sourceKind === "file" && localFilePath && metadata)
    ? (resolveByFingerprint(reviewFingerprint(metadata.title ?? localFilePath, metadata.duration ?? 0, metadata.width, metadata.height, localFileSize)) ?? localFilePath)
    : (metadata?.webpage_url ?? null);
  const [reviewMarkers, setReviewMarkers] = useState<ReviewMarkerView[]>([]);
  const [reviewAnnotations, setReviewAnnotations] = useState<ReviewAnnotationView[]>([]);
  // Live range being set in the review composer → previewed on the timeline.
  // `live` = an end still follows the playhead (pulsing); false = locked.
  const [reviewRangeDraft, setReviewRangeDraft] = useState<{ start: number; end: number; color: string; live: boolean } | null>(null);
  // Latest-value mirror for the keyboard effect's ⇧I/⇧O review-range gate.
  useEffect(() => { reviewRangeGateRef.current = { panelDetached, queueOpen, reviewSourceKey, hasSource }; });

  // ── Co-review session (P2P watch party — r100 transport, r101 live review) ──
  // The whole subsystem — session lifecycle, host transport heartbeat + peer
  // playhead-follow, shared-doc seed/broadcast/merge/relay, presence ghost
  // cursors, screening mode — lives in src/hooks/use-co-review.ts (extracted
  // like use-panel-bus/use-web-playback). Rust owns the iroh endpoint
  // (commands/session.rs) as a dumb relay; the frontend is the review
  // source-of-truth. WEB-ONLY — a local file can't be pushed to peers, so
  // hosting is gated to web sources. The playhead is NOT passed in: the
  // hook's heartbeat/presence/chase read getPlayheadFrames() when they fire
  // (a render-mirrored value would go stale now that playback ticks don't
  // re-render App).
  const {
    coSession, coSessionActive, sessionDoc, postSessionOp, coGhostMarkers,
    screening, setScreening, screeningParticipants,
    startCoReview, joinCoReview, leaveCoReview,
  } = useCoReview({
    isPlaying, fps,
    activeSourceUrl, activeSourceUrlRef, reviewSourceKey,
    playerRef, metadataRef,
    onSeek, setUrl, handleFetch,
    pushNotification, setQueueOpen,
    setReviewMarkers, setReviewAnnotations,
  });
  // Latest-value mirror of screening for the keyboard view-switch gate (see
  // screeningRef — declared before that effect, mirrored here where screening
  // is finally in scope).
  useEffect(() => { screeningRef.current = screening; });
  // Undo hygiene: undoing across sources is nonsense, and entries recorded
  // solo must never replay into a co-review session (or vice versa — their
  // closures route to different docs). Drop the whole stack on either
  // boundary. The annotation-draft history is reset by the source-change
  // effect below, which already clears the draft itself.
  useEffect(() => { appUndo.clear(); }, [reviewSourceKey, coSession.role]);
  // Session-first: a session can be hosted at any time — start it, then load a
  // web source and it propagates to guests (the hook pushes activeSourceUrl).
  // A local file is the one source guests can't receive yet, so flag it for a
  // caveat in the popover rather than blocking the session.
  const coLocalSourceLoaded = hasSource && sourceKind === "file";

  // Drawing-annotation state: draw mode (+ the label tool inside it) + the
  // live draft (attached to the next comment) + a saved annotation being
  // viewed read-only over the frame (with its author's colour for labels).
  const [reviewDrawActive, setReviewDrawActive] = useState(false);
  const [reviewLabelMode, setReviewLabelMode] = useState(false);
  const [reviewDraft, setReviewDraft] = useState<AnnotationStrokes | null>(null);
  const [annotationDisplay, setAnnotationDisplay] = useState<AnnotationStrokes | null>(null);
  const [annotationDisplayColor, setAnnotationDisplayColor] = useState<string | null>(null);
  // ── In-composer draft undo ─────────────────────────────────────────
  // Snapshot history of the draft while drawing: each committed stroke/label
  // (or a Clear) pushes the PREVIOUS draft, so ⌘Z steps items off one at a
  // time; ⇧⌘Z walks back forward until a new stroke diverges. Drafts are
  // immutable snapshots (the overlay always hands up a fresh object), so
  // holding references is safe. History dies with the draft — see the
  // draftUndoRef comment for why this isn't on the global stack.
  const draftPastRef = useRef<(AnnotationStrokes | null)[]>([]);
  const draftFutureRef = useRef<(AnnotationStrokes | null)[]>([]);
  const reviewDraftRef = useRef(reviewDraft); reviewDraftRef.current = reviewDraft;
  const clearDraftHistory = useCallback(() => {
    draftPastRef.current = [];
    draftFutureRef.current = [];
  }, []);
  const onReviewDraftChange = useCallback((a: AnnotationStrokes) => {
    draftPastRef.current.push(reviewDraftRef.current);
    if (draftPastRef.current.length > 50) draftPastRef.current.shift();
    draftFutureRef.current = [];
    setReviewDraft(a);
  }, []);
  // Register with the keyboard dispatch (plain render-time ref assignment,
  // like sessionDocRef above): only while draw mode is live does ⌘Z route
  // here, and an exhausted history falls through to the app stack.
  draftUndoRef.current = reviewDrawActive
    ? {
        undo: () => {
          const prev = draftPastRef.current.pop();
          if (prev === undefined) return false;
          draftFutureRef.current.push(reviewDraftRef.current);
          setReviewDraft(prev);
          return true;
        },
        redo: () => {
          const next = draftFutureRef.current.pop();
          if (next === undefined) return false;
          draftPastRef.current.push(reviewDraftRef.current);
          setReviewDraft(next);
          return true;
        },
      }
    : null;
  useEffect(() => {
    // New source → drop any in-flight drawing + viewed annotation.
    setReviewDrawActive(false);
    setReviewLabelMode(false);
    setReviewDraft(null);
    clearDraftHistory();
    setAnnotationDisplay(null);
    // In a co-review session the SHARED doc drives markers (see the effect
    // below) — don't let the local-by-sourceKey reload overwrite them.
    if (coSessionActive) return;
    if (!reviewSourceKey) { setReviewMarkers([]); setReviewAnnotations([]); return; }
    const reload = () => {
      const d = loadReview(reviewSourceKey);
      const me = loadReviewer();
      const markers = reviewMarkersOf(d, d.activeVersionId);
      setReviewMarkers(markers.map((m) => ({
        id: m.id, time: m.time, timeEnd: m.timeEnd, resolved: m.resolved,
        color: reviewerColorFor(m.author, me), initials: initialsOf(m.author),
      })));
      setReviewAnnotations(annotationsOf(d, d.activeVersionId)
        .map((a) => ({ id: a.id, time: a.time, strokes: a.strokes, color: reviewerColorFor(a.author, me) })));
      // Once a clip has notes, record it in history + link its fingerprint so
      // re-opening it (anywhere) reloads this review. Read metadata via the ref —
      // this closure outlives a setMetadata that keeps the same reviewSourceKey
      // (e.g. a web "Loading…" stub resolving to its real title), so the lexical
      // `metadata` would otherwise write a stale title to history.
      const md = metadataRef.current;
      if (markers.length > 0 && reviewSourceKey) {
        const title = md?.title ?? localFilePath ?? reviewSourceKey;
        const path = localFilePath ?? md?.webpage_url ?? reviewSourceKey;
        upsertReviewHistory({ key: reviewSourceKey, title, path, updatedAt: Date.now(), count: markers.length });
        if (sourceKind === "file" && md) {
          linkFingerprint(reviewFingerprint(title, md.duration ?? 0, md.width, md.height, localFileSize), reviewSourceKey);
        }
      }
    };
    reload();
    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ sourceKey?: string }>).detail;
      if (!detail || detail.sourceKey === reviewSourceKey) reload();
    };
    window.addEventListener(REVIEW_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(REVIEW_CHANGED_EVENT, onChanged);
  }, [reviewSourceKey, coSessionActive, clearDraftHistory]);

  // Auto-chapter markers for the timeline — same pattern as the review
  // markers above: keyed by the source, re-read on CHAPTERS_CHANGED_EVENT
  // (fired by lib/chapters saves in this window; the popped-out panel's
  // saves arrive as a panel:action:chaptersChanged → main re-dispatches the
  // same event, so this one listener covers both windows).
  const [chapterMarkers, setChapterMarkers] = useState<ChapterMarker[]>([]);
  useEffect(() => {
    if (!reviewSourceKey) { setChapterMarkers([]); return; }
    const reload = () => setChapterMarkers(loadChapters(reviewSourceKey));
    reload();
    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ sourceKey?: string }>).detail;
      if (!detail || detail.sourceKey === reviewSourceKey) reload();
    };
    window.addEventListener(CHAPTERS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(CHAPTERS_CHANGED_EVENT, onChanged);
  }, [reviewSourceKey]);

  const { handlePopOut: handlePopOutPanel } = usePanelBus({
    panelDetached,
    setPanelDetached,
    setQueueOpen,
    snapshot: {
      queue: clipQueue,
      fps,
      running: queueRunning,
      hasFolder: !!exportOpts.folder,
      transcriptPath: activeTranscript?.path ?? null,
      transcriptOrigin: activeTranscript?.origin ?? "unknown",
      transcriptPlayhead,
      transcriptArrivedTick,
      regenerateBusy: transcriptState === "running",
      canRegenerate: hasSource && !!selectedModel?.downloaded,
      hasSource,
      aiModelId: defaults.llmSummarizationModel,
      aiStyle: { format: defaults.summaryFormat, length: defaults.summaryLength },
      chapterSourceKey: reviewSourceKey,
      durationSec: sourceDurationSec,
    },
    handlers: {
      onRemove: handleQueueRemove,
      onClearAll: handleQueueClearAll,
      onExportAll: () => { void handleExportQueue(); },
      onStop: () => { void handleStop(); },
      onSeek: (seconds: number) => {
        // Clamp so a stale cue past the end doesn't put the playhead
        // in a no-man's-land. Mirrors the docked drawer's inline math.
        const r = Math.max(1, Math.round(fps));
        const targetFrame = Math.max(
          0,
          Math.min(durationFrames - 1, Math.floor(seconds * r)),
        );
        onSeek(targetFrame);
      },
      onClearTranscript: handleClearTranscript,
      onLoadFromHistory: handleLoadFromHistory,
      onRegenerate: () => { void handleGenerateTranscript(); },
      onImportTranscript: () => { void handleImportTranscript(); },
      onTranscriptEdited: () => setTranscriptArrivedTick((n) => n + 1),
      onOpenAiSettings: () => { setSettingsInitialTab("ai-summary"); setSettingsOpen(true); },
      // The panel saved chapters to the SHARED localStorage; re-dispatch the
      // same-window change event so the chapter-markers effect re-reads.
      onChaptersChanged: () => {
        try { window.dispatchEvent(new CustomEvent(CHAPTERS_CHANGED_EVENT)); } catch { /* non-DOM */ }
      },
    },
  });

  // ====== Derived ======
  // Review drawing shown on the frame, picked in priority order:
  //   1. live draft while drawing   2. a comment's drawing pinned via click
  //   3. proximity fade — handled INSIDE Monitor by a playhead-store
  //      subscriber (author colour riding along for its label chips), so
  //      the 60Hz opacity ramp never re-renders App.
  const annDrawing = reviewDrawActive;
  const annStrokes = annDrawing ? reviewDraft : annotationDisplay;
  const annPinned = !annDrawing && !!annotationDisplay;
  // Label-chip tint: the current reviewer's colour while drafting, else the
  // pinned annotation's author colour (undefined → the overlay's default).
  // The proximity fade's tint travels inside proximityAnnotations.
  const annLabelColor = (annDrawing ? loadReviewer().color
    : annotationDisplayColor) ?? undefined;
  // Live HH:MM:SS:FF for the timecode-entry HUD (right-aligned digit fill).
  const tcOverlay = tcEntry == null ? null
    : (() => { const d = tcEntry.slice(-8).padStart(8, "0"); return `${d.slice(0, 2)}:${d.slice(2, 4)}:${d.slice(4, 6)}:${d.slice(6, 8)}`; })();
  const titleSuffix = (status === "loaded" || status === "exporting" || status === "success") && exportOpts.filename
    ? ` — ${exportOpts.filename}`
    : "";
  // Nav-rail tooltip shortcuts — resolved from the LIVE bindings so a rebind
  // in Settings → Commands shows correctly in the rail titles.
  const homeCombo = bindingsFor("view.home", keybindings)[0];
  const clipCombo = bindingsFor("view.clip", keybindings)[0];
  const coreviewCombo = bindingsFor("view.coreview", keybindings)[0];

  // ── Stale-binary banner ──────────────────────────────────────────────
  // Only shows when the Rust backend doesn't match the frontend's expected
  // build ID. Sits above everything so the user can't miss it — the visual
  // is intentionally loud (red) because the symptoms otherwise look like
  // unrelated bugs (640p metadata, missing snapshot data, etc).
  const buildBanner = (() => {
    if (!buildCheck) return null;
    if (buildCheck.kind === "ok") return null;
    let message: string;
    if (buildCheck.kind === "missing") {
      message = "Rust backend is stale (no build-handshake command). Stop the dev server (Ctrl+C) and re-run `npm run tauri dev` to rebuild.";
    } else if (buildCheck.kind === "mismatch") {
      message = `Backend build "${buildCheck.got}" doesn't match frontend's expected "${buildCheck.expected}". Restart \`npm run tauri dev\` so cargo rebuilds.`;
    } else {
      message = `Backend health check failed: ${buildCheck.error}`;
    }
    return (
      <div className="cp-build-banner" role="alert">
        <span className="cp-build-banner-tag">REBUILD REQUIRED</span>
        <span className="cp-build-banner-msg">{message}</span>
      </div>
    );
  })();

  return (
    <div className="cp-window">
      {buildBanner}
      <div className="cp-titlebar" data-tauri-drag-region>
        <div className="cp-titlebar-title" data-tauri-drag-region>
          Sauce Bunny{titleSuffix}
        </div>
      </div>

      <div className={"cp-body" + (screening ? " cp-screening" : "")}>
        {/* display:contents normally (rail is a plain flex child); during
            screening it becomes the fixed left-edge hover hot-zone that
            reveals the rail as an overlay — CSS-only, see screening.css. */}
        <div className="cp-nav-dock">
          <NavRail
            active={activeView}
            onNavigate={navigateView}
            onOpenSettings={() => setSettingsOpen(true)}
            homeShortcut={homeCombo ? formatCombo(homeCombo) : undefined}
            clipShortcut={clipCombo ? formatCombo(clipCombo) : undefined}
            coreviewShortcut={coreviewCombo ? formatCombo(coreviewCombo) : undefined}
            sessionActive={coSessionActive}
            sessionPeers={coSession.peers.length}
          />
        </div>
        <div className="cp-views">
          {/* Home — the Library (LibraryView.tsx owns roots/scans/search;
              App only supplies the open handlers + recents). */}
          <div ref={homeViewRef} tabIndex={-1} className="cp-view cp-view-home" hidden={activeView !== "home"}>
            <LibraryView
              recentSources={recentSources}
              onOpenLocalPath={handleLibraryOpenLocalPath}
              onOpenRecentSource={handleLibraryOpenRecent}
              onOpenTranscriptHistory={handleLibraryOpenTranscript}
              onSwitchToClip={handleSwitchToClip}
              homeResetSignal={homeResetTick}
            />
          </div>
          {/* Clip — the ENTIRE pre-rail app, toolbar included. NEVER
              unmounted: while Home is active it's [hidden] (the QueueDrawer
              keep-alive pattern), so playback, export/transcript jobs,
              co-review sessions, and every listener beneath survive
              browsing the library. Audio deliberately keeps playing on
              Home (streaming-platform behavior — no pause-on-leave). */}
          <div ref={clipViewRef} tabIndex={-1} className="cp-view cp-view-clip" hidden={activeView !== "clip"}>
            <Toolbar
              url={url}
              onChange={setUrl}
              onFetch={handleFetch}
              onClear={handleClear}
              onImportFile={handleImportFile}
              recentSources={recentSources}
              onOpenRecent={handleOpenRecentSource}
              onRemoveRecent={handleRemoveRecentSource}
              onClearRecents={handleClearRecentSources}
              onToggleQueue={() => setQueueOpen((p) => !p)}
              queueCount={clipQueue.length}
              queueOpen={queueOpen}
              sidebarOpen={sidebarOpen}
              onToggleSidebar={() => setSidebarOpen((p) => !p)}
              hasSource={status === "loaded" || status === "exporting" || status === "success" || status === "error"}
              status={status}
              fetchPhase={fetchButtonPhase(fetchPhase, status)}
              onFetchResolved={() => setFetchPhase("idle")}
              notifications={notifications}
              onMarkAllRead={onMarkAllRead}
              onClearNotifications={onClearNotifications}
              onDismissNotification={onDismissNotification}
              coSession={coSession}
              coLocalSource={coLocalSourceLoaded}
              coScreening={screening}
              onCoToggleScreening={() => setScreening((s) => !s)}
              onCoStart={() => { void startCoReview(); }}
              onCoJoin={(t, n) => { void joinCoReview(t, n); }}
              onCoLeave={leaveCoReview}
            />

            <div className="cp-clip-body">
              {/* Always mounted (stable sibling of <main>) so entering screening
                  never remounts the player; renders nothing when not screening. */}
              <ParticipantRail
                active={screening}
                participants={screeningParticipants}
                onExit={() => setScreening(false)}
              />
              <Sidebar
                open={sidebarOpen}
                status={status}
                metadata={metadata}
                exportOpts={exportOpts}
                setExportOpts={setExportOpts}
                recents={recents}
                onExport={handleExport}
                exportPhase={exportPhase}
                onExportResolved={() => setExportPhase("idle")}
                onReveal={handleReveal}
                onPickRecent={handlePickRecent}
                onClearRecents={handleClearRecents}
                onAddToQueue={handleAddToQueue}
                queueCount={clipQueue.length}
                queueRunning={queueRunning}
                onExportQueue={handleExportQueue}
                onDownloadCaptions={handleDownloadCaptions}
                captionsState={captionsState}
                captionsError={captionsError}
                onGenerateTranscript={handleGenerateTranscript}
                transcriptState={transcriptState}
                transcriptResolution={transcriptResolution}
                onTranscriptResolved={() => setTranscriptResolution(null)}
                transcriptError={transcriptError}
                transcriptProgress={transcriptProgress}
                transcriptPhase={transcriptPhase}
                whisperModelReady={whisperModelReady}
                whisperModelLabel={whisperModelLabel}
                onOpenTranscriptionSettings={handleOpenTranscriptionSettings}
                onOpenGeneralSettings={() => { setSettingsInitialTab("general"); setSettingsOpen(true); }}
                detectSpeakers={defaults.detectSpeakers}
                setDetectSpeakers={(v) => setDefaults({ ...defaults, detectSpeakers: v })}
                expectedSpeakers={defaults.expectedSpeakers}
                setExpectedSpeakers={(n) => setDefaults({ ...defaults, expectedSpeakers: n })}
                diarizerReady={diarizerReady}
                onLog={appendLog}
                fps={fps}
                durationTc={durationTc}
                metadataLoading={metadataLoading}
              />

              <main className="cp-main">
                <div className="cp-monitor-wrap">
                  <div className="cp-view-bar">
                    <ViewOptions
                      aspect={aspect}
                      onAspectChange={setAspect}
                      waveformVisible={waveformVisible}
                      onWaveformVisibleChange={setWaveformVisible}
                      onShowMediaInfo={sourceKind === "file" && localFilePath ? () => setMediaInfoOpen(true) : undefined}
                    />
                  </div>
                  <Monitor
                    ref={playerRef}
                    status={status}
                    metadata={metadata}
                    errorDetail={errorDetail}
                    /* Stale-yt-dlp recovery: "offer"/"busy" renders the one-click
                       "Update yt-dlp & retry" CTA on the error overlay; "spent"
                       (this URL already got its one cycle) renders the
                       engine-is-current hint instead. */
                    extractorRot={
                      rotRecovery == null
                        ? null
                        : rotRecovery.phase === "spent"
                          ? rotRecovery
                          : { phase: rotRecovery.phase, onUpdateAndRetry: handleUpdateYtdlpAndRetry }
                    }
                    /* Empty-state "Resume last session" — one-click reopen of the
                       most recent source via the same fetch/import handlers. */
                    resumeTitle={recentSources.length > 0 ? recentSources[0].title : null}
                    onResume={recentSources.length > 0 ? () => handleOpenRecentSource(recentSources[0]) : undefined}
                    /* First-run checklist card — null once done/dismissed. */
                    onboarding={onboardingSteps ? {
                      steps: onboardingSteps,
                      onStep: handleOnboardingStep,
                      onDismiss: () => { saveOnboardingDismissed(); setOnboardingDismissed(true); },
                    } : null}
                    aspect={aspect}
                    sourceKind={sourceKind}
                    /* Prefer the ffmpeg-normalised playback copy when ready —
                       it's the WKWebView-compatible MP4/MP3. Falls back to the
                       original so the user still sees a player even if prep is
                       still running or failed. */
                    localFilePath={playbackPath ?? localFilePath}
                    /* r80: web-playback read-model from useWebPlayback. cachePath
                       (download fallback) wins over the live stream; both are null
                       until the machine produces one. */
                    webStreamUrl={webPlayback.cachePath ?? webPlayback.streamUrl}
                    onDiag={(tag, msg) => appendLog(asLogTag(tag), "seek", msg)}
                    /* Audio track + codecs are meaningful only while STREAMING (the
                       cached file is already muxed and sample-accurate). */
                    audioStreamUrl={webPlayback.audioUrl}
                    streamVideoCodec={webPlayback.videoCodec}
                    streamAudioCodec={webPlayback.audioCodec}
                    initialVolume={muted ? 0 : volume}
                    /* Prep banner is shared with local-file ffmpeg prep — OR the two
                       sources so the web download lights it up too. */
                    playbackPrepBusy={playbackPrepBusy || webPlayback.downloading}
                    playbackPrepProgress={webPlayback.downloading ? webPlayback.downloadProgress : playbackPrepProgress}
                    /* r62: friendly "what's happening" overlay over the poster
                       while a web source resolves (yt-dlp ~8s) then buffers
                       (MSE). Null once the player is ready or for local files /
                       the download fallback (which has its own banner). */
                    streamLoadingPhase={
                      /* Only while the machine is actually WORKING toward playback
                         (resolving/streaming/cached). The terminal states — failed,
                         or inactive after a user cancel — must clear the overlay, or
                         the canvas stays under an infinite "Preparing your video…"
                         spinner after the error/cancel toast fades. `downloading` has
                         its own overlay with a Cancel button. */
                      sourceKind === "youtube" && status === "loaded" && !playerReady
                        && !playbackPrepBusy
                        && (webPlayback.state.kind === "resolving"
                          || webPlayback.state.kind === "streaming"
                          || webPlayback.state.kind === "cached")
                        ? ((webPlayback.streamUrl || webPlayback.cachePath) ? "Starting playback…" : "Resolving stream…")
                        : null
                    }
                    /* r55: on-canvas Cancel for the web-preview download fallback.
                       Previously the only cancel UI was the Pipeline panel Stop
                       button — and that panel defaults collapsed (task #45), so
                       the user often had no visible cancel point during a long
                       yt-dlp HLS-fragments download. Shares the same handleStop
                       path as the Pipeline Stop, so cancel semantics are
                       identical wherever the user clicks. */
                    onCancelPlaybackPrep={handleStop}
                    /* Nonzero while J/L shuttling — renders the "◀◀ 4×" HUD badge. */
                    shuttleRate={shuttleRate}
                    /* Flashed briefly when the persistent playback speed changes. */
                    playbackRateHud={rateHud}
                    useWebCodecs={localPlayer === "mediabunny" && !webCodecsFallbackForImport}
                    onMediaError={(msg) => {
                      // MediaBunnyPlayer prefixes codec-incompatibility errors
                      // with `[WEBCODECS_UNSUPPORTED]` — that's our signal to
                      // transparently kick off ffmpeg prep for THIS import and
                      // swap the Monitor to LocalMediaPlayer pointed at the
                      // prepared copy. The Settings toggle stays on for next time.
                      if (msg.startsWith("[WEBCODECS_UNSUPPORTED]") && localFilePath && metadata) {
                        // Guard against double-fire: MediaBunnyPlayer can emit
                        // two unsupported errors (video AND audio track failing
                        // canDecode() back-to-back). Without this check the
                        // second one starts a second ffmpeg prep that races the
                        // first for the same cache output path.
                        if (playbackPrepBusy || webCodecsFallbackForImport) {
                          return;
                        }
                        // Quiet info-level state change. The pipeline log line
                        // below + the existing "Preparing playback copy" banner
                        // already communicate this — a notification-popover
                        // toast on top of those is noisy. If prep then FAILS,
                        // the catch block down in runPlaybackPrep already
                        // surfaces an error toast.
                        appendLog("warn", "media",
                          `${msg.replace("[WEBCODECS_UNSUPPORTED]", "WebCodecs doesn't support")} — falling back to ffmpeg prep.`);
                        setWebCodecsFallbackForImport(true);
                        // Reuse the same prep pipeline. seq guards against the
                        // user switching sources before prep finishes.
                        const seq = sourceSeqRef.current;
                        void runPlaybackPrep(localFilePath, !!metadata.vcodec, metadata.duration, seq);
                        return;
                      }

                      // Native <video> failed on a local ORIGINAL (msg is NOT the
                      // WebCodecs marker above). The smart-selection routes friendly
                      // codecs (h264/aac/mp4) to the native path assuming asset://
                      // <video> will load them — but that isn't guaranteed (large
                      // files can log MEDIA_ERR_SRC_NOT_SUPPORTED + "duration 0.0s"
                      // and never load). Fall back to MediaBunnyPlayer, which reads
                      // the file via fetch(asset://) + ranged reads and bypasses the
                      // <video> media loader that just failed. If mediabunny ALSO
                      // can't decode it emits [WEBCODECS_UNSUPPORTED], which the
                      // branch above turns into an ffmpeg transcode — giving the full
                      // native → mediabunny → transcode chain.
                      //
                      // Guards keep this from looping or firing on the transcode
                      // path: it requires localPlayer==="native" (the transcode path
                      // leaves localPlayer at "mediabunny" and only flips
                      // webCodecsFallbackForImport), and both !nativeFallbackTried and
                      // !webCodecsFallbackForImport, so a second failure — whether of
                      // the mediabunny attempt or of a prepped transcode copy — falls
                      // through to the terminal error below instead of retrying.
                      if (
                        sourceKind === "file"
                        && localPlayer === "native"
                        && localFilePath
                        && !nativeFallbackTried
                        && !playbackPrepBusy
                        && !webCodecsFallbackForImport
                      ) {
                        setNativeFallbackTried(true);
                        setLocalPlayer("mediabunny");
                        appendLog("warn", "media",
                          "Native <video> couldn't load this file — decoding in-app via mediabunny.");
                        return;
                      }

                      // Web-source playback fallback (r80): delegate to the state
                      // machine. When it's mid-stream it logs, shows the toast, and
                      // transitions streaming → downloading (exactly once — the
                      // double-download race is gone) and returns true. Any other
                      // state returns false → fall through to the generic error.
                      if (webOnMediaError(msg)) return;

                      appendLog("err", "media", msg);
                      pushNotification("error", "Playback error", msg);
                    }}
                    toast={toast}
                    onToastDismiss={() => setToast(null)}
                    onPlayerTimeUpdate={onPlayerTimeUpdate}
                    onPlayerStateChange={onPlayerStateChange}
                    onPlayerReady={onPlayerReady}
                    onSurfaceClick={onPlayToggle}
                    /* On-video captions (the transport CC toggle). Driven by the
                       active transcript + playhead so they work for any source. */
                    transcriptPath={activeTranscript?.path ?? null}
                    transcriptReloadToken={transcriptArrivedTick}
                    fps={fps}
                    captionsOn={captionsOn}
                    /* User-tunable caption look (Settings → Captions). r82: no sync
                       offset — the audio-master clock keeps captions on the heard
                       audio across every path. */
                    captionStyle={{
                      sizePx: defaults.captionSizePx,
                      font: defaults.captionFont,
                      bgOpacity: defaults.captionBgOpacity,
                      color: defaults.captionColor,
                    }}
                    /* Type-a-timecode HUD: digits build this string, Return snaps. */
                    tcOverlay={tcOverlay}
                    /* Review drawing annotations — draft while drawing, else the
                       saved one being viewed; with neither, Monitor's proximity
                       fade picks from the saved list as the playhead passes. */
                    annotation={annStrokes}
                    annotationDrawing={annDrawing}
                    proximityAnnotations={!annDrawing && !annotationDisplay ? reviewAnnotations : undefined}
                    onAnnotationChange={onReviewDraftChange}
                    onAnnotationDismiss={annPinned ? () => setAnnotationDisplay(null) : undefined}
                    annotationLabelMode={annDrawing && reviewLabelMode}
                    annotationLabelColor={annLabelColor}
                  />
                  <Transport
                    status={status}
                    isPlaying={isPlaying}
                    fps={fps}
                    durationTc={durationTc}
                    /* Green only when captions are actually on-screen (toggled on
                       AND a transcript is loaded), not just when the flag is set. */
                    captionsOn={captionsActive}
                    snapshotBusy={snapshotBusy}
                    canSnapshot={status === "loaded" || status === "exporting" || status === "success"}
                    volume={volume}
                    muted={muted}
                    playbackRate={playbackRate}
                    playbackRateSupported={rateSupported}
                    onPlayToggle={onPlayToggle}
                    onStep={onStep}
                    onMarkIn={onMarkIn}
                    onMarkOut={onMarkOut}
                    onClearMarks={onClearMarks}
                    onToggleCaptions={onToggleCaptions}
                    onSnapshot={handleSnapshot}
                    onVolumeChange={handleVolumeChange}
                    onMutedChange={handleMutedChange}
                    onPlaybackRateChange={handlePlaybackRateChange}
                  />
                  <Timeline
                    status={status}
                    durationFrames={durationFrames}
                    inFrames={inFrames}
                    outFrames={outFrames}
                    fps={fps}
                    queuedRanges={clipQueue.map((c) => ({
                      id: c.id,
                      inFrames: c.inFrames,
                      outFrames: c.outFrames,
                      status: c.status,
                    }))}
                    commentMarkers={reviewMarkers}
                    chapterMarkers={chapterMarkers}
                    reviewRangeDraft={reviewRangeDraft}
                    filmstripPath={sourceKind === "file" ? (playbackPath ?? localFilePath) : null}
                    waveformOn={waveformVisible}
                    speakerLanes={speakerLaneData}
                    ghosts={coGhostMarkers}
                    onSeek={onSeek}
                  />
                  {/* Status line under the timeline. Stays present so setting or
                      clearing a mark doesn't cause the canvas above to reflow. */}
                  <div className="cp-timeline-hint">
                    {(status === "loaded" || status === "success") ? (
                      inFrames == null && outFrames == null
                        ? `No marks set — export will grab the entire clip${exportOpts.format === "audio" ? " as MP3" : ""}.`
                        : inFrames != null && outFrames == null
                          ? "Mark out (O) to set the end of the selection."
                          : inFrames == null && outFrames != null
                            ? "Mark in (I) to set the start of the selection."
                            : "Selection set — adjust with I / O or drag the playhead."
                    ) : status === "empty" && bindingsFor("app.shortcuts", keybindings)[0]
                      ? `Press ${formatCombo(bindingsFor("app.shortcuts", keybindings)[0])} for keyboard shortcuts.`
                      : ""}
                  </div>
                </div>

                <LogsPanel
                  open={logsOpen}
                  onToggle={() => setLogsOpen((p) => !p)}
                  status={status}
                  progress={progress}
                  lines={logs}
                  onClear={handleClearLogs}
                  onCopy={handleCopyLogs}
                  onExportDiagnostics={handleExportDiagnostics}
                  transcriptState={transcriptState}
                  transcriptProgress={transcriptProgress}
                  transcriptPhase={transcriptPhase}
                  transcriptEngine={defaults.transcriptionEngine === "parakeet" ? "parakeet" : "whisper"}
                  metadataLoading={metadataLoading}
                  playbackPrepBusy={playbackPrepBusy}
                  canStop={status === "exporting" || transcriptState === "running" || playbackPrepBusy}
                  onStop={handleStop}
                />
              </main>

              {/* Queue is now a docked sibling of <main> inside .cp-body — when
                  open it claims its own column and the main area reflows to
                  give it room (Claude/OpenArt-style push panel), instead of
                  sliding on top and obscuring the canvas.

                  When the panel is popped out into its own native OS window
                  (r44.B), this docked instance unmounts entirely — the user
                  asked for "true detachment", so there's no docked placeholder.
                  Re-docking happens when the floating window closes (Rust
                  fires `panel:closed` → setPanelDetached(false)). */}
              {!panelDetached && <QueueDrawer
                open={queueOpen}
                onClose={() => setQueueOpen(false)}
                onPopOut={handlePopOutPanel}
                queue={clipQueue}
                fps={fps}
                running={queueRunning}
                hasFolder={!!exportOpts.folder}
                onRemove={handleQueueRemove}
                onClearAll={handleQueueClearAll}
                onExportAll={handleExportQueue}
                onStop={handleStop}
                onRenameClip={handleQueueRename}
                onRenameAll={handleQueueRenameAll}
                transcriptPath={activeTranscript?.path ?? null}
                transcriptOrigin={activeTranscript?.origin ?? "unknown"}
                playheadAvailable={hasSource}
                transcriptFps={fps}
                onTranscriptSeek={(seconds) => {
                  // Clamp to duration so a stale cue past the end doesn't put
                  // the playhead in a no-man's-land that shows blank video.
                  const r = Math.max(1, Math.round(fps));
                  const targetFrame = Math.max(
                    0,
                    Math.min(durationFrames - 1, Math.floor(seconds * r)),
                  );
                  onSeek(targetFrame);
                }}
                transcriptArrivedTick={transcriptArrivedTick}
                onClearTranscript={handleClearTranscript}
                onLoadFromHistory={handleLoadFromHistory}
                onRegenerateTranscript={handleGenerateTranscript}
                regenerateBusy={transcriptState === "running"}
                canRegenerate={hasSource && !!selectedModel?.downloaded}
                onRedetectSpeakers={() => { void handleRediarize(); }}
                canRedetect={hasSource && !!activeTranscript}
                onImportTranscript={handleImportTranscript}
                sourceKind={sourceKind}
                onFixCaptionTiming={handleFixCaptionTiming}
                transcriptHasSource={hasSource}
                /* Inline cue editing rewrote the SRT in place — the arrived tick is
                   the existing "same path, new contents" signal (see the speaker-
                   lanes effect), so every reader of the file re-reads: the caption
                   overlay, AI summary, speaker lanes, and the viewer itself. */
                onTranscriptEdited={() => setTranscriptArrivedTick((n) => n + 1)}
                aiModelId={defaults.llmSummarizationModel}
                aiStyle={{ format: defaults.summaryFormat, length: defaults.summaryLength }}
                onOpenAiSettings={() => { setSettingsInitialTab("ai-summary"); setSettingsOpen(true); }}
                chapterSourceKey={reviewSourceKey}
                chapterDurationSec={sourceDurationSec}
                reviewSourceKey={reviewSourceKey}
                reviewSourceTitle={metadata?.title ?? null}
                reviewDrawActive={reviewDrawActive}
                reviewDraft={reviewDraft}
                onToggleReviewDraw={() => {
                  setAnnotationDisplay(null);
                  // Pen click while the label tool is active = switch back to the
                  // pen (stay in draw mode); otherwise toggle draw mode itself.
                  if (reviewDrawActive && reviewLabelMode) { setReviewLabelMode(false); return; }
                  setReviewLabelMode(false);
                  setReviewDrawActive((on) => { if (on) { setReviewDraft(null); clearDraftHistory(); } return !on; });
                }}
                reviewLabelActive={reviewLabelMode}
                onToggleReviewLabel={() => {
                  setAnnotationDisplay(null);
                  // Label click enters draw mode if needed; inside draw mode it
                  // toggles between the label tool and the pen.
                  if (!reviewDrawActive) { setReviewDrawActive(true); setReviewLabelMode(true); return; }
                  setReviewLabelMode((v) => !v);
                }}
                onReviewDraftConsumed={() => { setReviewDraft(null); clearDraftHistory(); setReviewDrawActive(false); setReviewLabelMode(false); }}
                onShowAnnotation={(a, color) => { setReviewDrawActive(false); setReviewLabelMode(false); setReviewDraft(null); clearDraftHistory(); setAnnotationDisplay(a); setAnnotationDisplayColor(color ?? null); }}
                onOpenReviewSource={handleOpenReviewSource}
                onReviewRangeDraft={setReviewRangeDraft}
                onRegisterRangeHotkeys={registerReviewRangeKeys}
                reviewSessionActive={coSessionActive}
                reviewSessionDoc={sessionDoc}
                onReviewSessionOp={postSessionOp}
              />}
            </div>
          </div>
          {/* Co-Review — a first-class lobby over the SAME useCoReview state
              the toolbar popover reads (both surfaces stay in sync by
              construction). Kept-alive like the others: [hidden] when inactive
              so the session/listeners beneath are never torn down. "Enter
              theater" lands on Clip with screening on (the theater overlays the
              Clip player). */}
          <div ref={coreviewViewRef} tabIndex={-1} className="cp-view cp-view-coreview" hidden={activeView !== "coreview"}>
            <CoReviewLobby
              session={coSession}
              localSource={coLocalSourceLoaded}
              participants={screeningParticipants}
              onStart={() => { void startCoReview(); }}
              onJoin={(t, n) => { void joinCoReview(t, n); }}
              onLeave={leaveCoReview}
              onEnterTheater={() => { navigateView("clip"); setScreening(true); }}
            />
          </div>
        </div>
      </div>

      <SettingsModal
        open={settingsOpen}
        onClose={() => { setSettingsOpen(false); refreshWhisperModels(); }}
        /* Cache files the CURRENT session plays from — Clear cache must not
           delete the video/audio that's on screen right now. Their jobs have
           finished, so the JobRegistry guard alone doesn't protect them. */
        cacheExcludePaths={[
          webPlayback.cachePath,
          playbackPath,
          webAudioCachedPathRef.current,
        ].filter((p): p is string => !!p)}
        defaults={defaults}
        setDefaults={setDefaults}
        keybindings={keybindings}
        setKeybindings={setKeybindings}
        initialTab={settingsInitialTab}
        commands={commands}
        diarizerReady={diarizerReady}
        diarizerPrepareState={diarizerPrepareState}
        diarizerPrepareError={diarizerPrepareError}
        onPrepareDiarizerModels={handlePrepareDiarizerModels}
        onCancelDiarizerPrepare={handleCancelDiarizerPrepare}
        onApplyToCurrent={(patch) => {
          setExportOpts((prev) => ({ ...prev, ...patch }));
        }}
      />

      <YouTubeAuthModal
        open={ytAuthOpen}
        mode={ytAuthMode}
        site={ytAuthSite}
        current={defaults.ytCookiesBrowser}
        onPick={handleYtAuthPick}
        onClose={handleYtAuthClose}
      />

      {/* Media info inspector — probes the ORIGINAL source file so the
          numbers describe what's on disk, not the normalised playback copy. */}
      {mediaInfoOpen && localFilePath && (
        <MediaInfoModal path={localFilePath} onClose={() => setMediaInfoOpen(false)} />
      )}

      {/* ⌘K command palette — mounted at top level so its portal sits
          above every panel/drawer/modal. Always rendered; the component
          short-circuits to null when closed so the overhead is one
          `if (!open) return null`. */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
      />

      {/* ⌘/ shortcut cheat-sheet — same portal/scrim mechanics as the palette.
          Reads the LIVE keybinding overrides so user rebinds show correctly. */}
      <ShortcutSheet
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
        keybindings={keybindings}
        onCustomize={() => { setSettingsInitialTab("commands"); setSettingsOpen(true); }}
      />

      {/* Full-window drag-and-drop import (Tauri webview drag events; see
          DropTarget.tsx). Main window only — PanelApp never mounts this.
          Media drops reuse loadLocalPath (same core as the Import button,
          so recents/restore work automatically); transcript drops reuse
          the Import-transcript core. */}
      <DropTarget
        busy={status === "fetching" || status === "exporting" || playbackPrepBusy || webPlayback.downloading}
        hasSource={hasSource}
        onImportMedia={(p) => { void loadLocalPath(p); }}
        onImportTranscript={(p) => { void loadTranscriptPath(p); }}
        notify={pushNotification}
      />

      {/* Single app-wide live region (visually hidden) — announces the
          long-running pipeline milestones to screen readers. Driven by the
          same state the Sidebar/LogsPanel render, so it can't drift. Kept
          to ONE region: a change in this string is announced politely. */}
      <div className="cp-a11y-status" role="status" aria-live="polite">
        {status === "exporting" ? "Exporting…"
          : transcriptState === "running"
            ? (transcriptPhase?.startsWith("diarize") ? "Detecting speakers…" : "Transcribing…")
            : status === "success" ? "Export complete"
              : status === "error" ? "Operation failed — check the pipeline log"
                : transcriptState === "error" ? "Transcription failed"
                  : transcriptState === "done" ? "Transcript ready"
                    : ""}
      </div>
    </div>
  );
}
