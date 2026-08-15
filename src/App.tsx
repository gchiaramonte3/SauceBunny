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
import { LibraryBrowser } from "./components/LibraryBrowser";
import { useLibraryScan } from "./hooks/use-library-scan";
import type { LibraryCrumb } from "./lib/library";
import { Sidebar } from "./components/Sidebar";
import { PeoplePanel } from "./components/PeoplePanel";
import { ReactionLayer } from "./components/ReactionLayer";
import { MediaSpikePanel } from "./components/MediaSpikePanel";
import { PeerStreamSpike } from "./components/PeerStreamSpike";
import { CoReviewLobby } from "./components/CoReviewLobby";
import { Monitor, type AspectId } from "./components/Monitor";
import type { Notif } from "./components/NotificationBell";
import type { ToastKind } from "./components/CanvasToast";
import { playSuccess, playError, playInfo } from "./lib/sound";
import { Transport } from "./components/Transport";
import { Timeline } from "./components/Timeline";
import { ViewOptions } from "./components/ViewOptions";
import { LogsPanel } from "./components/LogsPanel";
import { RoomControlBar } from "./components/RoomControlBar";
import { reactionGlyph } from "./lib/reactions";
import { ReviewStatusChip } from "./components/ReviewStatusChip";
import { useMediaCapture, subscribeCaptureError, setCaptureLogSink } from "./hooks/use-media-capture";
import { SettingsModal, type Defaults, type CaptionFontKey } from "./components/SettingsModal";
import { YouTubeAuthModal } from "./components/YouTubeAuthModal";
import type { PlayerHandle } from "./components/player-handle";
import type {
  AppError, AppStatus, ClientLog, DoneEvent, ExportOpts,
  LocalFileMeta, LogEvent, Metadata, ProgressEvent, QueuedClip, QueueSource, RecentClip,
  SourceKind, WarmStart, WhisperModel,
  ReviewRangeDraft,
} from "./types";
import { isQueuedClip } from "./types";
import { asLogTag } from "./types";
import { formatError, humanizeSpawnError, isAppError } from "./lib/error-format";
import { fmtElapsed, stageLabel } from "./lib/elapsed";
import { checkForUpdate } from "./lib/update-check";
import { fetchButtonPhase, type StatefulPhase } from "./lib/stateful-phase";
import { getPlayheadFrames, setPlayheadFrames as publishPlayheadFrames, playheadFramesToSeconds, playheadSecondsToFrames, markUserSeek } from "./lib/playhead-store";
import { endSeekFrames } from "./lib/playhead-clock";
import { usePanelBus } from "./hooks/use-panel-bus";
import { useStreamRung } from "./hooks/use-stream-rung";
import { clipTranscriptPath, type ActiveTranscript } from "./lib/transcript-owner";
import { useTransport } from "./hooks/use-transport";
import { useWebPlayback } from "./hooks/use-web-playback";
import { useCoReview, type ReviewMarkerView, type ReviewAnnotationView, type SessionSource } from "./hooks/use-co-review";
import { QueueDrawer } from "./components/QueueDrawer";
import { TranscriptReader } from "./components/TranscriptReader";
import { TranscriptViewer } from "./components/TranscriptViewer";
import { ReaderPlayerStage, type ReaderSource } from "./components/ReaderPlayerStage";
import { ReaderAnalysis } from "./components/ReaderAnalysis";
import { CommandPalette } from "./components/CommandPalette";
import { ShortcutSheet } from "./components/ShortcutSheet";
import { DropTarget } from "./components/DropTarget";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { RoomSourceBar } from "./components/RoomSourceBar";
import { VIDEO_EXTENSIONS, AUDIO_EXTENSIONS, TRANSCRIPT_EXTENSIONS } from "./lib/import-extensions";
import {
  recordTranscript,
  findForSource,
  touchEntry,
  removeEntry as removeTranscriptEntry,
  renameEntryPath as renameTranscriptEntryPath,
  getHistory as getTranscriptHistory,
  type TranscriptHistoryEntry,
} from "./lib/transcript-history";
import { prepareCues, renameSpeakerOverridesPath } from "./components/transcript/helpers";
import {
  deriveOnboardingSteps, onboardingComplete,
  loadOnboardingDismissed, saveOnboardingDismissed,
  type OnboardingStepId,
} from "./lib/onboarding";
import type { Command } from "./lib/commands";
import { buildCommands } from "./lib/commands";
import { useBatchTranscribe } from "./hooks/use-batch-transcribe";
import { TranscriptSearchModal } from "./components/TranscriptSearchModal";
import { batchSummary } from "./lib/batch-queue";
import {
  loadKeybindings, saveKeybindings, buildComboMap, bindingsFor, formatCombo, eventToCombo,
  KEY_ACTION_BY_ID, isPlaybackScoped, VIEWS_WITH_A_PLAYER,
  type KeyActionId, type KeybindingOverrides,
} from "./lib/keybindings";
import { migrateLegacyStorageKeys } from "./lib/migrate-storage";
import { loadActiveTab } from "./lib/tab-state";
import { sanitizePlaybackRate, stepPlaybackRate } from "./lib/playback-rate";
import { parseSrt } from "./lib/srt";
import { speakerLanes } from "./lib/speaker-stats";
import { speakerColor, loadSpeakerOverrides, resolveAliasChain, SPEAKERS_CHANGED_EVENT } from "./components/transcript/helpers";
import { speakerFingerprint, seedSpeakerOverridesFromFingerprint, linkSpeakerOverridesToFingerprint } from "./lib/speaker-identity";
import { MediaInfoModal } from "./components/MediaInfoModal";
import { loadReview, saveReview, ensureVersion, setActiveVersion, removeVersion, unlinkFingerprint, canUnlinkVersion, carriedComments, statusOf, commentMarkers as reviewMarkersOf, annotationsOf, reviewFingerprint, resolveByFingerprint, linkFingerprint, upsertReviewHistory, loadReviewer, reviewerColorFor, initialsOf, REVIEW_CHANGED_EVENT, type AnnotationStrokes } from "./lib/review";
import { loadChapters, adoptSourceChapters, CHAPTERS_CHANGED_EVENT, type Chapter as ChapterMarker } from "./lib/chapters";
import { appUndo } from "./lib/undo";
import { loadClipQueue, loadJson, saveClipQueue, saveJson } from "./lib/storage";
import { loadRecentSources, saveRecentSources, upsertRecent, removeRecent, type RecentSource } from "./lib/recent-sources";
import {
  durationToTc, framesToTc, secondsToTc,
  tcToFrames, tcToSeconds,
} from "./lib/timecode";
import { isLikelyVideoUrl, normalizeUrl, hostnameOf, youTubeThumbnailUrl, isYouTubeBotError, needsCookiesError, looksLikeExtractorRot, prettyHost } from "./lib/validation";
import { sanitizeFilename, suggestFilename } from "./lib/filename";
import { EXPECTED_BACKEND_BUILD_ID, type BuildIdCheck } from "./lib/build-id";
import { capabilitySummary, probePlatformCapabilities } from "./lib/platform-capabilities";
import { onReviewStoreProblem } from "./lib/review-store";
import { assetUrl } from "./lib/asset-url";
import { buildDiagnosticsReport, diagnosticsFilename } from "./lib/diagnostics";
import { extractFrameAsBlob, extractPosterBlob, canMediabunnyDecode } from "./lib/mediabunny-helpers";
import { frameToAvatarDataUrl } from "./lib/avatar";
import { chosenPosterFor, sourceTimecodeFor, setSourceTimecode, clearSourceTimecode } from "./lib/library";
import { webPosterFor, setWebPoster } from "./lib/web-poster-store";
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
export type AppView = "home" | "library" | "clip" | "coreview" | "reader";

// v2 bump: re-encode default flipped from ON to OFF. Older v1 settings are
// intentionally abandoned so users get the new, much faster default.
const DEFAULTS_KEY  = "cp-defaults-v2";
const RECENTS_KEY   = "cp-recents";
const ASPECT_KEY    = "cp-aspect";

// In-browser audio extraction (mediabunny/WebCodecs → OfflineAudioContext)
// decodes the WHOLE track into memory at the source sample rate, so it's only
// safe for short clips — beyond this duration we always use the streaming,
// constant-memory ffmpeg path instead. And even under the cap we race the
// extraction against this timeout so a stalled WebView decode degrades to
// ffmpeg rather than hanging the run at 0% forever.
const WEBCODECS_EXTRACT_MAX_SEC = 20 * 60;
const WEBCODECS_EXTRACT_TIMEOUT_MS = 120_000;

/** Hard cap on retained pipeline-log rows (oldest dropped). Generous on
 *  purpose: this is the no-telemetry bug-report path, so losing the head of a
 *  sidecar run would cost more than the memory it saves. */
const LOG_MAX = 5000;

// One-shot rebrand migration (clippull.* → saucebunny.*). Runs at module load,
// before App renders so the default-loading useState initializers see the
// migrated keys. Body lives in lib/migrate-storage.ts.
migrateLegacyStorageKeys();


/** Human size for the Tier C transfer UI: "4.1 GB", "820 MB", "12 KB". */
function formatTransferSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 KB";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${Math.round(mb)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

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
      // Co-review mesh TURN relay (Settings -> General); empty = STUN only.
      turnUrl: stored.turnUrl ?? "",
      turnUsername: stored.turnUsername ?? "",
      // NEVER hydrated from localStorage: the password lives in the macOS
      // Keychain (r140) and is loaded by the effect below. Pre-r140 installs
      // that persisted it are migrated (and the stored copy stripped) there
      // too. It used to ride settings-export files via the defaults object.
      turnPassword: "",
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
      // r141 cache retention: 0 = keep everything (the long-standing
      // default). A positive cap LRU-prunes the media cache at boot and
      // whenever the cap is changed in Settings.
      mediaCacheCapGb: stored.mediaCacheCapGb ?? 0,
      clearCacheOnQuit: stored.clearCacheOnQuit ?? false,
      // r143: NLE-style audio blips while dragging the playhead (WebCodecs
      // player). Editors expect scrub audio, so it defaults on.
      scrubAudio: stored.scrubAudio ?? true,
    };
  });
  const setDefaults = useCallback((d: Defaults | ((prev: Defaults) => Defaults)) => {
    setDefaultsState((prev) => {
      const next = typeof d === "function" ? (d as (p: Defaults) => Defaults)(prev) : d;
      // The TURN password is Keychain-only (r140): persist the shape with the
      // secret blanked so localStorage (and anything that reads it, like the
      // settings exporter) never carries it again.
      saveJson(DEFAULTS_KEY, { ...next, turnPassword: "" });
      return next;
    });
  }, []);

  // TURN password ⇄ Keychain (r140). On mount: migrate a pre-r140 localStorage
  // copy into the Keychain (stripping the stored one), else hydrate from the
  // Keychain. After that, edits to the field write through (debounced; empty
  // clears the entry). The first tick is skipped so a mount with the
  // still-empty default can't clear a real entry before hydration lands.
  const turnPwReadyRef = useRef(false);
  useEffect(() => {
    (async () => {
      try {
        const legacy = loadJson<Record<string, unknown>>(DEFAULTS_KEY, {});
        const legacyPw = typeof legacy.turnPassword === "string" ? legacy.turnPassword : "";
        if (legacyPw) {
          await invoke("set_turn_password", { password: legacyPw });
          saveJson(DEFAULTS_KEY, { ...legacy, turnPassword: "" });
          setDefaultsState((d) => ({ ...d, turnPassword: legacyPw }));
        } else {
          const pw = await invoke<string>("get_turn_password");
          if (pw) setDefaultsState((d) => ({ ...d, turnPassword: pw }));
        }
      } catch {
        // Keychain unavailable (locked, denied): the field still works for
        // this session; nothing is persisted anywhere.
      } finally {
        turnPwReadyRef.current = true;
      }
    })();
  }, []); // mount-only by design
  useEffect(() => {
    if (!turnPwReadyRef.current) return;
    const t = window.setTimeout(() => {
      invoke("set_turn_password", { password: defaults.turnPassword }).catch(() => {
        /* surfaced implicitly: the field empties on next launch */
      });
    }, 600);
    return () => window.clearTimeout(t);
  }, [defaults.turnPassword]);

  // Cache retention (r141), one shot at boot: re-sync the clear-on-quit
  // marker file with the stored pref (settings imports and app-data resets
  // can leave them disagreeing), then enforce the size cap so the cache
  // converges even if Settings is never opened. Nothing is playing yet, so
  // no exclude list; anything a restored session starts playing has a fresh
  // mtime and sits at the back of the LRU line anyway.
  const cacheRetentionBootRef = useRef({
    cap: defaults.mediaCacheCapGb,
    clearOnQuit: defaults.clearCacheOnQuit,
    done: false,
  });
  useEffect(() => {
    const boot = cacheRetentionBootRef.current;
    if (boot.done) return;
    boot.done = true;
    invoke("set_clear_cache_on_quit", { enabled: boot.clearOnQuit }).catch(() => {
      /* stale binary; the Settings toggle re-writes it */
    });
    if (boot.cap > 0) {
      invoke<number>("enforce_media_cache_cap", {
        maxBytes: boot.cap * 1024 * 1024 * 1024,
        exclude: [],
      }).catch(() => { /* cache dir may not exist yet */ });
    }
  }, []); // mount-only by design

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
        appendLog("info", "yt-dlp", `${cmd} failed with sign-in cookies. Retrying without…`);
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
  // First-launch welcome screen (r123). Gated on its own flag, independent
  // of the YouTube-auth onboarding latch below.
  const [showWelcome, setShowWelcome] = useState<boolean>(() => {
    try { return localStorage.getItem("saucebunny.welcomed") !== "1"; } catch { return false; }
  });

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
  // Tier B adaptive quality (step 3e). Active only for a PEER source, where
  // another Mac is transcoding on our behalf; a web stream has no rung and the
  // request stays byte-identical to what earlier builds sent.
  const streamRung = useStreamRung(activeSourceUrl?.startsWith("peer://") ?? false);
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

  /**
   * Player for the WEB download-fallback cached copy (r122). Mirror of the
   * r107 mediabunny-first lesson: native <video> over asset:// silently hangs
   * on large files (black canvas, often no error event), and the cached copy
   * of a long source is exactly that. Default mediabunny: the download
   * cascade always produces H.264+AAC MP4, which WebCodecs decodes on every
   * Apple Silicon Mac. A background probe demotes to native in the rare case
   * mediabunny can't read the file, and one runtime error swaps players once
   * (guarded per cache path so it can't loop).
   */
  const [webCachedPlayer, setWebCachedPlayer] = useState<"mediabunny" | "native">("mediabunny");
  const webCachedSwapRef = useRef<string | null>(null);

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
    // Unknown duration must not reject TC input (max would be 0 and every
    // entry would fail the <= max check) — same invariant as playhead-clock.
    const max = durationFrames > 0 ? durationFrames - 1 : Infinity;
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
  // Restored from the last session. Only items still "queued" are persisted
  // (see saveClipQueue): a finished row points at a file on disk and a failed
  // one at an error from a session that is over, and greeting someone with
  // yesterday's results in a to-do panel is not resumption.
  const [clipQueue, setClipQueue] = useState<QueuedClip[]>(() => loadClipQueue(isQueuedClip));
  useEffect(() => { saveClipQueue(clipQueue); }, [clipQueue]);
  // Right queue/tools drawer visibility — boots OPEN for a fresh profile
  // (both side panels visible, so the Clip view explains itself), and only
  // an explicit user toggle persists a preference (setQueueOpenChoice
  // below). Programmatic opens/closes — transcript auto-open, Clear-all,
  // the panel pop-out bridge — use setQueueOpen and never write the pref,
  // so session mechanics can't overwrite the user's choice.
  // loadJson/saveJson like every sibling pref (review fix: this was the
  // one pref hand-rolling "1"/"0" strings, invisible to storage audits).
  const [queueOpen, setQueueOpen] = useState<boolean>(() => loadJson("saucebunny.queueOpen", true));
  // Timeline range click (8a): open the drawer and focus that queue item.
  const [queueFocusItem, setQueueFocusItem] = useState<{ id: string; tick: number } | null>(null);
  /** User-initiated drawer visibility (toolbar toggle, ⌘⇧Q, palette, menu,
   *  the drawer's close button) — applies AND persists the choice. */
  const setQueueOpenChoice = useCallback((next: boolean | ((p: boolean) => boolean)) => {
    setQueueOpen((p) => {
      const v = typeof next === "function" ? next(p) : next;
      saveJson("saucebunny.queueOpen", v);
      return v;
    });
  }, []);
  // ── Top-level view (nav rail): Home / Library / Clip / Co-Review ──
  // Single state switch — no router (CLAUDE.md). Every launch lands on Home
  // (user decision, r140): the poster wall is the app's front door, and Clip
  // is one click away from the hero or any card. The view is session state,
  // not a persisted preference — the old restore-where-you-left-it behavior
  // meant relaunching mid-edit dropped you into a Clip view whose source had
  // not loaded yet.
  // The panel window (?window=panel) never mounts App, so it's untouched.
  const [activeView, setActiveViewState] = useState<AppView>("home");
  const setActiveView = useCallback((v: AppView) => {
    setActiveViewState(v);
    // Arriving at Clip always presents the full workbench: both side panels
    // open on EVERY entry (nav, shortcut, imports all route through here).
    // Raw setters on purpose — this is an arrival default, not a user toggle,
    // so it must not overwrite the persisted preference the toggles write.
    if (v === "clip") {
      setSidebarOpen(true);
      setQueueOpen(true);
    }
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
  const libraryViewRef = useRef<HTMLDivElement>(null);
  const clipViewRef = useRef<HTMLDivElement>(null);
  const coreviewViewRef = useRef<HTMLDivElement>(null);
  const readerViewRef = useRef<HTMLDivElement>(null);
  // Shared library scan state — owned here so Home's shelves and the Library
  // browser read the SAME scan results (switching views never rescans) and
  // the same thumbnail cache. Both views are keep-alive-mounted below.
  // Poster warm-up runs only while a poster wall is actually on screen.
  //
  // use-lazy-thumbnails states the intent — "booting into Clip costs zero
  // thumbnail work" — but the sweep itself fired whenever the scans settled,
  // whatever view was in front, so watching a clip competed with decoding
  // every poster in every root. Live rather than latched, and safe to flip:
  // prefetchThumbnails skips anything already cached, failed or in flight and
  // supersedes its own older sweep, so coming back resumes over the remainder
  // instead of starting again.
  const lib = useLibraryScan(activeView === "home" || activeView === "library");
  // Batch transcription runs OUTSIDE the single-source pipeline (see the hook),
  // so a folder can transcribe in the background while the user keeps working.

  // Home drill-in → Library handoff: the folder chain to select, plus a tick so
  // the same chain re-applies on repeat drills. One detail browser, not two.
  const [librarySelection, setLibrarySelection] = useState<LibraryCrumb[] | null>(null);
  const [librarySelectTick, setLibrarySelectTick] = useState(0);
  // Left source/export sidebar visibility — persisted, mirroring the right
  // drawer's toolbar toggle. Defaults open.
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    try { return localStorage.getItem("saucebunny.sidebarOpen") !== "0"; } catch { return true; }
  });
  // Persisted ONLY by setSidebarOpenChoice - setActiveView's arrival
  // force-open uses the raw setter and must not overwrite the preference.
  const setSidebarOpenChoice = useCallback((v: boolean) => {
    setSidebarOpen(v);
    try { localStorage.setItem("saucebunny.sidebarOpen", v ? "1" : "0"); } catch { /* quota */ }
  }, []);
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

  // A folder chosen in Settings/onboarding must apply to the source already
  // loaded, not only the next one (exportOpts.folder is otherwise seeded
  // once at load time).
  useEffect(() => {
    if (defaults.folder) setExportOpts((p) => (p.folder ? p : { ...p, folder: defaults.folder }));
  }, [defaults.folder]);

  const selectedModel = whisperModels.find((m) => m.id === defaults.whisperModel);
  const whisperModelDownloaded = !!selectedModel?.downloaded;
  // The transcribe UI must reflect the SELECTED engine, not just Whisper -
  // a Parakeet-only user was told to "Set up Whisper" with no Generate.
  const [parakeetReady, setParakeetReady] = useState(false);
  useEffect(() => {
    if (defaults.transcriptionEngine !== "parakeet") return;
    let live = true;
    void invoke<boolean>("parakeet_model_downloaded")
      .then((r) => { if (live) setParakeetReady(r); })
      .catch(() => { if (live) setParakeetReady(false); });
    return () => { live = false; };
  }, [defaults.transcriptionEngine, transcriptState]);
  const whisperModelReady =
    defaults.transcriptionEngine === "parakeet" ? parakeetReady : whisperModelDownloaded;
  const whisperModelLabel =
    defaults.transcriptionEngine === "parakeet" ? "Parakeet" : (selectedModel?.name ?? defaults.whisperModel);

  // ====== Recents ======
  // Recent clips keep EVERY export (capped) — the sidebar GROUPS them by
  // source at render time: the newest export leads each group, a chevron
  // reveals the rest. Storage stays flat and dumb.
  const [recents, setRecents] = useState<RecentClip[]>(() => loadJson<RecentClip[]>(RECENTS_KEY, []));
  const pushRecentClip = (prev: RecentClip[], r: RecentClip): RecentClip[] =>
    [r, ...prev].slice(0, 12);
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
  // Dev-only capture spike (live-presence Prompt 0): renders ONLY when the
  // localStorage flag is set. Ships nothing user-visible.
  const [mediaSpikeOpen, setMediaSpikeOpen] = useState<boolean>(() => {
    if (!import.meta.env.DEV) return false;
    try { return localStorage.getItem("saucebunny.devMediaSpike") === "1"; } catch { return false; }
  });
  // Dev-only Tier B 3a spike: stream the loaded local file through the
  // proxy's peer routes with the real MSE player (peer-media plan).
  const [peerSpikeOpen, setPeerSpikeOpen] = useState<boolean>(() => {
    if (!import.meta.env.DEV) return false;
    try { return localStorage.getItem("saucebunny.devPeerStream") === "1"; } catch { return false; }
  });
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
  const [activeTranscript, setActiveTranscript] = useState<ActiveTranscript | null>(null);
  // Fresh mirror so the (deps-[]) Clear handler can forget the exact transcript
  // it's showing without going stale.
  const activeTranscriptRef = useRef(activeTranscript);
  activeTranscriptRef.current = activeTranscript;
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
  const [speakersChangedTick, setSpeakersChangedTick] = useState(0);
  const [speakerLaneData, setSpeakerLaneData] = useState<
    { startMs: number; endMs: number; color: string; speaker: string | null }[]
  >([]);
  /** The Clip's current subject. Declared here because the transcript-owner
   *  gate below needs it, and a second derivation of the same idea is how the
   *  two drift apart. */
  const clipSourceKey = localFilePath ?? metadata?.webpage_url ?? activeSourceUrl ?? null;
  const transcriptPath = activeTranscript?.path ?? null;
  /**
   * What the CLIP may render. The reader and the Clip share `activeTranscript`,
   * so opening a transcript in the reader used to retarget the Clip's captions,
   * transcript panel, AI summary and speaker lanes onto a file the Clip was not
   * playing — one film's dialogue burned over another film's picture, with
   * nothing erroring. The rule lives in lib/transcript-owner.ts.
   */
  const clipTxPath = clipTranscriptPath(activeTranscript, clipSourceKey);
  const clipSourceKeyRef = useRef(clipSourceKey);
  clipSourceKeyRef.current = clipSourceKey;
  useEffect(() => {
    // The Clip's OWN transcript: timeline speaker lanes drawn from a
    // transcript of a different file are the same lie the captions were.
    if (!clipTxPath) { setSpeakerLaneData([]); return; }
    let alive = true;
    void (async () => {
      try {
        const text = await invoke<string>("read_text_file_capped", {
          path: clipTxPath,
          maxBytes: 8 * 1024 * 1024,
        });
        if (!alive) return;
        const ovForCues = loadSpeakerOverrides(clipTxPath);
        // Reassigned cues repaint the timeline's speaker lanes. The old
        // per-turn layer never reached here either.
        const cues = prepareCues(parseSrt(text), ovForCues);
        if (!cues.some((c) => c.speaker !== null)) { setSpeakerLaneData([]); return; }
        // 3a fix: resolve each lane's color through the SAME override path
        // the transcript uses (alias chain -> user-picked color -> palette).
        // Reading overrides here + the speakers-changed dep below is what
        // makes a recolor in Manage speakers repaint the lane instantly.
        const ov = loadSpeakerOverrides(clipTxPath);
        const laneColor = (tag: string | null) => {
          const resolved = resolveAliasChain(tag, ov.aliases);
          return ov.colors[resolved ?? "__NULL__"] || speakerColor(resolved);
        };
        setSpeakerLaneData(
          speakerLanes(cues).map((lane) => ({ ...lane, color: laneColor(lane.speaker) })),
        );
      } catch {
        if (alive) setSpeakerLaneData([]);
      }
    })();
    return () => { alive = false; };
  }, [clipTxPath, transcriptArrivedTick, speakersChangedTick]);
  // Recolor signal: the transcript fires saucebunny:speakers-changed as a
  // window CustomEvent (same window) AND a Tauri event (panel window).
  useEffect(() => {
    const bump = () => setSpeakersChangedTick((t) => t + 1);
    window.addEventListener(SPEAKERS_CHANGED_EVENT, bump);
    const un = listen(SPEAKERS_CHANGED_EVENT, bump);
    return () => {
      window.removeEventListener(SPEAKERS_CHANGED_EVENT, bump);
      un.then((f) => f());
    };
  }, []);

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
      const next = [...prev, { id: logIdRef.current, ts: nowHms(), tag, source, message }];
      // The only session list with no bound. ffmpeg's `frame=/time=` progress
      // carries no percent, so the collapse above misses it and a long run
      // appends a row per tick, each an O(n) copy that LogsPanel then renders.
      // The cap is deliberately generous: diagnostics reports "last 300 of N"
      // (diagnostics.ts), and a tight cap would quietly make N stop meaning
      // what it says on the one path users have for reporting a bug.
      return next.length > LOG_MAX ? next.slice(next.length - LOG_MAX) : next;
    });
  }, []);

  // Startup capability line + a catch-all for silent promise rejections
  // (r150). Both exist because a CSP that forbade WebAssembly made the Opus
  // decoder's init PARK rather than throw: audio went silent with no error on
  // any layer, in the packaged app only, and it took three reports and a
  // WKWebView A/B to find. There was exactly ONE unhandled rejection carrying
  // the real reason and nothing surfaced it. Now the log answers "can this
  // build run WASM?" before anyone has to ask.
  useEffect(() => {
    void probePlatformCapabilities().then((caps) => {
      appendLog(caps.wasm && caps.blobWorker ? "info" : "warn", "media", capabilitySummary(caps));
    });
    const onRejection = (e: PromiseRejectionEvent) => {
      appendLog("warn", "media", `Unhandled rejection: ${String(e.reason)}`);
    };
    window.addEventListener("unhandledrejection", onRejection);
    // Review notes that fail to reach disk must SAY so while the user can
    // still act (r151). This was console.warn only, in an app with no console.
    const unsubReview = onReviewStoreProblem(({ message }) => {
      appendLog("err", "review", message);
      pushNotification("error", "Couldn't save review notes", message);
    });
    return () => {
      window.removeEventListener("unhandledrejection", onRejection);
      unsubReview();
    };
  }, [appendLog, pushNotification]);

  // ====== Web-source playback (r80) — stream ↔ download state machine ======
  // Owns the entire web stream → resolve → download-fallback → watchdog →
  // cache lifecycle that used to be ~300 lines of boolean/ref soup in this
  // file. Exposes a read-model (streamUrl/cachePath/codecs/downloading/…) the
  // Monitor consumes, plus stable actions. See src/hooks/use-web-playback.ts.
  const webPlayback = useWebPlayback({
    appendLog,
    pushNotification,
    // Playhead at dispatch time, for the download fallback's position
    // handoff (RC4). fps via ref-free read: round at call time.
    getPlayheadSeconds: () => getPlayheadFrames() / Math.max(1, Math.round(fpsRef.current)),
    maybePromptYtAuth,
    cookiesBrowser: cookiesBrowserOrNone,
    previewMaxHeight: defaults.previewMaxHeight,
  });
  const {
    loadWeb: loadWebPlayback,
    loadCached: loadCachedWebPlayback,
    reset: resetWebPlayback,
    stop: stopWebPlayback,
    onPlayerReady: webOnPlayerReady,
    onMediaError: webOnMediaError,
    consumeResume: webConsumeResume,
  } = webPlayback;
  // True while actively MSE-streaming a web source (not yet downloaded to
  // cache). Gates the audio pre-cache, caption auto-fetch, caption-sync offset.
  const webStreaming = webPlayback.state.kind === "streaming";

  // Pick the player for the download-fallback cached copy (r122). Reset to
  // the mediabunny default on every new cache path, then let a background
  // probe demote to native only if WebCodecs genuinely can't read the file.
  // (The cascade always yields H.264+AAC MP4, so demotion is the rare case.)
  useEffect(() => {
    const p = webPlayback.cachePath;
    if (!p) return;
    let live = true;
    setWebCachedPlayer("mediabunny");
    webCachedSwapRef.current = null;
    void canMediabunnyDecode(p).then((ok) => {
      if (live && !ok) setWebCachedPlayer("native");
    });
    return () => { live = false; };
  }, [webPlayback.cachePath]);

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
            `Backend build mismatch: frontend expects "${EXPECTED_BACKEND_BUILD_ID}" but binary reports "${got}". Restart \`npm run tauri dev\` to rebuild.`);
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
  // Aborts the FRONTEND half of a transcription run — the mediabunny audio
  // extraction that happens in the browser BEFORE any backend job exists.
  // Stop can't cancel_job something that hasn't spawned yet, so handleStop
  // flips this to bail out of extraction and skip the backend invoke.
  const transcriptAbortRef = useRef<AbortController | null>(null);
  // Safari sign-in guidance (r123): picking Safari for cookies without Full
  // Disk Access silently degrades to no-auth (cookies_args skips it so the
  // fetch doesn't die) - the user believes they're signed in when they
  // aren't. Whenever the choice BECOMES safari (modal or Settings), probe
  // FDA; if missing, open the exact pane and say what to do in one line.
  const safariFdaPromptedRef = useRef(false);
  useEffect(() => {
    if (defaults.ytCookiesBrowser !== "safari") {
      safariFdaPromptedRef.current = false;
      return;
    }
    if (safariFdaPromptedRef.current) return;
    safariFdaPromptedRef.current = true;
    void invoke<boolean>("safari_fda_status").then((ok) => {
      if (ok) return;
      pushNotification("info", "One more step for Safari",
        "Turn on Sauce Bunny in the settings window that just opened, then load the video again.");
      void invoke("open_full_disk_access").catch(() => { /* best-effort */ });
    }).catch(() => { /* stale backend - Settings still shows the banner */ });
  }, [defaults.ytCookiesBrowser, pushNotification]);

  // Pipeline-log channel label for transcription ("whisper" | "parakeet"), in a
  // ref so the long-lived transcript-log listener tags lines with the engine
  // that's actually running rather than a hardcoded "whisper".
  /** Current pipeline stage + when it started, so each stage can report its
   *  own duration in the log as the next one begins. */
  const stageClockRef = useRef<{ phase: string | null; at: number }>({ phase: null, at: 0 });
  /** When the whole transcription run started, for the closing total. */
  const jobStartedRef = useRef(0);
  const txChannelRef = useRef<"whisper" | "parakeet">("whisper");
  /** Close out the last stage and report the run total. Called when a
   *  transcription finishes, so the log ends with a number the user can read
   *  off ("Whisper finished in 6m 08s." / "Total 7m 12s."). */
  const logRunTotals = useCallback(() => {
    const stage = stageClockRef.current;
    if (stage.phase) {
      appendLog("info", txChannelRef.current,
        `${stageLabel(stage.phase)} finished in ${fmtElapsed(Date.now() - stage.at)}.`);
    }
    if (jobStartedRef.current) {
      appendLog("ok", txChannelRef.current,
        `Total ${fmtElapsed(Date.now() - jobStartedRef.current)}.`);
    }
    stageClockRef.current = { phase: null, at: 0 };
    jobStartedRef.current = 0;
  }, [appendLog]);
  txChannelRef.current = defaults.transcriptionEngine === "parakeet" ? "parakeet" : "whisper";
  // Snapshot of the source's title/thumbnail taken when a SINGLE clip export
  // starts, so the Recent entry is attributed to the source that was exported
  // even if the user switches sources before clip-done fires (the listener
  // guards only on job_id, which we must keep live to resolve the queue).
  const clipJobMetaRef = useRef<{ title: string; thumbnail: RecentClip["thumbnail"]; source?: string; inTc: string; outTc: string } | null>(null);
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
  const webPlaybackRef = useRef(webPlayback);
  webPlaybackRef.current = webPlayback;
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
          if (m) {
            const span =
              (tcToSeconds(m.outTc, f) ?? 0) - (tcToSeconds(m.inTc, f) ?? 0);
            const dur = span > 0 ? secondsToTc(span, f) : "Full";
            const r: RecentClip = {
              id: Math.random().toString(36).slice(2),
              title: m.title,
              path: e.payload.path,
              dur,
              when: Date.now(),
              thumbnail: m.thumbnail,
              source: m.source,
            };
            setRecents((prev) => pushRecentClip(prev, r));
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
          // Humanize AFTER classifyExtractorRot sees the raw text (the
          // humanizer only rewrites EACCES spawn failures, but keep the
          // ordering honest anyway).
          classifyExtractorRot(e.payload.error ?? "");
          const msg = humanizeSpawnError(e.payload.error ?? "Export failed");
          setErrorDetail(msg);
          notify("Export failed", msg);
          pushNotification("error", "Export failed", msg);
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
          setActiveTranscript({ path: e.payload.path, origin: "captions", sourceKey: clipSourceKeyRef.current });
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
          const msg = humanizeSpawnError(e.payload.error ?? "Caption download failed");
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
          logRunTotals();
          appendLog("ok", txChannelRef.current, `Transcript saved → ${e.payload.path}`);
          // Load into the Transcript tab (same pulse-and-switch behavior
          // as the captions path above).
          setActiveTranscript({ path: e.payload.path, origin: "whisper", sourceKey: clipSourceKeyRef.current });
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
          logRunTotals();
          appendLog("warn", txChannelRef.current, "Transcription cancelled");
        } else {
          setTranscriptState("error");
          setTranscriptResolution("error"); // GenerateButton → cross flash
          setTranscriptPhase(null);
          const msg = humanizeSpawnError(e.payload.error ?? "Transcription failed");
          logRunTotals();
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
        // Close out the previous stage in the pipeline log. Every long
        // pipeline reports its phases through this one event, so timing them
        // here covers whisper, parakeet and each diarize step at once - and
        // gives a number the user can read off and paste back when something
        // is slower than it should be.
        const stage = stageClockRef.current;
        if (stage.phase && stage.phase !== e.payload.phase) {
          appendLog("info", txChannelRef.current,
            `${stageLabel(stage.phase)} finished in ${fmtElapsed(Date.now() - stage.at)}.`);
        }
        if (stage.phase !== e.payload.phase) {
          stageClockRef.current = { phase: e.payload.phase, at: Date.now() };
          // Each stage owns its own 0-100 meter (extract %, then whisper %), so
          // reset on the transition — otherwise the pill would flash the prior
          // stage's trailing value (e.g. "Whisper 99%") until the next tick.
          setTranscriptProgress(0);
        }
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
      // Cleanup that fired DURING the awaits above found an empty array and
      // unregistered nothing — under StrictMode that leaked all 15 listeners
      // on every dev boot. The handlers were inert (each starts with a
      // `mounted` check) but still registered forever. Sweep them here; the
      // registration order is load-bearing, so this stays a tail check
      // rather than a Promise.all restructure.
      if (!mounted) {
        unlistens.forEach((u) => u());
        unlistens.length = 0;
      }
    })();
    return () => {
      mounted = false;
      unlistens.forEach((u) => u());
    };
    // appendLog / refreshWhisperModels / notify / classifyExtractorRot are
    // all stable (empty deps), so this effect runs exactly once for the
    // app's lifetime.
  }, [appendLog, refreshWhisperModels, notify, pushNotification, classifyExtractorRot, logRunTotals]);

  // ====== Player callbacks ======
  // Sync our playhead from the YouTube player's current time while it's playing.
  const onPlayerTimeUpdate = useCallback((seconds: number) => {
    // ONE conversion formula, owned by the store — publishing through any
    // other math is how the 24-vs-30 fps split (0.8x post-seek slide) shipped.
    publishPlayheadFrames(playheadSecondsToFrames(seconds, fps));
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
    // RC4 position handoff: the download fallback carried the playhead the
    // stream died at through the machine (downloading → cached). The cached
    // LocalMediaPlayer boots at 0 — seek it back before the user notices.
    const wp = webPlaybackRef.current;
    if (wp.cachePath && wp.cachedResumeAt > 0.5) {
      const at = wp.cachedResumeAt;
      try { playerRef.current?.seekTo?.(at); } catch { /* best effort */ }
      markUserSeek(playheadSecondsToFrames(at, fpsRef.current));
      publishPlayheadFrames(playheadSecondsToFrames(at, fpsRef.current));
      // Review fix: one-shot. Without consuming, any later player remount
      // (error -> loaded status cycles) re-applied the stale death position.
      webConsumeResume();
    }
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
  }, [volume, muted, playbackRate, webOnPlayerReady, webConsumeResume]);

  // ====== Actions ======
  /**
   * Tears down everything tied to the previous source so a new one starts
   * from a clean slate. Critically resets `sourceKind` + `localFilePath` so
   * the Monitor doesn't render the old player while the new source loads.
   */
  // ── Filename dirty flag (PER-SOURCE, review fix) ─────────────────
  // Arms ONLY when the user edits the filename input (Sidebar calls
  // markFilenameEdited) and remembers WHICH source it was typed for. The
  // hydrate rule: the custom name is kept only while the loaded source is
  // the one it was typed for — a refetch of the same source keeps it, any
  // other source disarms the flag and reseeds from the new title. (The
  // previous session-sticky boolean kept one custom name for every future
  // source until relaunch; before that, a `prev.filename !== "clip"`
  // heuristic couldn't tell a typed name from the previous source's seed.)
  const currentSourceKeyRef = useRef<string>("");
  const filenameEditedForRef = useRef<string | null>(null);
  const markFilenameEdited = useCallback(() => {
    filenameEditedForRef.current = currentSourceKeyRef.current || null;
  }, []);
  /** True while the user's typed filename belongs to the CURRENT source. */
  const keepUserFilename = useCallback(
    () => filenameEditedForRef.current != null && filenameEditedForRef.current === currentSourceKeyRef.current,
    [],
  );
  /** The one hydrate rule, shared by warm/fresh/local hydrates. */
  const seedFilename = useCallback(
    (prevName: string, title: string) => (keepUserFilename() && prevName ? prevName : suggestFilename(title)),
    [keepUserFilename],
  );

  /**
   * Source-scoped reset — called at the TOP of every load path (handleFetch,
   * loadLocalPath, transcript-history opens). THE invariant: any future
   * source-scoped state must be cleared here.
   * CLEARED: playback/prep + captions/transcript jobs (canceled + disowned),
   *   metadata, error detail, rot verdict, logs, result path, progress,
   *   captions/transcript state, marks + TC fields, fetch/export phases,
   *   transcript resolution, ffmpeg clip job, and — whenever the incoming
   *   source differs from the one a custom name was typed for — the
   *   filename dirty flag and the filename itself (so the field and the
   *   WINDOW TITLE never show the previous source while the new one
   *   hydrates; a custom name survives only a same-source refetch).
   * KEPT (deliberately): the export queue + its history (job log spans
   *   sources), notifications, settings/prefs, review docs (keyed per
   *   source; they swap on their own), recents, the spent-URL rot map.
   *   The undo stack clears via its own sourceKey effect.
   */
  const resetForNewSource = useCallback((sourceKey: string) => {
    currentSourceKeyRef.current = sourceKey;
    // Per-source flag: same source (refetch) → the custom name survives;
    // different source → disarm and reseed. This is what the e2e pins.
    if (filenameEditedForRef.current !== sourceKey) filenameEditedForRef.current = null;
    if (filenameEditedForRef.current == null) {
      // Clear a non-edited filename immediately: titleSuffix derives from
      // it, so the previous source's name must not linger in the titlebar
      // during the fetch window. Hydrate reseeds from the new title.
      setExportOpts((prev) => (prev.filename === "clip" ? prev : { ...prev, filename: "clip" }));
    }
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
    // The REF has to go too, not just the state. It is the identity four other
    // places compare against, and leaving it pointing at the source we just
    // left made a co-review guest who had loaded that URL treat the
    // presenter's next LoadSource as "already on it" and ignore it - the
    // friend who sat looking at nothing while the host loaded a video.
    activeSourceUrlRef.current = null;
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
      const wm = warm.metadata;
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
      const m = await invoke<Metadata>("fetch_metadata", {
        url: full,
        cookiesBrowser: cookiesBrowserOrNone(),
      });
      if (sourceSeqRef.current !== seq) return; // user already moved on
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
  }, [url, appendLog, defaults, fallbackFps, resetForNewSource, pushNotification, maybePromptYtAuth, classifyExtractorRot, loadWebPlayback, loadCachedWebPlayback, recordRecentSource]);

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
    appendLog("info", "yt-dlp", "Extractor failure looks like a stale yt-dlp. Downloading the latest release…");
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
    appendLog("ok", "yt-dlp", `yt-dlp updated to ${version}. Retrying ${hostnameOf(u)}…`);
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
    | { kind: "ok"; bytesWritten: number; finalPath: string }
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
      // Persist via the RAW-BODY writer: the clip travels as the IPC body
      // itself. The old write_bytes_to_path route serialized the buffer as a
      // JSON number array — every byte decimal-printed into a string built
      // synchronously on the main thread. Measured at 100 MB: ~2s of frozen
      // UI and ~2.2 GB peak memory, repeated per queue item. The path rides
      // percent-encoded in a header (headers are Latin-1; titles aren't).
      // unique: destPath is derived (not saveDialog-vetted) — a collision
      // walks -2, -3 on disk exactly like create_clip, and NEVER fails
      // (review fix: this path used to hard-error on collision while the
      // web path uniquified, with the UI promising uniquing for both).
      const finalPath = await invoke<string>("write_raw_to_path", result.bytes, {
        headers: {
          "x-dest-path": encodeURIComponent(args.destPath),
          "x-unique": "1",
        },
      });
      return { kind: "ok", bytesWritten: result.bytes.byteLength, finalPath };
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

      // Seq + metadata snapshot: a source switched mid-export must not have
      // its status clobbered or its title stamped on the old clip's Recents
      // entry (same discipline as the web path's clipJobMetaRef).
      const exportSeq = sourceSeqRef.current;
      const exportMeta = metadataRef.current;
      const result = await runLocalClipExport({
        inputPath: localFilePath,
        startSeconds: startSec,
        endSeconds: endSec,
        format: isAudioOnly ? "audio-mp3" : "video-mp4",
        destPath,
        onProgress: setProgress,
      });
      if (sourceSeqRef.current !== exportSeq) return;

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
      // finalPath is what unique-mode actually wrote (name-2.mp4 on a
      // collision) — every surface below must show THAT name.
      setResultPath(result.finalPath);
      setProgress(0);
      const filename = result.finalPath.split("/").pop() ?? "Done.";
      appendLog("ok", "mediabunny",
        `Wrote ${(result.bytesWritten / 1_000_000).toFixed(1)} MB → ${result.finalPath}`);
      pushNotification("success", "Clip exported", filename, result.finalPath);
      notify("Clip exported", filename);

      // Add to recents.
      const m = exportMeta;
      if (m) {
        const dur = (endSec != null && startSec != null)
          ? secondsToTc(endSec - startSec, fps)
          : (m.duration != null ? secondsToTc(m.duration, fps) : "Full");
        const rc: RecentClip = {
          id: Math.random().toString(36).slice(2),
          title: m.title,
          path: result.finalPath,
          dur,
          when: Date.now(),
          thumbnail: m.thumbnail,
          source: localFilePath ?? undefined,
        };
        setRecents((prev) => pushRecentClip(prev, rc));
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
        ? {
            title: metadataRef.current.title,
            thumbnail: metadataRef.current.thumbnail,
            source: metadataRef.current.webpage_url ?? undefined,
            // Marks snapshot too: clearing/moving marks mid-export must not
            // relabel the finished clip's duration.
            inTc: exportOptsRef.current.inTc,
            outTc: exportOptsRef.current.outTc,
          }
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
  }, [metadata, sourceKind, localFilePath, exportOpts, fps, inFrames, outFrames, runLocalClipExport, appendLog, pushNotification, classifyExtractorRot, notify]);

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
      appendLog("info", "local", `Preparing playback copy (h264_videotoolbox)…`);
      const prepared = await new Promise<string>((resolve, reject) => {
        // Ownership-checked release: a superseding prep installs ITS resolver;
        // this run's late rejection must not clear it (it would strand the new
        // source's prep promise forever).
        const mine = { resolve, reject };
        playbackPrepResolverRef.current = mine;
        invoke("prepare_local_for_playback", {
          args: {
            input_path: inputPath,
            has_video: hasVideo,
            duration_seconds: durationSeconds,
            job_id: jobId,
          },
        }).catch((err) => {
          if (playbackPrepResolverRef.current === mine) {
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
      appendLog("ok", "local", `Playback copy ready → ${prepared}`);
    } catch (err) {
      if (sourceSeqRef.current !== seq) return;
      const msg = formatError(err);
      if (msg.includes("Source changed")) return;
      if (isMissingCommandError(err)) {
        const hint = staleBinaryMessage("prepare_local_for_playback");
        appendLog("err", "local", hint);
        pushNotification("error", "Rust backend out of date", hint);
      } else if (msg.includes("Cancelled") || msg === "Error: Cancelled") {
        appendLog("warn", "local", "Playback prep cancelled by user");
      } else {
        appendLog("warn", "local", `Playback prep failed, using original: ${msg}`);
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
  // A live session makes the Review room the working view: every source
  // open surfaces IT, not Clip (the two spaces share plumbing, not a home).
  // Ref, not state: loadLocalPath is defined before useCoReview runs.
  const sessionRoomRef = useRef(false);
  /** Latest active view for the keyboard bindings (they capture once). */
  const activeViewRef = useRef<string>("clip");
  const openSourceView = useCallback(() => {
    setActiveView(sessionRoomRef.current ? "coreview" : "clip");
  }, [setActiveView]);

  const loadLocalPath = useCallback(async (
    picked: string,
    // When an explicit transcript will be attached by the caller (Library
    // transcript-shelf open), skip the newest-transcript auto-loader so the
    // user's chosen entry wins the race instead of the auto-loaded one.
    skipAutoTranscript = false,
  ): Promise<{ message: string; kind: AppError["kind"] | null } | null> => {
    try {
      // Local-path purity (r112): the local pipeline must never receive a
      // web URL — web sources go through handleFetch (yt-dlp + proxy). The
      // backend guards this too (probe_local_file rejects URLs); failing
      // here as well keeps the mistake loud and immediate. AppError-shaped
      // so the catch below formats and classifies it like any backend error.
      if (/^https?:\/\//i.test(picked.trim())) {
        throw { kind: "Invalid", data: `Local import got a web URL (${picked}). This is a bug: web sources must go through Fetch.` } satisfies AppError;
      }
      // Surface the working view - Clip normally, but a live session's
      // room owns source opens (the Review workspace is sticky: loading
      // content must not bounce you out of the session).
      openSourceView();
      resetForNewSource(picked);
      const seq = ++sourceSeqRef.current;
      setStatus("fetching");
      appendLog("info", "local", `Opening local file: ${picked}`);

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
        has_subs: false, chapters: [], description: null,
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
              // Persist into the SAME hash-keyed thumb cache the ffmpeg path
              // uses and reference it via asset://. The old session blob: URL
              // pinned the decoded JPEG for the app's lifetime AND escaped
              // into persisted recents/queue rows, where it rendered as a
              // broken image after relaunch (blob URLs die with the page).
              const posterPath = await invoke<string>(
                "save_poster_to_cache",
                new Uint8Array(await blob.arrayBuffer()),
                {
                  headers: {
                    "x-source-path": encodeURIComponent(lf.path),
                    ...(chosen != null ? { "x-time-seconds": String(chosen) } : {}),
                  },
                },
              );
              if (sourceSeqRef.current !== seq) return;
              setMetadata((prev) => (prev ? { ...prev, thumbnail: assetUrl(posterPath) } : prev));
              return;
            }
            // Step 2: ffmpeg fallback (legacy path).
            const thumbPath = await invoke<string>("generate_local_thumbnail", {
              args: { input_path: lf.path, duration_seconds: lf.duration, time_seconds: chosen ?? null },
            });
            if (sourceSeqRef.current !== seq) return;
            setMetadata((prev) => (prev ? { ...prev, thumbnail: assetUrl(thumbPath) } : prev));
          } catch (err) {
            if (sourceSeqRef.current !== seq) return;
            appendLog("warn", "local", `Thumbnail generation failed: ${formatError(err)}`);
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
        filename: seedFilename(prev.filename, lf.filename.replace(/\.[^.]+$/, "")),
      }));
      appendLog(
        "ok",
        "local",
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
        appendLog("ok", "local",
          `Decoding via mediabunny (${vc || "?"} / ${ac || "?"}); no transcode.`);
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
      appendLog("info", "local",
        `Transcoding for playback: ${reasonParts.join(", ")}.`);
      await runPlaybackPrep(lf.path, lf.has_video, lf.duration, seq);
      return null;
    } catch (err) {
      const msg = formatError(err);
      setErrorDetail(msg);
      appendLog("err", "local", msg);
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
    // Interrupt the browser-side audio extraction (runs before any backend
    // job exists) and, for a live run, reset the transcript UI synchronously.
    // The backend whisper Terminated handler still emits a "Cancelled" done,
    // but its job_id no longer matches after we null it below, so it's a
    // no-op — this is what makes Stop instant AND the only reset when the
    // hang was in the pre-backend extraction phase.
    transcriptAbortRef.current?.abort();
    transcriptAbortRef.current = null;
    if (transcriptState === "running") {
      setTranscriptState("idle");
      setTranscriptResolution(null);
      setTranscriptError(null);
      setTranscriptProgress(0);
      setTranscriptPhase(null);
      setTranscriptJobId(null);
      // Null the ref NOW (not at next render) so the backend's own
      // "Cancelled" done event, which can land before React re-renders,
      // is ignored by the listener instead of double-logging.
      transcriptJobIdRef.current = null;
      appendLog("warn", txChannelRef.current, "Transcription cancelled");
    }
    for (const id of ids) {
      try {
        await invoke<boolean>("cancel_job", { jobId: id });
      } catch (err) {
        appendLog("err", "control", `Cancel failed: ${formatError(err)}`);
      }
    }
  }, [jobId, transcriptJobId, transcriptState, playbackPrepJobId, appendLog, webPlayback.downloading, stopWebPlayback]);

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
        "Mark the section with I and O.");
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
    pushMarksUndo("clear in/out", inFrames, outFrames, null, null);
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
    // Confirmed, like every other destructive action in the app — clearing
    // recents, deleting cached files and removing a library root all ask. The
    // queue was the one that did not, and it is the one holding work that
    // cannot be recreated by pressing a button again: each row is a range
    // somebody marked by hand.
    setClipQueue((prev) => {
      const pending = prev.filter((c) => c.status === "queued").length;
      if (pending > 0 && !confirm(
        `Clear ${pending} queued clip${pending === 1 ? "" : "s"}? `
        + "The marks you set for them are not saved anywhere else.",
      )) return prev;
      return [];
    });
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
      pushNotification("info", "Export in progress", "Wait for the current export to finish.");
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
          source: item.source.kind === "file" ? item.source.path : item.source.url,
        };
        setRecents((prev) => pushRecentClip(prev, rc));
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
          setClipQueue((prev) => prev.map((c) => c.id === item.id ? { ...c, status: "done", path: result.finalPath, error: undefined } : c));
          appendLog("ok", "mediabunny", `Wrote ${(result.bytesWritten / 1_000_000).toFixed(1)} MB → ${result.finalPath}`);
          pushQueueRecent(result.finalPath);
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
        appendLog("info", "queue", "create_clip failed with sign-in cookies. Retrying without…");
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
      // The dialog offers png - honor it (default stays JPEG).
      const snapMime = /\.png$/i.test(dest) ? "image/png" : "image/jpeg";
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
        const fromActive = await playerRef.current?.getFrameBlob?.(seconds, { mimeType: snapMime }).catch(() => null);
        // Step 2: try a fresh mediabunny pass on the original file.
        const blob = fromActive ?? (defaults.useWebCodecsDecoder
          ? await extractFrameAsBlob(localFilePath, seconds, { mimeType: snapMime }).catch(() => null)
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
          appendLog("info", "snapshot", "Mediabunny couldn't decode this codec. Falling back to ffmpeg.");
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
   * Grab the frame on screen right now as a cast member's face.
   *
   * "Sourced from the footage rather than a file picker" — a picker would ask
   * the user to go and find a photo of someone they are currently looking at.
   * The flow is: play a speaker's line (the roster's per-speaker play button
   * jumps straight to one), then take the frame.
   *
   * Three ways to get the pixels, in falling order of cheapness, and NONE of
   * them spawns a subprocess or writes a temp file. handleSnapshot's ffmpeg
   * fallbacks are deliberately not reused: a snapshot must succeed because the
   * user asked for a file, whereas a missing face is a shrug and a retry one
   * frame later. Paying a 200ms cold ffmpeg start for a 96px thumbnail would
   * be the wrong trade.
   */
  const grabFaceFromFrame = useCallback(async (): Promise<string | null> => {
    const seconds = getPlayheadFrames() / Math.max(1, Math.round(fps));
    // 1. The active player's own decoder — zero file IO (MediaBunnyPlayer).
    let blob = (await playerRef.current?.getFrameBlob?.(seconds).catch(() => null)) ?? null;
    // 2. A fresh mediabunny pass on the original file.
    if (!blob && sourceKind === "file" && localFilePath && defaults.useWebCodecsDecoder) {
      blob = await extractFrameAsBlob(localFilePath, seconds).catch(() => null);
    }
    // 3. Web sources: the streaming player can paint what is on screen. Its
    //    MSE source is a same-origin blob: URL, so the canvas is not tainted.
    if (!blob) {
      const poster = await playerRef.current?.getPosterDataUrl?.().catch(() => null);
      if (poster) blob = await fetch(poster).then((r) => r.blob()).catch(() => null);
    }
    if (!blob) return null;
    return frameToAvatarDataUrl(blob);
  }, [fps, sourceKind, localFilePath, defaults.useWebCodecsDecoder]);

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
    // One run at a time. Without this, an impatient second click spawned a
    // SECOND full audio download racing the first on the same pipe (three
    // concurrent 127 MB downloads were observed in the wild), which made a
    // slow transcribe look like a hung one.
    if (transcriptState === "running") return;
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
        ? "Source info is still loading. Try again in a moment."
        : "This source has no known duration. Set an out-mark to transcribe a range.");
      return;
    }
    // Resolve the per-month transcript-library subdir. Falls back to
    // exportOpts.folder for the brief moment between first launch and
    // the library-default-resolver effect landing.
    const outDir = await resolveTranscriptOutDir() ?? exportOpts.folder;
    if (!outDir) {
      setTranscriptState("error");
      setTranscriptError("Transcript library isn't set up. Pick a folder in Settings → Transcription.");
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
    // Reset the stage/total clocks for this run.
    stageClockRef.current = { phase: null, at: 0 };
    jobStartedRef.current = Date.now();
    const engineLabel = engine === "parakeet" ? "Parakeet" : (selectedModel?.name ?? "Whisper");
    const txChannel = engine === "parakeet" ? "parakeet" : "whisper";
    const srcLabel = sourceKind === "file" ? metadata.title : `${exportOpts.inTc || "00:00:00:00"} → ${exportOpts.outTc || "end"}`;
    appendLog("info", txChannel, `Transcribing ${srcLabel} with ${engineLabel}…`);
    try {
      const id = await invoke<string>("new_job_id");
      setTranscriptJobId(id);
      // Fresh abort scope for this run. The mediabunny audio extraction below
      // runs entirely in the browser before any cancelable backend job exists,
      // so Stop pivots on this controller to interrupt it (and to skip the
      // backend invoke if the user bailed mid-extraction).
      const abort = new AbortController();
      transcriptAbortRef.current = abort;
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
        // The in-browser WebCodecs extractor (extractAudioAsWav16k) decodes the
        // WHOLE track into memory and stages it at the SOURCE sample rate —
        // ~1.4 GB of Float32 for a 1h 48kHz-stereo file — so on a long source,
        // especially off a slow external volume, it can stall the WKWebView
        // renderer with NO error and hang the run at 0% (the await never
        // settles, so .catch can't save us). ffmpeg streams the identical
        // 16kHz mono WAV at near-constant memory, so only take the fast-path
        // for short, known-duration clips, and cap even that with a timeout so
        // a stall always degrades to ffmpeg instead of hanging forever.
        const durationSec = fps > 0 && durationFrames > 0 ? durationFrames / fps : 0;
        const canFastPath =
          engine !== "parakeet" &&
          defaults.useWebCodecsDecoder &&
          durationSec > 0 &&
          durationSec <= WEBCODECS_EXTRACT_MAX_SEC;
        let wavBlob: Blob | null = null;
        if (canFastPath) {
          // The extraction gets its OWN signal, chained to the user's Stop, so
          // the timeout can actively cancel it. Without that, losing the race
          // just abandons it: it runs to completion in the background holding
          // the whole decoded track plus its staging copy, while ffmpeg decodes
          // the same file alongside it. The user-Stop guard below deliberately
          // still reads `abort.signal`, so cancel semantics are unchanged.
          const fastAbort = new AbortController();
          const chainAbort = () => fastAbort.abort();
          abort.signal.addEventListener("abort", chainAbort);
          // The backend owns the phase once it starts, but this decode runs
          // entirely in the browser BEFORE any backend job exists, so without
          // this the pill sits on the default "Whisper 0%" for the whole
          // extraction — the exact frozen-0% symptom this work is about.
          setTranscriptPhase("extract");
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<null>((resolve) => {
            timer = setTimeout(() => { fastAbort.abort(); resolve(null); }, WEBCODECS_EXTRACT_TIMEOUT_MS);
          });
          wavBlob = await Promise.race([
            extractAudioAsWav16k(localFilePath, undefined, undefined, fastAbort.signal).catch(() => null),
            timeout,
          ]);
          if (timer) clearTimeout(timer);
          abort.signal.removeEventListener("abort", chainAbort);
        }
        // Extraction can be the slow "stuck at 0%" phase on big 4K files. If
        // the user hit Stop while it ran, bail here — no backend job was ever
        // spawned, so there's nothing for cancel_job to kill.
        if (abort.signal.aborted) {
          transcriptAbortRef.current = null;
          return;
        }
        if (wavBlob) {
          appendLog("info", txChannel,
            `Audio extracted via mediabunny (${(wavBlob.size / 1_000_000).toFixed(1)} MB WAV); skipping ffmpeg.`);
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
            appendLog("info", txChannel,
              durationSec > WEBCODECS_EXTRACT_MAX_SEC
                ? `Long source (${Math.round(durationSec / 60)} min). Extracting audio with ffmpeg for reliability.`
                : "Extracting audio with ffmpeg.");
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
              duration_seconds: metadata.duration ?? null,
            },
          });
        }
      } else {
        // YouTube source: existing 3-phase yt-dlp path.
        const dur = durationFrames > 0 ? durationFrames - 1 : 0;
        const startStr = inFrames  != null ? framesToTc(inFrames,  fps) : framesToTc(0, fps);
        const endStr   = outFrames != null ? framesToTc(outFrames, fps) : framesToTc(dur, fps);
        // A mark-in/out sub-range must not overwrite the full-source transcript
        // at the same filename. Tag the file with its coverage so a partial and
        // the full transcript coexist; re-transcribing the SAME coverage still
        // overwrites its own file (colons → dots so it's a clean basename).
        const baseName = sanitizeFilename(exportOpts.filename || "transcript");
        const isSubRange = inFrames != null || outFrames != null;
        const rangeTag = `${startStr}-${endStr}`.replace(/:/g, ".");
        const webFilename = isSubRange ? `${baseName} (${rangeTag})` : baseName;
        await invoke<string>("generate_transcript", {
          args: {
            url: metadata.webpage_url,
            start: startStr,
            end: endStr,
            fps,
            output_dir: outDir,
            filename: webFilename,
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
      // Backend job is now spawning; cancellation passes to cancel_job (which
      // also flags the pre-whisper VAD window). The frontend abort scope is
      // done its job.
      transcriptAbortRef.current = null;
    } catch (err) {
      transcriptAbortRef.current = null;
      const msg = formatError(err);
      setTranscriptState("error");
      setTranscriptError(msg);
      appendLog("err", txChannel, msg);
    }
  }, [transcriptState, metadata, metadataLoading, exportOpts, fps, selectedModel, defaults.whisperModel,
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
        ? "Source info is still loading. Try again in a moment."
        : "This source has no known duration. Captions can't be re-timed.");
      return;
    }
    const outDir = await resolveTranscriptOutDir() ?? exportOpts.folder;
    if (!outDir) {
      // Must flip state to "error" too — the Sidebar only renders transcriptError
      // when transcriptState === "error" (matches handleGenerateTranscript).
      setTranscriptState("error");
      setTranscriptError("Transcript library isn't set up. Pick a folder in Settings → Transcription.");
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
        sourceKey: entry.sourcePath ?? entry.sourceUrl ?? null,
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
    // Clear is the "forget" action (the user's rule: an associated transcript
    // sticks to its source until Clear). Drop its history row so re-opening the
    // source won't re-attach it. The SRT file on disk is untouched — it still
    // appears in the Transcripts library if it lives under the scanned folder.
    const path = activeTranscriptRef.current?.path;
    setActiveTranscript(null);
    if (!path) return;
    const entry = getTranscriptHistory().find((e) => e.srtPath === path);
    if (entry) removeTranscriptEntry(entry.id);
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
      // Surface the working view (the room when a session is live - the
      // Review workspace is sticky).
      openSourceView();
      // Probe — read_text_file_capped errors clearly if the file is
      // missing / too large. We don't load the bytes here; the viewer
      // will read them itself on the path change.
      await invoke<string>("read_text_file_capped", { path: picked, maxBytes: 8 * 1024 * 1024 });
      const title = picked.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "Imported transcript";
      // Bind the import to whatever source is loaded NOW (exactly one of these is
      // set — resetForNewSource clears the other), keyed the same way generated
      // transcripts are (canonical webpage_url for web). This is what makes an
      // imported transcript STICK to its source and auto-reload on re-open; a
      // truly source-less import records nulls and stays an unattached library row.
      recordTranscript({
        srtPath: picked,
        sourcePath: localFilePathRef.current,
        sourceUrl: metadataRef.current?.webpage_url ?? activeSourceUrlRef.current ?? null,
        title,
        origin: "unknown",
      });
      setActiveTranscript({ path: picked, origin: "unknown", sourceKey: clipSourceKeyRef.current });
      setTranscriptArrivedTick((n) => n + 1);
      appendLog("ok", "transcripts", `Imported transcript from ${picked}`);
    } catch (e) {
      pushNotification("error", "Couldn't open transcript", formatError(e));
    }
  }, [appendLog, pushNotification, setActiveView, openSourceView]);

  const handleImportTranscript = useCallback(async () => {
    // Default the picker to the library's current-month folder, where
    // generated transcripts land. The dialog degrades safely: a nonexistent
    // defaultPath opens at its parent (the library root), and a missing
    // library falls back to the panel's native last-used folder. Deliberately
    // NOT resolveTranscriptOutDir: that helper creates the folder on disk,
    // which merely opening an import dialog shouldn't do.
    const lib = defaults.transcriptLibrary;
    const d = new Date();
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const picked = await import("@tauri-apps/plugin-dialog").then((m) =>
      m.open({
        multiple: false,
        directory: false,
        defaultPath: lib ? `${lib}/${month}` : undefined,
        filters: [{ name: "Transcript", extensions: TRANSCRIPT_EXTENSIONS }],
        title: "Import transcript",
      })
    );
    if (typeof picked !== "string" || !picked) return;
    await loadTranscriptPath(picked);
  }, [loadTranscriptPath, defaults.transcriptLibrary]);

  const handleLoadFromHistory = useCallback(async (entry: TranscriptHistoryEntry) => {
    // RULE (2026-07-19): a transcript only ever attaches to ITS OWN video.
    // Picking one from history brings its video along. When that video is
    // gone (moved/deleted, or the entry never knew a location), the
    // transcript still OPENS - detached, with the player cleared first, so
    // it can never shadow an unrelated video that happens to be loaded.
    const isCurrent =
      (entry.sourcePath != null && entry.sourcePath === localFilePath) ||
      (entry.sourceUrl != null && entry.sourceUrl === activeSourceUrlRef.current);
    if (!isCurrent) {
      const videoPath = entry.sourcePath && await invoke<number>("get_file_size", { path: entry.sourcePath })
        .then(() => entry.sourcePath)
        .catch(() => null);
      if (videoPath) {
        // skipAutoTranscript: the newest-transcript auto-loader must not
        // race and clobber this explicit (possibly older) choice.
        void loadLocalPath(videoPath, true);
      } else if (entry.sourceUrl) {
        openSourceView();
        setUrl(entry.sourceUrl);
        void handleFetch(entry.sourceUrl);
      } else {
        // Detached read: clear the source so nothing else is on screen to
        // follow along with, then attach the transcript below. (Deliberately
        // NOT handleClear - that also closes the drawer this lives in.)
        openSourceView();
        resetForNewSource("");
        setStatus("empty");
        setUrl("");
        pushNotification("info", "Opened without its video",
          entry.sourcePath
            ? `${entry.sourcePath} was moved or deleted, so this transcript opened on its own. Follow-along needs its video.`
            : "This transcript has no saved video location, so it opened on its own. Follow-along needs its video.");
      }
    }
    try {
      await invoke<string>("read_text_file_capped", { path: entry.srtPath, maxBytes: 8 * 1024 * 1024 });
      setActiveTranscript({
        path: entry.srtPath,
        origin: entry.origin === "captions" ? "captions"
              : entry.origin === "whisper"  ? "whisper"
              : "unknown",
        sourceKey: entry.sourcePath ?? entry.sourceUrl ?? null,
      });
      setTranscriptArrivedTick((n) => n + 1);
      touchEntry(entry.id);
    } catch (e) {
      pushNotification("error", "Transcript file missing",
        `${entry.srtPath} was moved or deleted. Remove it from the history list to clean up.`);
    }
  }, [pushNotification, localFilePath, loadLocalPath, handleFetch, setUrl, openSourceView, resetForNewSource]);

  // ====== Library (Home view) open-handlers ======
  // Every Library open switches to the Clip view first, then routes through
  // the SAME load cores as the toolbar/monitor surfaces (loadLocalPath /
  // handleFetch / handleOpenRecentSource) — no parallel load paths. The
  // Library owns its own scan/search state; App only supplies these levers.
  // "Review this clip" (library context menu): load the source, then land
  // in the Review workspace so a session can start with it in hand.
  const handleReviewLocalPath = useCallback((path: string) => {
    void loadLocalPath(path);
    navigateView("coreview");
  }, [loadLocalPath, navigateView]);
  const handleReviewRecentSource = useCallback((r: RecentSource) => {
    handleOpenRecentSource(r);
    navigateView("coreview");
  }, [handleOpenRecentSource, navigateView]);
  const handleLibraryOpenLocalPath = useCallback((path: string) => {
    void loadLocalPath(path); // navigates via openSourceView
  }, [loadLocalPath]);

  const handleLibraryOpenRecent = useCallback((entry: RecentSource) => {
    openSourceView();
    handleOpenRecentSource(entry);
  }, [openSourceView, handleOpenRecentSource]);

  // Transcript-shelf open: load the SOURCE through the existing handlers, then
  // attach THIS entry via the same handler the Transcript-tab history popover
  // uses. loadLocalPath is told to skip its newest-transcript auto-loader
  // (skipAutoTranscript) so it can't race and clobber the user's explicit
  // (possibly older) choice; handleFetch clears the transcript up front but
  // never auto-attaches for web sources, so no skip flag is needed there.
  const handleLibraryOpenTranscript = useCallback((entry: TranscriptHistoryEntry) => {
    void handleLoadFromHistory(entry); // loads the source + navigates + gates
  }, [handleLoadFromHistory]);

  // ── Reader follow-along player (isolated from the Clip source) ─────────
  // The reader plays its transcript's source through its OWN player + its OWN
  // read-only source object, so opening a transcript to READ never disturbs a
  // Clip session. Local files only; web/source-less transcripts read text-only.
  const [readerSource, setReaderSource] = useState<ReaderSource | null>(null);
  // The open transcript's SOURCE identity (local path or web url) — the key for
  // its start timecode. Independent of readerSource (which is local-playback
  // only), so the source-TC setter + Avid export work for web transcripts too.
  const [readerSourceKey, setReaderSourceKey] = useState<string | null>(null);
  // The open transcript's source start TC (feeds the Avid export offset). Derived
  // state: set when a transcript opens and when the setter writes/clears.
  const [readerStartTc, setReaderStartTc] = useState<string | undefined>(undefined);
  // Reading pane tab: the transcript document vs its saved AI analysis.
  const [readerDocTab, setReaderDocTab] = useState<"document" | "analysis">("document");
  // The CLIP drawer's transcript uses the same source-start-TC + Avid export as
  // the reader. Its source key is whatever's loaded in Clip (local path or web
  // url); a tick bump re-reads the stored TC after the setter writes it.
  const [clipSourceTcTick, setClipSourceTcTick] = useState(0);
  // localStorage read, so memoized: this sat bare in the render body and ran
  // on every App render, which is every playhead-driven re-render anything
  // else causes. The tick was already here for exactly this purpose and was
  // write-only — it is the invalidation, so it belongs in the deps.
  const clipStartTc = useMemo(() => {
    // Read, not ignored: the tick IS the invalidation. setSourceTimecode
    // writes localStorage and then bumps this, and without touching it here
    // the rule would have us drop it from the deps and serve a stale TC.
    void clipSourceTcTick;
    return clipSourceKey ? sourceTimecodeFor(clipSourceKey) ?? undefined : undefined;
  }, [clipSourceKey, clipSourceTcTick]);
  // Why there's no follow-along player, when there isn't one (web / missing file).
  const [readerNote, setReaderNote] = useState<string | null>(null);
  // True while an ffmpeg playback copy is being prepared for an exotic-codec
  // source (the panel shows a "Preparing…" state meanwhile).
  const [readerPreparing, setReaderPreparing] = useState(false);
  const [readerFloating, setReaderFloating] = useState(false);
  // Supersede guard: each open/fallback bumps this; async steps bail if a newer
  // one started, so a slow transcode can't clobber a since-changed reader.
  const readerOpenSeqRef = useRef(0);
  // Whether the player panel is expanded (vs collapsed to a thin rail). The rail
  // keeps a persistent, discoverable toggle so the player is never just "gone".
  const [readerStageOpen, setReaderStageOpen] = useState<boolean>(() => {
    try { return localStorage.getItem("saucebunny.readerStageOpen") !== "0"; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem("saucebunny.readerStageOpen", readerStageOpen ? "1" : "0"); } catch { /* ignore */ }
  }, [readerStageOpen]);
  const readerPlayerRef = useRef<PlayerHandle>(null);
  // The one clock, written by the reader player ONLY while the reader is active
  // (the gate that stops it and the still-playing Clip player from thrashing).
  const readerSourceRef = useRef<ReaderSource | null>(null);
  readerSourceRef.current = readerSource;
  const onReaderTimeUpdate = useCallback((seconds: number) => {
    const rfps = readerSourceRef.current?.fps ?? fpsRef.current;
    publishPlayheadFrames(playheadSecondsToFrames(seconds, rfps));
  }, []);
  // Transport shortcuts in the reader must drive the READER player, never the
  // hidden-but-mounted Clip player (that caused double audio + playhead thrash).
  const readerFps = () => readerSourceRef.current?.fps ?? fpsRef.current ?? 24;
  const readerSeekRel = useCallback((deltaSeconds: number) => {
    const p = readerPlayerRef.current; if (!p) return;
    const dur = p.getDuration() || Number.POSITIVE_INFINITY;
    p.seekTo(Math.max(0, Math.min(dur, p.getCurrentTime() + deltaSeconds)));
  }, []);

  // Transcode an exotic-codec original into a WKWebView-friendly playback copy,
  // reader-scoped (no Clip state). Mirrors runPlaybackPrep but standalone.
  const prepareReaderPlayback = useCallback(async (
    origPath: string, hasVideo: boolean, durationSeconds: number | null,
  ): Promise<string> => {
    const jobId = await invoke<string>("new_job_id");
    return await invoke<string>("prepare_local_for_playback", {
      args: { input_path: origPath, has_video: hasVideo, duration_seconds: durationSeconds, job_id: jobId },
    });
  }, []);

  // Reader open: attach the transcript for reading, then resolve an ISOLATED
  // follow-along player the SAME way Clip/Library does (this is why a file that
  // plays in the Library plays here): probe → canMediabunnyDecode → MediaBunny
  // on the original, or ffmpeg-transcode to a native-playable copy. The Clip
  // source is never touched (no resetForNewSource). Text shows immediately; the
  // player fills in async. Web/source-less → text only.
  const handleReaderOpenTranscript = useCallback(async (entry: TranscriptHistoryEntry) => {
    try {
      await invoke<string>("read_text_file_capped", { path: entry.srtPath, maxBytes: 8 * 1024 * 1024 });
    } catch {
      pushNotification("error", "Transcript file missing",
        `${entry.srtPath} was moved or deleted. Remove it from history to clean up.`);
      return;
    }
    const seq = ++readerOpenSeqRef.current;
    // Open the reader with the text right away; reset the player to a clean slate.
    setReaderSource(null);
    const srcKey = entry.sourcePath ?? entry.sourceUrl ?? null;
    setReaderSourceKey(srcKey);
    setReaderStartTc(srcKey ? sourceTimecodeFor(srcKey) ?? undefined : undefined);
    setReaderDocTab("document"); // a fresh transcript opens on its text
    setReaderNote(null);
    setReaderPreparing(!!entry.sourcePath);
    // Publish 0 so the highlight can't read a frame left in the Clip's fps.
    publishPlayheadFrames(0);
    setActiveTranscript({
      path: entry.srtPath,
      origin: entry.origin === "captions" ? "captions" : entry.origin === "whisper" ? "whisper" : "unknown",
      sourceKey: entry.sourcePath ?? entry.sourceUrl ?? null,
    });
    setTranscriptArrivedTick((n) => n + 1);
    navigateView("reader");

    if (!entry.sourcePath) {
      setReaderPreparing(false);
      setReaderNote(entry.sourceUrl
        ? "This is a web source. Follow-along playback in the reader is local-file only for now."
        : "No source file is linked to this transcript, so there's nothing to play.");
      return;
    }
    // Resolve the follow-along player (isolated, seq-guarded).
    try {
      const lf = await invoke<LocalFileMeta>("probe_local_file", { path: entry.sourcePath });
      if (readerOpenSeqRef.current !== seq) return;
      const fps = lf.fps && lf.fps > 0 ? lf.fps : 24;
      const title = lf.filename ?? entry.title;
      const canMb = await canMediabunnyDecode(lf.path);
      if (readerOpenSeqRef.current !== seq) return;
      if (canMb) {
        // Reliable primary path: MediaBunny reads the original via byte-range IPC.
        setReaderSource({ origPath: lf.path, path: lf.path, hasVideo: lf.has_video, fps, title, useWebCodecs: true, prepared: false });
        setReaderPreparing(false);
      } else {
        // Exotic codec WebCodecs can't decode → transcode a playable copy up front
        // (a raw native <video> would hang without even firing an error).
        const prepared = await prepareReaderPlayback(lf.path, lf.has_video, lf.duration);
        if (readerOpenSeqRef.current !== seq) return;
        setReaderSource({ origPath: lf.path, path: prepared, hasVideo: lf.has_video, fps, title, useWebCodecs: false, prepared: true });
        setReaderPreparing(false);
      }
    } catch {
      if (readerOpenSeqRef.current !== seq) return;
      setReaderPreparing(false);
      setReaderNote("The source file couldn't be opened. It may have been moved or renamed, so this transcript is reading only.");
    }
  }, [navigateView, pushNotification, prepareReaderPlayback]);

  // Reader player load failure → fall back like Clip's onMediaError chain. A
  // MediaBunny paint failure (e.g. a 10-bit source that decodes but paints black)
  // or a native load error transcodes the original and retries via native <video>.
  // Already on a transcoded copy and still failing → surface it, don't loop.
  const handleReaderMediaError = useCallback(async (msg: string) => {
    const cur = readerSourceRef.current;
    if (!cur) return;
    if (cur.prepared && !cur.useWebCodecs) {
      setReaderSource(null);
      setReaderNote("This source couldn't be played in the reader, but it still opens in the Library and Clip.");
      appendLog("warn", "local", `Reader playback failed after transcode: ${msg}`);
      return;
    }
    const seq = ++readerOpenSeqRef.current;
    setReaderPreparing(true);
    try {
      const prepared = await prepareReaderPlayback(cur.origPath, cur.hasVideo, null);
      if (readerOpenSeqRef.current !== seq) return;
      setReaderSource({ ...cur, path: prepared, useWebCodecs: false, prepared: true });
    } catch {
      if (readerOpenSeqRef.current !== seq) return;
      setReaderSource(null);
      setReaderNote("This source couldn't be prepared for playback in the reader.");
    } finally {
      if (readerOpenSeqRef.current === seq) setReaderPreparing(false);
    }
  }, [appendLog, prepareReaderPlayback]);

  // Web-source row poster: a non-YouTube web source has no URL-derived thumbnail,
  // so its transcript/library rows fall to a glyph. While such a source is loaded,
  // poll the web player for a captured frame (getPosterDataUrl is luma-guarded, so
  // it returns null until a non-black frame is on screen) and cache it per-url.
  // YouTube already yields hqdefault.jpg, and local files decode on demand — both
  // skipped. Bounded attempts; stops on the first good frame or a source change.
  useEffect(() => {
    const url = metadata?.webpage_url ?? activeSourceUrl;
    if (!url || localFilePath) return;          // local file → on-demand decode
    if (youTubeThumbnailUrl(url)) return;        // YouTube → URL-derived poster
    if (webPosterFor(url)) return;               // already captured
    let attempts = 0;
    const id = window.setInterval(async () => {
      if (++attempts > 12) { window.clearInterval(id); return; }
      try {
        const dataUrl = await playerRef.current?.getPosterDataUrl?.();
        if (dataUrl) { setWebPoster(url, dataUrl); window.clearInterval(id); }
      } catch { /* ignore a transient capture failure */ }
    }, 2500);
    return () => window.clearInterval(id);
  }, [metadata, localFilePath, activeSourceUrl]);

  // Rename a transcript's file on disk (+ its sidecars, via Rust), then carry
  // the app's references: path-keyed speaker names, the history entry (path +
  // title), and the active transcript if it's the one being renamed. Throws on
  // a backend failure (collision / bad name) so the dialog can surface it.
  const handleRenameTranscript = useCallback(async (entry: TranscriptHistoryEntry, newStem: string) => {
    const oldPath = entry.srtPath;
    const newPath = await invoke<string>("rename_transcript", { srtPath: oldPath, newStem });
    if (newPath === oldPath) return;
    // Title from the ACTUAL on-disk name (the backend trims trailing dots/spaces),
    // so history matches the file.
    const cleanStem = (newPath.split("/").pop() ?? newStem).replace(/\.[^.]+$/, "");
    renameSpeakerOverridesPath(oldPath, newPath);
    renameTranscriptEntryPath(oldPath, newPath, cleanStem); // fires TRANSCRIPTS_CHANGED
    if (activeTranscriptRef.current?.path === oldPath) {
      setActiveTranscript((prev) => (prev ? { ...prev, path: newPath } : prev));
    }
  }, []);

  // Move a transcript (+ sidecars) into a folder, carrying the same references
  // (title unchanged). Throws on failure so the dialog can surface it.
  const handleMoveTranscript = useCallback(async (entry: TranscriptHistoryEntry, destDir: string) => {
    const oldPath = entry.srtPath;
    const newPath = await invoke<string>("move_transcript_to_folder", { srtPath: oldPath, destDir });
    if (newPath === oldPath) return;
    renameSpeakerOverridesPath(oldPath, newPath);
    renameTranscriptEntryPath(oldPath, newPath);
    if (activeTranscriptRef.current?.path === oldPath) {
      setActiveTranscript((prev) => (prev ? { ...prev, path: newPath } : prev));
    }
  }, []);

  // THE single-clock gate (r88): exactly one media element is ever unpaused.
  // The Clip player keeps playing across views ([hidden] is display:none, audio
  // deliberately continues), so entering the reader must pause it, and leaving
  // must pause the reader player.
  useEffect(() => {
    if (activeView === "reader") { try { playerRef.current?.pause(); } catch { /* no clip player */ } }
    else { try { readerPlayerRef.current?.pause(); } catch { /* no reader player */ } }
  }, [activeView]);

  // Home folder card / folder search-hit → open the Library browser with that
  // folder selected. The tick makes a repeat drill re-apply the same chain.
  const handleOpenLibraryFolder = useCallback((chain: LibraryCrumb[]) => {
    setLibrarySelection(chain);
    setLibrarySelectTick((t) => t + 1);
    setActiveView("library");
  }, [setActiveView]);

  // Hero "Paste a URL" → the same focus lever as the File-menu "Open URL…".
  const handleSwitchToClip = useCallback(() => {
    setActiveView("clip");
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
    resetForNewSource("");
    setStatus("empty");
    setExportOpts((prev) => ({
      ...prev,
      inTc: "",
      outTc: "",
      filename: "clip",
    }));
    setUrl("");
    // Unloading the source used to silently take the queue with it. The
    // toolbar button's own tooltip says "Unload the current source" and says
    // nothing about the queue, and queued items carry their own source and
    // fps precisely so they do NOT depend on what is loaded — so there is no
    // reason to drop them, and every reason not to.
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
      setCaptionsError("Transcript library isn't set up. Pick a folder in Settings → Transcription.");
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
        "Grabbing the source transcript for on-video captions.");
      void handleDownloadCaptions();
    } else if (sourceKind === "file") {
      pushNotification("info", "No transcript yet",
        "Run Transcribe to show captions for this file.");
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
        // Keep the RAW fs path too — Clear cache excludes the files the
        // current session is playing from, and it matches on raw paths.
        webAudioCachedPathRef.current = path;
        setWebAudioCachedSrc(assetUrl(path));
        appendLog("ok", "audio-cache", "Audio cached. Transcribe will be instant for this source.");
      } catch (err) {
        if (cancelled || sourceSeqRef.current !== seq) return;
        appendLog("warn", "audio-cache",
          `Audio pre-cache skipped (${formatError(err)}). Transcribe will fetch it on demand.`);
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
        // Only when a session is live - a solo report should not carry an
        // empty room. Two of these side by side is how a roster or floor
        // disagreement becomes visible instead of inferred.
        session: coSession.role === "off" ? undefined : {
          role: coSession.role,
          selfId: coSession.selfId,
          presenter: coSession.presenter,
          presenterEpoch: coSession.presenterEpoch,
          peers: coSession.peers.map((p) => ({ id: p.id, name: p.name, epoch: p.epoch ?? 0 })),
          meshStates: [...meshStates].map(([id, state]) => ({ id, state })),
          capture: capture.stream
            ? capture.stream.getTracks().map((t) => `${t.kind}(${t.readyState})`).join(" ")
            : "none",
          shareState,
        },
      });
      await invoke("write_text_to_path", { path, text: report });
      pushNotification("success", "Diagnostics saved", "Attach this file to a bug report.");
    } catch (err) {
      pushNotification("error", "Diagnostics export failed", formatError(err));
    }
  }, [logs, pushNotification]);

  /**
   * Clicking a recent export LOADS it.
   *
   * It used to reveal the file in Finder and nothing else, which made the
   * whole list a file browser with extra steps: the one thing you want from
   * "here is the clip you just made" is to watch it, and the row that looked
   * most like a play button sent you to the Finder instead. Reveal is still
   * there as its own button on each row, which is where a Finder action
   * belongs.
   *
   * A recent is a clip this app exported, so the file is local by
   * construction and loadLocalPath is the whole implementation - it imports,
   * probes and navigates to Clip exactly as opening any local file does.
   */
  const handlePickRecent = useCallback((r: RecentClip) => {
    void loadLocalPath(r.path);
  }, [loadLocalPath]);

  /** Wipes the sidebar's Recent list. Files on disk are not touched. */
  const handleClearRecents = useCallback(() => {
    setRecents([]);
    appendLog("info", "control", "Cleared recent exports history.");
  }, [appendLog]);

  // ====== Transport ======
  // ── Timecode entry HUD (type digits → snap playhead) ──
  // Raw digits typed so far; null = HUD closed. A bare number key opens it;
  // digits fill right-to-left into HH:MM:SS:FF (last two = frames), Return
  // snaps the playhead, Esc cancels. Mirrored into a ref so the window
  // keydown handler reads the live value without re-binding every keystroke.
  const [tcEntry, setTcEntry] = useState<string | null>(null);
  const tcEntryRef = useRef<string | null>(null);
  useEffect(() => { tcEntryRef.current = tcEntry; }, [tcEntry]);

  // ── Transport (shuttle, steps, seeks, in/out marks) ──────────────────
  // Lifted whole into src/hooks/use-transport.ts. Destructured rather than
  // held as a `transport` object so no call site below had to change: the
  // move is meant to be provably behaviour-neutral, and a hundred renamed
  // references would have hidden that.
  const {
    shuttleRate, kHeldRef, onPlayToggle, onStep,
    seekBySeconds, shuttleStep, onMarkIn, onMarkOut, onClearMarks,
    onGotoIn, onGotoOut, onSeek, onChaseSeek,
  } = useTransport({
    playerRef, status, isPlaying, setIsPlaying, fps, durationFrames,
    inFrames, outFrames, setInFrames, setOutFrames, pushMarksUndo,
    sourceKind, localFilePath,
    webCachePath: webPlayback.cachePath,
    webStreamUrl: webPlayback.streamUrl,
  });

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
  const reviewRangeGateRef = useRef({ panelDetached: false, queueOpen: false, roomActive: false, reviewSourceKey: null as string | null, hasSource: false, clipVisible: false });

  // Data-driven: the live event is serialized to a combo and matched against the
  // user-editable binding map (Settings → Commands). The three things that aren't
  // simple action triggers — the timecode-entry HUD, Esc-closes-Settings, and
  // bare-digit-opens-HUD — stay hand-coded around the dispatch.
  useEffect(() => {
    // Run a matched action with the exact behavior of its hand-coded predecessor
    // (the shuttle ladder on back/fwd, the export status gate, etc.).
    function runAction(id: KeyActionId, e: KeyboardEvent) {
      // Transport and Marking act on the Clip player and ITS in/out marks.
      // Every one of them was firing from Home and the Library, where that
      // player is mounted but not on screen — so pressing Space started
      // playback you could not see, i/o/g moved the export marks on a
      // different file than the one under the cursor, j/k/l shuttled it,
      // [ / ] / \ changed its speed and Home/End seeked it. Silent state
      // corruption from a view that looks inert.
      //
      // `global: false` in the binding table only means "not while typing";
      // there was never a view gate. The `reader` view is already handled
      // action by action below because it owns a second player; this is the
      // same idea applied once, to the views that own no player at all.
      //
      // Returning WITHOUT preventDefault is deliberate: the key has to stay
      // available to whatever view IS in front, which is what lets the
      // Library run arrow-key navigation and type-ahead on the same letters.
      if (isPlaybackScoped(id) && !VIEWS_WITH_A_PLAYER.has(activeViewRef.current)) return;
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
        case "view.library":
        case "view.clip":
        case "view.coreview":
        case "view.reader": {
          // View switching stays live during a session: the room is a
          // dressing of the shared stage, not a trap (leaving to Clip keeps
          // the session connected; the rail's Review badge is the way back).
          const v: AppView =
            id === "view.home" ? "home" :
            id === "view.library" ? "library" :
            id === "view.coreview" ? "coreview" :
            id === "view.reader" ? "reader" : "clip";
          // Route through navigateView (not raw setActiveView) so Home also
          // bumps homeResetTick like every other nav surface does.
          navigateView(v);
          // The outgoing view is about to be [hidden]; if focus lived inside
          // it, it orphans to <body>. Move focus into the newly-shown view's
          // root once React commits the unhide (rAF lands after the paint).
          const viewRef =
            v === "home" ? homeViewRef :
            v === "library" ? libraryViewRef :
            v === "coreview" ? coreviewViewRef :
            v === "reader" ? readerViewRef : clipViewRef;
          requestAnimationFrame(() => viewRef.current?.focus());
          break;
        }
        case "view.logs":    setLogsOpen((p) => !p); break;
        case "queue.add":    handleAddToQueue(); break;
        case "queue.toggle": setQueueOpenChoice((p) => !p); break;
        case "export.clip":
          if (status === "loaded" && !exportOpts.folder) {
            pushNotification("info", "Choose an export folder first",
              "Pick a folder in the sidebar, or set a default in Settings → General.");
          } else if (status === "loaded") {
            handleExport();
          }
          break;
        case "play.toggle":
          // In the reader, Space drives the reader's own player (the Clip
          // player is paused by the single-clock gate; onPlayToggle would wake
          // it). Elsewhere it's the Clip/room player as usual.
          if (activeViewRef.current === "reader") {
            const p = readerPlayerRef.current;
            if (p?.isReady()) { p.isPlaying() ? p.pause() : p.play(); }
          } else onPlayToggle();
          break;
        // J / L — NLE transport: each press walks the shuttle ladder
        // (1-2-4-8×, opposite press steps down, +1 resumes real playback);
        // with K held it's a single-frame nudge instead. Repeats (key held)
        // sustain the current rate rather than laddering to the cap.
        case "play.back5": if (activeViewRef.current === "reader") readerSeekRel(-5); else shuttleStep(-1, e.repeat); break;
        case "play.fwd5":  if (activeViewRef.current === "reader") readerSeekRel(5); else shuttleStep(1, e.repeat); break;
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
          // Room face forces the drawer open on the Review tab, so the
          // persisted tab/open prefs don't gate there.
          // The panel only tracks the playhead while its view is on screen, so
          // firing from Home/Library/Reader would reach a ReviewPanel whose
          // currentSec is null: the mark silently no-ops, or worse files at
          // 0:00. Gate on the same visibility the panel uses so the shortcut is
          // inert BY DESIGN here, not by accident.
          if (!g.clipVisible) break;
          if ((g.panelDetached && !g.roomActive) || (!g.roomActive && (!g.queueOpen || loadActiveTab() !== "review")) || !g.reviewSourceKey || !g.hasSource) break;
          const h = reviewRangeKeysRef.current;
          if (id === "review.rangeIn") h?.markIn(); else h?.markOut();
          break;
        }
        case "mark.clear":   onClearMarks(); break;
        case "mark.gotoIn":  onGotoIn(); break;
        case "mark.gotoOut": onGotoOut(); break;
        case "play.frameBack":  if (activeViewRef.current === "reader") readerSeekRel(-1 / readerFps()); else onStep(-1); break;
        case "play.frameFwd":   if (activeViewRef.current === "reader") readerSeekRel(1 / readerFps()); else onStep(1); break;
        case "play.secondBack": if (activeViewRef.current === "reader") readerSeekRel(-1); else onStep(-Math.round(fps)); break;
        case "play.secondFwd":  if (activeViewRef.current === "reader") readerSeekRel(1); else onStep(Math.round(fps)); break;
        case "play.toStart": if (activeViewRef.current === "reader") readerPlayerRef.current?.seekTo(0); else onSeek(0); break;
        case "play.toEnd": {
          if (activeViewRef.current === "reader") {
            const p = readerPlayerRef.current;
            if (p) p.seekTo(Math.max(0, p.getDuration() - 0.1));
            break;
          }
          const end = endSeekFrames(durationFrames);
          if (end != null) onSeek(end);
          break;
        }
        // Persistent playback speed ([ / ] / \) — steps the 0.5–2× list. No-op in
        // the reader (its transport is Space + skip + click-a-line, no rate UI).
        case "play.rateDown":  if (activeViewRef.current !== "reader") handlePlaybackRateStep(-1); break;
        case "play.rateUp":    if (activeViewRef.current !== "reader") handlePlaybackRateStep(1); break;
        case "play.rateReset": if (activeViewRef.current !== "reader") handlePlaybackRateChange(1); break;
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
      // Same view gate as the transport actions: a digit typed in the Library
      // was opening a "go to timecode" HUD over a player the user is not
      // looking at, and eating the keystroke that type-ahead wants.
      if (!VIEWS_WITH_A_PLAYER.has(activeViewRef.current)) { /* fall through */ }
      else if (e.key >= "0" && e.key <= "9" && durationFrames > 0) {
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
        // Cleanup can run mid-Promise.all (this effect re-attaches whenever a
        // handler dep changes): it iterates the array as-is, so a bind that
        // resolves after that must release itself instead of pushing into a
        // list nobody will read again.
        if (!mounted) { off(); return; }
        unlistens.push(off);
      };
      await Promise.all([
        bind("open_url_bar",        () => {
          // In a live room the URL bar IS the room's source bar - focus that
          // and stay put. Ejecting a presenter to the Clip view mid-session
          // (which is what an unconditional setActiveView("clip") did) breaks
          // the sticky-workspace rule.
          if (sessionRoomRef.current && activeViewRef.current === "coreview") {
            setTimeout(() => {
              const el = document.querySelector<HTMLInputElement>(".cp-room-source-field input");
              el?.focus();
              el?.select();
            }, 0);
            return;
          }
          // Otherwise the URL bar lives in the Clip view's toolbar - surface
          // that view first (a [hidden] subtree can't take focus), then focus
          // once React has committed the unhide (setTimeout lands after the
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
        // Help > Check for Updates used to just open a browser tab. Now it
        // asks, and either says you're current or offers the new version.
        bind("check_updates",       () => {
          void (async () => {
            const current = await getVersion().catch(() => null);
            if (!current) { setSettingsInitialTab("about"); setSettingsOpen(true); return; }
            const status = await checkForUpdate(current);
            if (status.kind === "available") {
              pushNotification("info", `Sauce Bunny ${status.version} is available`,
                "Open Settings, About to download it.");
            } else if (status.kind === "current") {
              pushNotification("success", "You're up to date", `Version ${current}.`);
            } else {
              pushNotification("info", "Couldn't check for updates",
                "No connection, or no release published yet.");
            }
          })();
        }),
        bind("toggle_pipeline",     () => setLogsOpen((p) => !p)),
        bind("toggle_queue",        () => setQueueOpenChoice((p) => !p)),
        bind("show_command_palette", () => setPaletteOpen(true)),
        bind("show_shortcuts",       () => setShortcutsOpen(true)),
      ]);
    })();
    return () => { mounted = false; unlistens.forEach((u) => u()); };
  }, [handleImportFile, handleImportTranscript, defaults.transcriptLibrary, setActiveView, pushNotification, setQueueOpenChoice]);

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
    onOpenTranscriptSearch: () => setTxSearchOpen(true),
    onPlaybackRateStep: handlePlaybackRateStep,
    onPlaybackRateReset: () => handlePlaybackRateChange(1),
    onStep, onSeek, onMarkIn, onMarkOut, onClearMarks, onGotoIn, onGotoOut,
    handleExport, handleSnapshot, handleAddToQueue, handleExportQueue,
    handleQueueClearAll, handleImportTranscript, handleGenerateTranscript,
    handleDownloadCaptions, handleStop,
    // The palette's queue.toggle is a user choice — route it through the
    // persisting setter (mechanical opens elsewhere use the raw setter).
    setQueueOpen: setQueueOpenChoice, setTranscriptArrivedTick, setCaptionsOn, setLogsOpen,
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
    pushNotification, setQueueOpenChoice,
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
  // What the room is watching, in a form a REMOTE peer can act on (r124).
  // The old session code keyed off activeSourceUrl, which only exists for web
  // sources - so loading a local file broadcast NOTHING and the guest sat on
  // the empty state. A file travels as its fingerprint (content identity), not
  // as a host-local path the peer could never open.
  const sessionSource = useMemo<SessionSource>(() => {
    if (!metadata) {
      return { kind: "none", url: null, fingerprint: null, title: null, duration: null, reviewKey: "" };
    }
    if (sourceKind === "file" && localFilePath) {
      const fp = reviewFingerprint(
        metadata.title ?? localFilePath, metadata.duration ?? 0,
        metadata.width, metadata.height, localFileSize,
      );
      return {
        kind: "file", url: null, fingerprint: fp,
        title: metadata.title ?? null, duration: metadata.duration ?? null, reviewKey: fp,
      };
    }
    return {
      kind: "web", url: activeSourceUrl, fingerprint: null,
      title: metadata.title ?? null, duration: metadata.duration ?? null,
      reviewKey: metadata.webpage_url ?? "",
    };
  }, [sourceKind, metadata, localFilePath, localFileSize, activeSourceUrl]);
  // Also a localStorage read (resolveByFingerprint), also previously bare in
  // the render body. Depends only on the identity of the loaded source, which
  // changes far less often than App renders. `fpIndexBump` re-runs it when
  // the index is edited UNDER a loaded source — linking the open file into an
  // older cut's version stack rewrites where this key should resolve.
  const [fpIndexBump, setFpIndexBump] = useState(0);
  const [txSearchOpen, setTxSearchOpen] = useState(false);
  const reviewSourceKey = useMemo(
    () => ((sourceKind === "file" && localFilePath && metadata)
      ? (resolveByFingerprint(reviewFingerprint(metadata.title ?? localFilePath, metadata.duration ?? 0, metadata.width, metadata.height, localFileSize)) ?? localFilePath)
      : (metadata?.webpage_url ?? null)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fpIndexBump tracks the localStorage index the linter can't see
    [sourceKind, localFilePath, metadata, localFileSize, fpIndexBump],
  );

  /**
   * Version stacks: absorb the OPEN file into `oldKey`'s review doc as its
   * next version.
   *
   * Three writes, one identity change: the old doc gains a version for this
   * path (active, so the panel lands on the new cut), the file's fingerprint
   * now resolves to the old doc's key, and the bump makes reviewSourceKey
   * re-resolve — the panel's load effect then re-reads and shows the stack,
   * old notes carried. Rides the exact machinery that survives moved files;
   * see _design/review-versioning.md.
   */
  // Batch transcription runs OUTSIDE the single-source pipeline (see the hook),
  // so a folder can transcribe in the background while the user keeps working.
  const batch = useBatchTranscribe(
    useCallback((level: "info" | "err", msg: string) => appendLog(level, "whisper", msg), [appendLog]),
  );

  /**
   * Kick off a batch transcription from a Library selection.
   *
   * Resolves output folder, model and language exactly the way the single-file
   * path does, so a batched transcript is indistinguishable from one made by
   * opening the file and pressing Transcribe.
   */
  const startBatchTranscribe = useCallback(async (files: { path: string; name: string }[]) => {
    const outDir = await resolveTranscriptOutDir() ?? exportOpts.folder;
    if (!outDir) {
      appendLog("err", "whisper", "Choose a transcript folder in Settings first.");
      return;
    }
    void batch.start(files, {
      outDir,
      modelId: defaults.whisperModel,
      engine: defaults.transcriptionEngine,
      language: defaults.transcriptionLanguage,
      detectSpeakers: defaults.detectSpeakers,
      expectedSpeakers: defaults.expectedSpeakers,
    });
  }, [batch, defaults, exportOpts.folder, appendLog, resolveTranscriptOutDir]);

  const linkAsReviewVersion = useCallback((oldKey: string) => {
    if (!(sourceKind === "file" && localFilePath && metadata)) return;
    const old = loadReview(oldKey);
    const { doc, versionId } = ensureVersion(old, localFilePath, `V${old.versions.length + 1}`);
    saveReview(setActiveVersion(doc, versionId));
    linkFingerprint(
      reviewFingerprint(metadata.title ?? localFilePath, metadata.duration ?? 0, metadata.width, metadata.height, localFileSize),
      oldKey,
    );
    setFpIndexBump((n) => n + 1);
  }, [sourceKind, localFilePath, metadata, localFileSize]);

  /** The reverse of linkAsReviewVersion: take the open file back out of the
   *  stack it was wrongly linked into. removeVersion refuses if the version
   *  holds comments, in which case the fingerprint entry must stay too —
   *  half-unlinking would strand those comments behind an unreachable key. */
  const unlinkReviewVersion = useCallback(() => {
    if (!(sourceKind === "file" && localFilePath && metadata) || !reviewSourceKey) return;
    const doc = loadReview(reviewSourceKey);
    const mine = doc.versions.find((v) => v.path === localFilePath);
    // Same predicate the control is gated on, so the button and the action can
    // never disagree about which version "this cut" means.
    if (!mine || !canUnlinkVersion(doc, mine.id, localFilePath)) return;
    const next = removeVersion(doc, mine.id);
    if (next === doc) return; // belt-and-braces; canUnlinkVersion agreed above
    saveReview(next);
    unlinkFingerprint(
      reviewFingerprint(metadata.title ?? localFilePath, metadata.duration ?? 0, metadata.width, metadata.height, localFileSize),
    );
    setFpIndexBump((n) => n + 1);
  }, [sourceKind, localFilePath, metadata, localFileSize, reviewSourceKey]);

  /**
   * Take the creator's own chapters when the site publishes them.
   *
   * The AI Summary tab could already detect chapters from the transcript with
   * the local LLM - slow, and a guess - while yt-dlp had the real list in the
   * same probe the app runs before playback. This adopts the real ones so the
   * timeline is populated the moment a source loads, and the LLM stays as the
   * fallback for the (large) part of the web that publishes none.
   *
   * `adoptSourceChapters` only ever writes into an EMPTY store, so re-opening
   * a source cannot undo a rename or a deletion the user made.
   */
  useEffect(() => {
    const list = metadata?.chapters;
    if (!reviewSourceKey || !list?.length) return;
    if (adoptSourceChapters(reviewSourceKey, list)) {
      appendLog("ok", "chapters", `Using ${list.length} chapters published by the source.`);
    }
  }, [reviewSourceKey, metadata, appendLog]);

  // ── Speaker-rename fingerprint bridge (r134) ──────────────────────────
  // Speaker renames live in localStorage keyed by SRT path, which orphaned
  // them whenever the path changed (re-transcribe in a new month, rename, or
  // move). The bridge keys them behind the same content fingerprint reviews
  // use, so those cases restore the names. The path key stays the working
  // store every consumer reads — this only seeds and mirrors it.
  const speakerFp = useMemo(
    () => (metadata
      ? speakerFingerprint(metadata.title ?? localFilePath, metadata.duration, metadata.width, metadata.height, localFileSize)
      : null),
    [metadata, localFilePath, localFileSize],
  );
  useEffect(() => {
    if (!transcriptPath || !speakerFp) return;
    // Restore names from a prior transcript of the same source (if this new
    // path has none yet), and keep the fingerprint index current either way
    // (this also migrates renames made before the bridge existed).
    const seeded = seedSpeakerOverridesFromFingerprint(transcriptPath, speakerFp);
    linkSpeakerOverridesToFingerprint(transcriptPath, speakerFp);
    if (seeded) {
      window.dispatchEvent(new CustomEvent(SPEAKERS_CHANGED_EVENT, { detail: { path: transcriptPath } }));
    }
  }, [transcriptPath, speakerFp]);
  // Mirror every subsequent rename back to the fingerprint index so it survives
  // the NEXT path change. Registered once; reads current path/fp through a ref.
  const speakerBridgeRef = useRef<{ path: string | null; fp: string | null }>({ path: null, fp: null });
  speakerBridgeRef.current = { path: transcriptPath, fp: speakerFp };
  useEffect(() => {
    const onChange = (e: Event) => {
      const { path, fp } = speakerBridgeRef.current;
      if (!path || !fp) return;
      const evPath = (e as CustomEvent<{ path?: string }>).detail?.path;
      if (evPath && evPath !== path) return;
      linkSpeakerOverridesToFingerprint(path, fp);
    };
    window.addEventListener(SPEAKERS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(SPEAKERS_CHANGED_EVENT, onChange);
  }, []);
  // Current source's approval verdict for the header chips (Clip sidebar +
  // room stage title). Live session -> the shared doc; solo -> the stored
  // doc, re-read on every review mutation via REVIEW_CHANGED_EVENT.
  const [reviewTick, setReviewTick] = useState(0);
  useEffect(() => {
    const bump = () => setReviewTick((t) => t + 1);
    window.addEventListener(REVIEW_CHANGED_EVENT, bump);
    return () => window.removeEventListener(REVIEW_CHANGED_EVENT, bump);
  }, []);
  const [reviewMarkers, setReviewMarkers] = useState<ReviewMarkerView[]>([]);
  const [reviewAnnotations, setReviewAnnotations] = useState<ReviewAnnotationView[]>([]);
  // Live range being set in the review composer → previewed on the timeline.
  // `live` = an end still follows the playhead (pulsing); false = locked.
  const [reviewRangeDraft, setReviewRangeDraft] = useState<ReviewRangeDraft | null>(null);
  // Latest-value mirror for the keyboard effect's ⇧I/⇧O review-range gate.
  useEffect(() => { reviewRangeGateRef.current = { panelDetached, queueOpen, roomActive, reviewSourceKey, hasSource, clipVisible: activeView === "clip" || roomActive }; });

  // ── Co-review session (P2P watch party — r100 transport, r101 live review) ──
  // The whole subsystem — session lifecycle, host transport heartbeat + peer
  // playhead-follow, shared-doc seed/broadcast/merge/relay, presence ghost
  // cursors, theater mode — lives in src/hooks/use-co-review.ts (extracted
  // like use-panel-bus/use-web-playback). Rust owns the iroh endpoint
  // (commands/session.rs) as a dumb relay; the frontend is the review
  // source-of-truth. WEB-ONLY — a local file can't be pushed to peers, so
  // hosting is gated to web sources. The playhead is NOT passed in: the
  // Tier B (r145): mount the host's offered file as a LIVE stream. Mirrors
  // handleFetch's stub-mount path, but the "resolve" is a proxy peer route
  // registered against the live session, so there is no extraction and no
  // download fallback (a dead stream resets; the room still offers Get).
  const peerRegIdRef = useRef<string | null>(null);
  const loadPeerStream = useCallback(async (
    offer: { name: string; blake3: string; vcodec: string | null; acodec: string | null },
    pending: { title: string | null; duration: number | null },
  ) => {
    if (peerRegIdRef.current) {
      void invoke("peer_media_unregister", { id: peerRegIdRef.current }).catch(() => {});
      peerRegIdRef.current = null;
    }
    const reg = await invoke<{ id: string; url: string }>("peer_media_register_remote", { blake3: offer.blake3 });
    peerRegIdRef.current = reg.id;
    const marker = `peer://${offer.blake3.slice(0, 12)}`;
    resetForNewSource(marker);
    activeSourceUrlRef.current = marker;
    setActiveSourceUrl(marker);
    const seq = ++sourceSeqRef.current;
    setMetadata({
      title: pending.title ?? offer.name,
      duration: pending.duration,
      thumbnail: null,
      uploader: null,
      upload_date: null,
      view_count: null,
      webpage_url: marker,
      width: null,
      height: null,
      fps: null,
      vcodec: offer.vcodec,
      acodec: offer.acodec,
      ext: null,
      has_subs: false, chapters: [], description: null,
    });
    setSourceKind("youtube");
    setStatus("loaded");
    publishPlayheadFrames(0);
    setInFrames(null);
    setOutFrames(null);
    webPlayback.loadPeerStream(marker, { url: reg.url, videoCodec: offer.vcodec, audioCodec: offer.acodec }, seq);
  }, [resetForNewSource, webPlayback]);

  // hook's heartbeat/presence/chase read getPlayheadFrames() when they fire
  // (a render-mirrored value would go stale now that playback ticks don't
  // re-render App).
  const {
    coSession, coSessionActive, sessionDoc, postSessionOp, coGhostMarkers,
    liveReactions, raisedHands, handRaised, sendReaction, toggleHand,
    theater, setTheater, theaterParticipants,
    meshStreams, meshStates, meshMutedForMe, toggleMuteForMe,
    shareState, shareStream, sharingMembers, startShare, stopShare,
    isPresenter, pendingSource, sourceStatus, makePresenter, adoptPendingSource,
    offeredFile, transfer, offerCurrentFile, offerError, fetchOfferedFile, watchOfferedStream, cancelFetch,
    keepBadge, keepAction, onKeepCancel, onKeepResume, keepEnabled, setKeepEnabled,
    onKeepStall, onKeepStreamInfo,
    startCoReview, joinCoReview, leaveCoReview,
  } = useCoReview({
    isPlaying, fps, playbackRate,
    sessionSource, activeSourceUrlRef, reviewSourceKey,
    playerRef, metadataRef,
    onChaseSeek, setUrl, handleFetch, loadLocalPath, loadPeerStream,
    pushNotification, setQueueOpen,
    setReviewMarkers, setReviewAnnotations,
    turn: { url: defaults.turnUrl, username: defaults.turnUsername, password: defaults.turnPassword },
    appendLog,
  });

  // Two subsystems read the same two signals off the peer player: the quality
  // ladder (which rung to ask for) and the background copy (whether to get out
  // of the way). Composed here rather than fanned out from the player, so the
  // player keeps one prop each and neither subsystem can be wired to a stall
  // the other one sees — the exact drift that would make the copy starve a
  // picture it is supposed to be yielding to.
  // Destructured so the deps are the callbacks themselves rather than the
  // object holding them: both are stable, and depending on `streamRung` would
  // rebuild these on every rung state change for no reason.
  const { onStall: onRungStall, onStreamInfo: onRungStreamInfo } = streamRung;
  const onStreamStallAll = useCallback(() => {
    onRungStall();
    onKeepStall();
  }, [onRungStall, onKeepStall]);
  const onStreamInfoAll = useCallback((info: { rung: number | null; relayed: boolean }) => {
    onRungStreamInfo(info);
    onKeepStreamInfo(info);
  }, [onRungStreamInfo, onKeepStreamInfo]);
  // The SESSION ROOM: Review owns live sessions end to end. When a session
  // is live and the Review view is active, the room class reflows the Clip
  // stage into the room dressing (CSS only; the player subtree is untouched
  // and never remounts). Switching to Clip mid-session is allowed - the
  // session stays connected and the rail's Review badge is the way back.
  const reviewStatus = useMemo(() => {
    void reviewTick; // re-derive on review mutations
    const doc = sessionDoc ?? (reviewSourceKey ? loadReview(reviewSourceKey) : null);
    if (!doc) return null;
    const st = statusOf(doc, doc.activeVersionId);
    return st.updatedAt > 0 || st.state !== "pending" ? st : null;
  }, [sessionDoc, reviewSourceKey, reviewTick]);
  sessionRoomRef.current = coSessionActive;
  activeViewRef.current = activeView;
  const roomActive = coSessionActive && activeView === "coreview";
  // Display name of whoever is driving, for the waiting affordance.
  const presenterName = coSession.peers.find((p) => p.id === coSession.presenter)?.name
    ?? (coSession.presenter === "m0" ? "The host" : "The presenter");
  // Members who reported they can't open the current source ("missing" = they
  // don't have the file, "failed" = it broke on their machine).
  const blockedMembers = useMemo(() => {
    const out: string[] = [];
    for (const [id, state] of sourceStatus) {
      if (state !== "missing" && state !== "failed") continue;
      if (id === coSession.selfId) continue;
      out.push(coSession.peers.find((p) => p.id === id)?.name ?? "Someone");
    }
    return out;
  }, [sourceStatus, coSession.peers, coSession.selfId]);
  // Latest transient reaction per member: tile badges (pruning rides the
  // liveReactions feed itself).
  const reactionFlashes = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of liveReactions) m.set(r.from, reactionGlyph(r.emote));
    return m;
  }, [liveReactions]);
  // Room bar device toggles ride the same capture singleton the green room
  // opened; enabled-bit flips propagate to every mesh sender live.
  const capture = useMediaCapture();
  // A camera or mic that refuses to open must SAY so. These failures are
  // raised wherever the user acted (room control bar, self tile, Settings),
  // so they arrive through the capture singleton rather than this instance's
  // state — previously they landed in a field nothing rendered and a busy or
  // denied device failed in total silence.
  useEffect(() => subscribeCaptureError((e) => {
    if (e) pushNotification("error", "Camera or mic unavailable", e);
  }), [pushNotification]);
  // The capture singleton lives outside React, so it gets the log by
  // installation rather than by argument.
  useEffect(() => {
    setCaptureLogSink((tag, line) => appendLog(tag, "capture", line));
    return () => setCaptureLogSink(null);
  }, [appendLog]);
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
      // Earlier cuts' unresolved notes ride along dimmed: a notes pass on v2
      // is a scrubbing activity, and the old notes are where the stops are.
      const carriedM = carriedComments(d, d.activeVersionId);
      setReviewMarkers([
        ...markers.map((m) => ({
          id: m.id, time: m.time, timeEnd: m.timeEnd, resolved: m.resolved,
          color: reviewerColorFor(m.author, me), initials: initialsOf(m.author),
        })),
        ...carriedM.map(({ comment: c }) => ({
          id: c.id, time: c.timeStart, timeEnd: c.timeEnd, resolved: false,
          color: reviewerColorFor(c.author, me), initials: initialsOf(c.author),
          carried: true,
        })),
      ]);
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
    // `localFilePath`, `localFileSize` and `sourceKind` are read lexically inside
    // reload() and deliberately not listed: reviewSourceKey is DERIVED from all
    // three (see its useMemo), so any change that could alter what reload()
    // writes has already changed the key and re-run this effect with a fresh
    // closure. Listing them again would re-read the review store and re-register
    // the listener on every probe for a result that cannot differ.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- covered by reviewSourceKey, which derives from them
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
        // onSeek owns the duration clamp (playhead-clock) — no inline math
        // here, or an unknown duration snaps the cue click to frame 0.
        const r = Math.max(1, Math.round(fps));
        onSeek(Math.max(0, Math.floor(seconds * r)));
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
    ? ` · ${exportOpts.filename}`
    : "";
  // Nav-rail tooltip shortcuts — resolved from the LIVE bindings so a rebind
  // in Settings → Commands shows correctly in the rail titles.
  const homeCombo = bindingsFor("view.home", keybindings)[0];
  const libraryCombo = bindingsFor("view.library", keybindings)[0];
  const clipCombo = bindingsFor("view.clip", keybindings)[0];
  const coreviewCombo = bindingsFor("view.coreview", keybindings)[0];
  const readerCombo = bindingsFor("view.reader", keybindings)[0];

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
      {import.meta.env.DEV && mediaSpikeOpen && (
        <MediaSpikePanel appendLog={appendLog} onClose={() => setMediaSpikeOpen(false)} />
      )}
      {import.meta.env.DEV && peerSpikeOpen && (
        <PeerStreamSpike
          localFilePath={localFilePath}
          duration={metadata?.duration ?? null}
          appendLog={appendLog}
          onClose={() => setPeerSpikeOpen(false)}
        />
      )}
      <div className="cp-titlebar" data-tauri-drag-region>
        <div className="cp-titlebar-title" data-tauri-drag-region>
          Sauce Bunny{titleSuffix}
        </div>
      </div>

      <div className={"cp-body" + (roomActive ? " cp-room" : "") + (roomActive && theater ? " cp-room-theater" : "")}>
        {/* display:contents wrapper (rail is a plain flex child). The rail is
            ALWAYS visible — the session room is not an exception (the old
            theater edge-reveal overlay is retired; see room.css). */}
        <div className="cp-nav-dock">
          <NavRail
            active={activeView}
            onNavigate={navigateView}
            onOpenSettings={() => setSettingsOpen(true)}
            homeShortcut={homeCombo ? formatCombo(homeCombo) : undefined}
            libraryShortcut={libraryCombo ? formatCombo(libraryCombo) : undefined}
            clipShortcut={clipCombo ? formatCombo(clipCombo) : undefined}
            coreviewShortcut={coreviewCombo ? formatCombo(coreviewCombo) : undefined}
            readerShortcut={readerCombo ? formatCombo(readerCombo) : undefined}
            sessionActive={coSessionActive}
            sessionPeers={coSession.peers.length}
          />
        </div>
        <div className="cp-views">
          {/* Home — the landing page. Scan state comes from useLibraryScan
              (shared with the Library browser); App supplies the open handlers
              + recents. Drilling into a folder routes to the Library browser. */}
          <div ref={homeViewRef} tabIndex={-1} className="cp-view cp-view-home" hidden={activeView !== "home"}>
            <LibraryView
              recentSources={recentSources}
              onOpenLocalPath={handleLibraryOpenLocalPath}
              onReviewLocalPath={handleReviewLocalPath}
              onReviewRecentSource={handleReviewRecentSource}
              onOpenRecentSource={handleLibraryOpenRecent}
              onOpenTranscriptHistory={handleLibraryOpenTranscript}
              transcriptLibraryPath={defaults.transcriptLibrary}
              onSwitchToClip={handleSwitchToClip}
              onOpenFolder={handleOpenLibraryFolder}
              homeResetSignal={homeResetTick}
              homeVisible={activeView === "home"}
              roots={lib.roots}
              scans={lib.scans}
              addFolder={lib.addFolder}
              removeRoot={lib.removeRoot}
              scanRoot={lib.scanRoot}
              requestThumb={lib.requestThumb}
              invalidateThumb={lib.invalidateThumb}
              posterVersions={lib.posterVersions}
              bumpPoster={lib.bumpPoster}
              resetPoster={lib.resetPoster}
            />
          </div>
          {/* Library — the Plex/Finder detail browser over the same scanned
              roots. Keep-alive like the others; shares lib's scan results. */}
          <div ref={libraryViewRef} tabIndex={-1} className="cp-view cp-view-library" hidden={activeView !== "library"}>
            <LibraryBrowser
              onReviewLocalPath={handleReviewLocalPath}
              onOpenWebUrl={(u: string) => { setUrl(u); void handleFetch(u); }}
              roots={lib.roots}
              scans={lib.scans}
              scanning={lib.scanning}
              addFolder={lib.addFolder}
              removeRoot={lib.removeRoot}
              rescanAll={lib.rescanAll}
              requestThumb={lib.requestThumb}
              invalidateThumb={lib.invalidateThumb}
              posterVersions={lib.posterVersions}
              bumpPoster={lib.bumpPoster}
              resetPoster={lib.resetPoster}
              selection={librarySelection}
              selectionTick={librarySelectTick}
              onOpenLocalPath={handleLibraryOpenLocalPath}
              onOpenTranscriptHistory={handleLibraryOpenTranscript}
              onBatchTranscribe={startBatchTranscribe}
              batchLine={batch.progress.running ? batchSummary(batch.progress) : null}
              onBatchCancel={batch.cancel}
            />
          </div>
          {/* Transcripts reader — a reading-first workspace over every
              transcript on disk, outside the Clip editor. The picker lives in
              TranscriptReader; the reading pane is the real TranscriptViewer,
              passed as children so its handler bundle stays in App scope. The
              follow-along player (ReaderPlayerStage) resolves its source the same
              way Clip does; source-dependent chrome (Regenerate/Fix-timing)
              self-hides via hasSource=false since the reader can't regenerate. */}
          <div ref={readerViewRef} tabIndex={-1} className="cp-view cp-view-reader" hidden={activeView !== "reader"}>
            <TranscriptReader
              transcriptLibraryPath={defaults.transcriptLibrary}
              activePath={transcriptPath}
              onOpenTranscript={handleReaderOpenTranscript}
              visible={activeView === "reader"}
              requestThumb={lib.requestThumb}
              posterVersions={lib.posterVersions}
              recents={recentSources}
              stageAvailable={transcriptPath != null}
              stageExpanded={readerStageOpen}
              stageFloating={readerFloating}
              onExpandStage={() => { setReaderStageOpen(true); setReaderFloating(false); }}
              docTab={readerDocTab}
              onDocTab={setReaderDocTab}
              onRenameTranscript={handleRenameTranscript}
              onMoveTranscript={handleMoveTranscript}
              analysis={
                <ReaderAnalysis
                  transcriptPath={transcriptPath}
                  visible={activeView === "reader" && readerDocTab === "analysis"}
                  selectedModelId={defaults.llmSummarizationModel}
                  style={{ format: defaults.summaryFormat, length: defaults.summaryLength }}
                  onSeek={(seconds) => readerPlayerRef.current?.seekTo(seconds)}
                  onOpenSettings={() => { setSettingsInitialTab("ai-summary"); setSettingsOpen(true); }}
                />
              }
              stage={
                <ReaderPlayerStage
                  source={readerSource}
                  preparing={readerPreparing}
                  note={readerNote}
                  playerRef={readerPlayerRef}
                  floating={readerFloating}
                  active={activeView === "reader"}
                  onToggleFloat={() => setReaderFloating((f) => !f)}
                  onCollapse={() => { setReaderStageOpen(false); setReaderFloating(false); }}
                  onTimeUpdate={activeView === "reader" ? onReaderTimeUpdate : undefined}
                  onPlayStateChange={setIsPlaying}
                  onError={handleReaderMediaError}
                  initialVolume={muted ? 0 : volume}
                />
              }
            >
              <TranscriptViewer
                onUndo={performUndo}
                onRedo={performRedo}
                path={transcriptPath}
                reloadToken={transcriptArrivedTick}
                playheadActive={activeView === "reader" && readerDocTab === "document"}
                fps={readerSource?.fps ?? fps}
                startTimecode={readerStartTc}
                onSetSourceTimecode={readerSourceKey ? (tc) => {
                  if (tc) setSourceTimecode(readerSourceKey, tc); else clearSourceTimecode(readerSourceKey);
                  setReaderStartTc(tc ?? undefined);
                } : undefined}
                onSeek={(seconds) => readerPlayerRef.current?.seekTo(seconds)}
                origin={activeTranscript?.origin ?? "unknown"}
                onClearTranscript={() => { readerOpenSeqRef.current++; setActiveTranscript(null); setReaderSource(null); setReaderSourceKey(null); setReaderStartTc(undefined); setReaderNote(null); setReaderPreparing(false); }}
                onLoadFromHistory={handleReaderOpenTranscript}
                onRegenerate={() => { /* reading-first: no source to regenerate from */ }}
                regenerateBusy={false}
                canRegenerate={false}
                onImportTranscript={() => { /* reading-first: pick from the list */ }}
                hasSource={false}
              />
            </TranscriptReader>
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
              onToggleQueue={() => setQueueOpenChoice((p) => !p)}
              queueCount={clipQueue.length}
              queueOpen={queueOpen}
              sidebarOpen={sidebarOpen}
              onToggleSidebar={() => setSidebarOpenChoice(!sidebarOpen)}
              hasSource={status === "loaded" || status === "exporting" || status === "success" || status === "error"}
              status={status}
              fetchPhase={fetchButtonPhase(fetchPhase, status)}
              onFetchResolved={() => setFetchPhase("idle")}
              notifications={notifications}
              onMarkAllRead={onMarkAllRead}
              onClearNotifications={onClearNotifications}
              onDismissNotification={onDismissNotification}
            />

            <div className="cp-clip-body">
              {/* The room's People panel (roster avatars until the webcam
                  tiles land in the next build). Always mounted as a stable
                  sibling of <main> so entering the room never remounts the
                  player; renders nothing outside the room. */}
              <PeoplePanel
                active={roomActive && !theater}
                participants={theaterParticipants}
                remoteStreams={meshStreams}
                peerStates={meshStates}
                mutedForMe={meshMutedForMe}
                onToggleMuteForMe={toggleMuteForMe}
                sharingMembers={sharingMembers}
                shareStream={shareStream}
                raisedHands={raisedHands}
                reactionFlashes={reactionFlashes}
                presenter={coSession.presenter}
                canGrantPresenter={coSession.role === "host"}
                onMakePresenter={makePresenter}
                /* Your own tile is also your device control - same capture
                   singleton the room bar drives, so the two stay in step. */
                selfCamOff={capture.choice.cameraOff}
                selfMicMuted={capture.choice.micMuted}
                onToggleCam={() => capture.setEnabled("video", capture.choice.cameraOff)}
                onToggleMic={() => capture.setEnabled("audio", capture.choice.micMuted)}
              />
              <Sidebar
                reviewStatus={reviewStatus}
                onFilenameEdit={markFilenameEdited}
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
                {roomActive && (
                  <div className="cp-room-head">
                    <div className="cp-room-title">
                      <span className="cp-room-live" aria-hidden />
                      <span className="cp-room-name" title={coSession.title || metadata?.title || undefined}>
                        {coSession.title || metadata?.title || "Review session"}
                      </span>
                      {metadata?.title && coSession.title && metadata.title !== coSession.title && (
                        <span className="cp-room-source" title={metadata.title}>{metadata.title}</span>
                      )}
                      {reviewStatus && reviewStatus.state !== "pending" && (
                        <ReviewStatusChip state={reviewStatus.state} reviewer={reviewStatus.reviewer || undefined} />
                      )}
                      {/* Who could NOT open what the room is watching. This is
                          replicated already (SourceStatus) but was never shown,
                          so a presenter had no way to know a guest was staring
                          at an empty stage. */}
                      {blockedMembers.length > 0 && (
                        <span className="cp-room-blocked" title="They can't open this source">
                          {blockedMembers.join(", ")} can&apos;t open this
                        </span>
                      )}
                      {/* Tier C, sender side. Offering is explicit (this click
                          is the consent step for a multi-GB read), and the
                          transfer row narrates hash + send progress. */}
                      {isPresenter && sourceKind === "file" && localFilePath
                        && blockedMembers.length > 0 && !offeredFile
                        && transfer?.phase !== "hashing" && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-compact"
                          title="Send your copy of this file over the session. They see the name and size and choose to accept."
                          onClick={() => { void offerCurrentFile(localFilePath, metadata?.title ?? undefined, metadata?.vcodec ?? null, metadata?.acodec ?? null); }}
                        >
                          Send them the file
                        </button>
                      )}
                      {/* An offer that failed used to go to the pipeline log
                          and nowhere else: the host clicked, nothing visible
                          happened, and the guests went on reading "That file
                          lives on their Mac" with nobody able to say why. */}
                      {offerError && (
                        <span className="cp-room-blocked" role="alert">
                          {`Could not offer the file: ${offerError}`}
                        </span>
                      )}
                      {transfer?.phase === "hashing" && (
                        <span className="cp-room-blocked">Preparing the file…</span>
                      )}
                      {transfer?.phase === "sending" && (
                        <span className="cp-room-blocked">
                          {`Sending to ${coSession.peers.find((p) => p.id === transfer.member)?.name ?? "a guest"} · ${transfer.total > 0 ? Math.floor((transfer.received / transfer.total) * 100) : 0}%`}
                        </span>
                      )}
                      {isPresenter && offeredFile && transfer?.phase !== "sending" && (
                        <span className="cp-room-blocked" title="Guests without the file see a Get button">
                          File offered to the room
                        </span>
                      )}
                    </div>
                    {/* Change what the room is watching without leaving the
                        session. The room hides Clip's toolbar (and with it the
                        URL bar + Import), which used to mean the only way to
                        switch sources was to end the session. Presenter only. */}
                    {isPresenter && (
                      <RoomSourceBar
                        hasSource={hasSource}
                        onLoadUrl={(u) => { setUrl(u); void handleFetch(u); }}
                        onImportFile={() => { void handleImportFile(); }}
                        onClear={handleClear}
                      />
                    )}
                    <div className="cp-room-head-actions">
                      {coSession.role === "host" && coSession.code && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-compact cp-room-code"
                          title="Copy the join code"
                          onClick={() => { if (coSession.code) void navigator.clipboard.writeText(coSession.code).then(() => pushNotification("success", "Join code copied", "")); }}
                        >
                          Copy join code
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn cp-room-end"
                        title={coSession.role === "host" ? "End the session for everyone" : "Leave the session"}
                        onClick={leaveCoReview}
                      >
                        {coSession.role === "host" ? "End session" : "Leave session"}
                      </button>
                    </div>
                  </div>
                )}
                {/* What the room is watching, when WE can't show it yet. The
                    old version tested role === "guest", a string Rust never
                    emits ("off" | "host" | "peer"), so it never rendered and
                    a non-presenter just saw the solo empty state. */}
                {roomActive && !isPresenter && pendingSource && (
                  <div className="cp-room-waiting">
                    {transfer && (transfer.phase === "receiving" || transfer.phase === "checking") ? (
                      /* Tier C, receiver side: determinate progress in place
                         of the waiting affordances (spec 5c). The partial is
                         kept on Cancel, so fetching again resumes. */
                      <div className="cp-transfer-row">
                        <span className="cp-transfer-label">
                          {transfer.phase === "checking"
                            ? `Checking the partial copy of ${transfer.name}…`
                            : `Receiving ${transfer.name} · ${formatTransferSize(transfer.received)} of ${formatTransferSize(transfer.total)}`}
                        </span>
                        <div className="cp-transfer-bar" aria-hidden>
                          <div
                            className="cp-transfer-fill"
                            style={{ width: `${transfer.total > 0 ? Math.min(100, (transfer.received / transfer.total) * 100) : 0}%` }}
                          />
                        </div>
                        <button type="button" className="cp-transfer-cancel" onClick={cancelFetch}>
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <>
                        <span>
                          {pendingSource.kind === "file"
                            ? `${presenterName} is watching ${pendingSource.title ?? "a local file"}. That file lives on their Mac.`
                            : `Loading ${pendingSource.title ?? "the shared source"}…`}
                        </span>
                        {pendingSource.kind === "file" && offeredFile && offeredFile.vcodec && (
                          /* Tier B: watch NOW, streamed live from the host.
                             Needs codec strings (no probe on a peer route);
                             an older host's offer just hides this chip. */
                          <button
                            type="button"
                            className="btn btn-ghost btn-compact"
                            title={
                              "Starts playing straight away, streamed over the session. "
                              + "A copy is saved to this Mac while you watch, so when it finishes "
                              + "you can scrub the whole file and you keep it afterwards. "
                              + "On a relayed connection nothing is saved."
                            }
                            onClick={() => { void watchOfferedStream(); }}
                          >
                            {/* The label says "saves a copy" because the tooltip
                                used to promise the opposite, and the sibling
                                Get chip treats naming the write as the consent.
                                A multi-GB write must be in the thing you click,
                                not only in the thing you hover. */}
                            {`Watch now (streams from ${presenterName}, saves a copy)`}
                          </button>
                        )}
                        {pendingSource.kind === "file" && offeredFile && (
                          /* The chip names the file and its size; clicking it
                             IS the consent to a multi-GB write on this disk. */
                          <button
                            type="button"
                            className="btn btn-ghost btn-compact"
                            title="The host sends their copy over the session. It is verified, saved to the cache, and opens when done."
                            onClick={() => { void fetchOfferedFile(); }}
                          >
                            {`Get "${offeredFile.name}" (${formatTransferSize(offeredFile.size)})`}
                          </button>
                        )}
                        {pendingSource.kind === "file" && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-compact"
                            title="Point at your own copy of this file"
                            onClick={() => { void adoptPendingSource(); }}
                          >
                            Open my copy…
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
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
                    /* r122: cached copies play mediabunny-first (large files hang
                       native <video> over asset:// — same lesson as r107 locals). */
                    webCachedUseMediabunny={webCachedPlayer === "mediabunny"}
                    streamStartAt={webPlayback.streamStartAt}
                    disableScrubPreview={activeSourceUrl?.startsWith("peer://") ?? false}
                    /* Tier B adaptive quality (step 3e). Null for a web source:
                       the ladder only means anything when another Mac is
                       encoding for us. */
                    streamRung={streamRung.rung}
                    onStreamStall={onStreamStallAll}
                    onStreamInfo={onStreamInfoAll}
                    streamRungBadge={streamRung.badge}
                    streamRungBadgeTitle={streamRung.badgeTitle}
                    streamKeepBadge={keepBadge}
                    streamKeepAction={keepAction}
                    onStreamKeepAction={keepAction?.kind === "resume" ? onKeepResume : onKeepCancel}
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
                    scrubAudio={defaults.scrubAudio}
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
                          `${msg.replace("[WEBCODECS_UNSUPPORTED]", "WebCodecs doesn't support")}. Falling back to ffmpeg prep.`);
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
                          "Native <video> couldn't load this file. Decoding in-app via mediabunny.");
                        return;
                      }

                      // Cached web copy failed to play (r122): swap players once
                      // per cache path instead of dead-ending in a toast. The
                      // mediabunny default covers the large-file <video> hang;
                      // this covers the inverse (WebCodecs chokes, native works).
                      const cachePath = webPlayback.cachePath;
                      if (cachePath && webCachedSwapRef.current !== cachePath) {
                        webCachedSwapRef.current = cachePath;
                        const next = webCachedPlayer === "mediabunny" ? "native" : "mediabunny";
                        setWebCachedPlayer(next);
                        appendLog("warn", "media",
                          `Cached copy failed in the ${webCachedPlayer} player. Retrying with ${next}.`);
                        return;
                      }

                      // Web-source playback fallback (r80): delegate to the state
                      // machine. When it's mid-stream it logs, shows the toast, and
                      // transitions streaming → downloading (exactly once — the
                      // double-download race is gone) and returns true. Any other
                      // state returns false → fall through to the generic error.
                      // Force the transport out of "playing" for the handoff: the
                      // dying MSE element's queued pause event can be dropped
                      // during unmount, stranding the play button.
                      if (webOnMediaError(msg)) { setIsPlaying(false); return; }

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
                    transcriptPath={clipTxPath}
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
                  {roomActive && <ReactionLayer reactions={liveReactions} />}
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
                    roomControls={roomActive ? (
                      <RoomControlBar
                        micOn={!capture.choice.micMuted}
                        camOn={!capture.choice.cameraOff}
                        onToggleMic={() => capture.setEnabled("audio", capture.choice.micMuted)}
                        onToggleCam={() => capture.setEnabled("video", capture.choice.cameraOff)}
                        shareState={shareState}
                        onStartShare={startShare}
                        onStopShare={stopShare}
                        theater={theater}
                        onToggleTheater={() => setTheater((v) => !v)}
                        onReact={sendReaction}
                        handRaised={handRaised}
                        onToggleHand={toggleHand}
                      />
                    ) : undefined}
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
                      label: c.filename,
                    }))}
                    onRangeClick={(id) => {
                      setQueueOpen(true);
                      setQueueFocusItem({ id, tick: Date.now() });
                    }}
                    commentMarkers={reviewMarkers}
                    chapterMarkers={chapterMarkers}
                    reviewRangeDraft={reviewRangeDraft}
                    filmstripPath={sourceKind === "file" ? (playbackPath ?? localFilePath) : null}
                    waveformOn={waveformVisible}
                    speakerLanes={speakerLaneData}
                    ghosts={coGhostMarkers}
                    onSeek={onSeek}
                  />
                  {/* Status line under the timeline (9a): the no-marks helper
                      shows ONLY with no marks and an empty queue; a completed
                      selection (or a queued no-marks state) renders NOTHING -
                      the row's space collapses, no reserved empty line.
                      Partial-mark guidance stays (it completes the gesture). */}
                  {roomActive && theater && (
                    <PeoplePanel
                      active
                      strip
                      participants={theaterParticipants}
                      remoteStreams={meshStreams}
                      peerStates={meshStates}
                      mutedForMe={meshMutedForMe}
                      onToggleMuteForMe={toggleMuteForMe}
                      sharingMembers={sharingMembers}
                      shareStream={shareStream}
                      raisedHands={raisedHands}
                      reactionFlashes={reactionFlashes}
                    />
                  )}
                  {!roomActive && (() => {
                    const content =
                      (status === "loaded" || status === "success")
                        ? (inFrames == null && outFrames == null
                          ? (clipQueue.length === 0
                            ? `No marks set. Export grabs the whole clip${exportOpts.format === "audio" ? " as MP3" : ""}.`
                            : null)
                          : inFrames != null && outFrames == null
                            ? "Mark out (O) to set the end."
                            : inFrames == null && outFrames != null
                              ? "Mark in (I) to set the start."
                              : null)
                        : status === "empty" && bindingsFor("app.shortcuts", keybindings)[0]
                          ? (
                            <>
                              <kbd className="cp-keycap">
                                {formatCombo(bindingsFor("app.shortcuts", keybindings)[0])}
                              </kbd>
                              {" Shortcuts"}
                            </>
                          )
                          : null;
                    // ALWAYS render the row. Returning null removed the
                    // element outright, so its reserved height and margin went
                    // with it and everything below jumped the moment a mark was
                    // set. The row holds its line box when it has nothing to
                    // say; aria-hidden keeps an empty one out of the a11y tree.
                    return (
                      <div className="cp-timeline-hint" aria-hidden={!content}>
                        {content}
                      </div>
                    );
                  })()}
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
              {/* The room's review rail overrides detachment - a session
                  with no review panel is a session you can't comment in. */}
              {(roomActive || !panelDetached) && <QueueDrawer
                onUndo={performUndo}
                onRedo={performRedo}
                onGrabFace={grabFaceFromFrame}
                open={roomActive ? true : queueOpen}
                /* Clip is keep-alive, so this subtree stays mounted on Home /
                   Library. `|| roomActive` is load-bearing: room.css un-hides
                   the Clip view during a session while activeView is
                   "coreview", and the review rail there is genuinely visible. */
                viewActive={activeView === "clip" || roomActive}
                roomFace={roomActive}
                focusItem={queueFocusItem}
                onClose={() => setQueueOpenChoice(false)}
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
                transcriptPath={clipTxPath}
                transcriptOrigin={activeTranscript?.origin ?? "unknown"}
                playheadAvailable={hasSource}
                transcriptFps={fps}
                sourceStartTimecode={clipStartTc}
                onSetSourceTimecode={clipSourceKey ? (tc) => {
                  if (tc) setSourceTimecode(clipSourceKey, tc); else clearSourceTimecode(clipSourceKey);
                  setClipSourceTcTick((n) => n + 1);
                } : undefined}
                onTranscriptSeek={(seconds) => {
                  // onSeek owns the duration clamp (playhead-clock) — no
                  // inline math here, or an unknown duration snaps the cue
                  // click to frame 0.
                  const r = Math.max(1, Math.round(fps));
                  onSeek(Math.max(0, Math.floor(seconds * r)));
                }}
                transcriptArrivedTick={transcriptArrivedTick}
                onClearTranscript={handleClearTranscript}
                onLoadFromHistory={handleLoadFromHistory}
                onRegenerateTranscript={handleGenerateTranscript}
                regenerateBusy={transcriptState === "running"}
                canRegenerate={hasSource && (defaults.transcriptionEngine === "parakeet" || !!selectedModel?.downloaded)}
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
                sourceDescription={metadata?.description ?? null}
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
                onReviewLinkAsVersion={sourceKind === "file" ? linkAsReviewVersion : undefined}
                onReviewUnlinkVersion={sourceKind === "file" ? unlinkReviewVersion : undefined}
                reviewSourcePath={sourceKind === "file" ? localFilePath : null}
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
              theater" lands on Clip with theater on (the theater overlays the
              Clip player). */}
          <div ref={coreviewViewRef} tabIndex={-1} className="cp-view cp-view-coreview" hidden={activeView !== "coreview"}>
            <CoReviewLobby
              session={coSession}
              localSource={coLocalSourceLoaded}
              participants={theaterParticipants}
              onStart={(title) => { void startCoReview(title); }}
              onJoin={(t, n) => { void joinCoReview(t, n); }}
              onLeave={leaveCoReview}
            />
          </div>
        </div>
      </div>

      <SettingsModal
        open={settingsOpen}
        onClose={() => { setSettingsOpen(false); setSettingsInitialTab("general"); refreshWhisperModels(); }}
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
        streamRungPref={streamRung.pref}
        setStreamRungPref={streamRung.setPref}
        keepEnabled={keepEnabled}
        setKeepEnabled={setKeepEnabled}
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
      {txSearchOpen && (
        <TranscriptSearchModal
          onClose={() => setTxSearchOpen(false)}
          onOpenAt={(path, seconds) => {
            // Reuse the history-open path: it loads the source, navigates and
            // gates exactly the way opening a transcript anywhere else does, so
            // arriving from search is not a second, subtly different flow.
            // Reuse the history entry when there is one, so the transcript
            // arrives with its source attached. A transcript found on disk but
            // absent from history (older than the 50-entry cap, or history
            // cleared) still opens, detached — the same graceful path the
            // library browser already relies on.
            const entry: TranscriptHistoryEntry = getTranscriptHistory().find((e) => e.srtPath === path)
              ?? {
                // Same synthesized shape the library scan uses for a transcript
                // history has forgotten (older than the 50-entry cap, or after a
                // clear). It opens detached rather than not at all.
                id: `search:${path}`,
                srtPath: path,
                sourcePath: null,
                sourceUrl: null,
                title: (path.split("/").pop() ?? path).replace(/\.[^.]+$/, ""),
                origin: "unknown",
                createdAt: 0,
                lastOpenedAt: 0,
              };
            void handleLoadFromHistory(entry).then(() => {
              // Seek AFTER the source has had a chance to attach; a seek issued
              // before load lands on a player that is about to be replaced.
              // Same clamp path a cue click uses: onSeek owns the duration
              // clamp, so no inline math here.
              setTimeout(() => {
                const r = Math.max(1, Math.round(fps));
                onSeek(Math.max(0, Math.floor(seconds * r)));
              }, 350);
            });
          }}
        />
      )}

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
              : status === "error" ? "Operation failed. Check the pipeline log"
                : transcriptState === "error" ? "Transcription failed"
                  : transcriptState === "done" ? "Transcript ready"
                    : ""}
      </div>

      {/* First-launch welcome — covers everything (incl. the Connect YouTube
          prompt, which is then revealed after Get started). Shows once. */}
      {showWelcome && (
        <WelcomeScreen onDone={() => {
          try { localStorage.setItem("saucebunny.welcomed", "1"); } catch { /* quota */ }
          setShowWelcome(false);
        }} />
      )}
    </div>
  );
}
