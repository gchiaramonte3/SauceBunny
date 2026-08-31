import {
  useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"; import { invoke } from "@tauri-apps/api/core"; import { notifyFramesChanged } from "./lib/frames"; import { getVersion } from "@tauri-apps/api/app"; import { listen } from "@tauri-apps/api/event"; import { save as saveDialog } from "@tauri-apps/plugin-dialog"; import {   isPermissionGranted, requestPermission, sendNotification, } from "@tauri-apps/plugin-notification"; import { Toolbar } from "./components/Toolbar"; import { NavRail } from "./components/NavRail";  import { LibraryView } from "./components/LibraryView"; import { LibraryBrowser } from "./components/LibraryBrowser"; import { useTranscriptListeners } from "./hooks/use-transcript-listeners"; import { useDiarizerPrepare } from "./hooks/use-diarizer-prepare"; import { useLibraryScan } from "./hooks/use-library-scan"; import { Sidebar } from "./components/Sidebar"; import { PeoplePanel } from "./components/PeoplePanel"; import { ReactionLayer } from "./components/ReactionLayer"; import { MediaSpikePanel } from "./components/MediaSpikePanel"; import { PeerStreamSpike } from "./components/PeerStreamSpike"; import { CoReviewLobby } from "./components/CoReviewLobby"; import { Monitor, type AspectId } from "./components/Monitor"; import type { Notif } from "./components/NotificationBell"; import type { ToastKind } from "./components/CanvasToast"; import { playSuccess, playError, playInfo } from "./lib/sound"; import { Transport } from "./components/Transport"; import { Timeline } from "./components/Timeline"; import { ViewOptions } from "./components/ViewOptions"; import { LogsPanel } from "./components/LogsPanel"; import { RoomControlBar } from "./components/RoomControlBar"; import { ReviewStatusChip } from "./components/ReviewStatusChip"; import { useMediaCapture, subscribeCaptureError, setCaptureLogSink } from "./hooks/use-media-capture"; import { SettingsModal, type Defaults } from "./components/SettingsModal"; import { YouTubeAuthModal } from "./components/YouTubeAuthModal"; import type { PlayerHandle } from "./components/player-handle"; import type {   AppStatus, ClientLog, ExportOpts, LocalFileMeta, Metadata, QueuedClip, RecentClip, SourceKind, WhisperModel, ReviewRangeDraft, } from "./types"; import { isQueuedClip } from "./types"; import { asLogTag } from "./types"; import { formatError } from "./lib/error-format"; import { fmtElapsed, stageLabel } from "./lib/elapsed"; import { fetchButtonPhase, type StatefulPhase } from "./lib/stateful-phase"; import { getPlayheadFrames, setPlayheadFrames as publishPlayheadFrames, playheadFramesToSeconds, playheadSecondsToFrames, markUserSeek } from "./lib/playhead-store"; import { usePanelBus } from "./hooks/use-panel-bus"; import { useStreamRung } from "./hooks/use-stream-rung"; import type { YtdlpStatus } from "./bindings/YtdlpStatus"; import { clipTranscriptPath, type ActiveTranscript } from "./lib/transcript-owner"; import { useTransport } from "./hooks/use-transport"; import { useSourceMarks } from "./hooks/use-source-marks"; import { useTranscriptJobs } from "./hooks/use-transcript-jobs"; import { useFetchSource } from "./hooks/use-fetch-source"; import { useLocalSource } from "./hooks/use-local-source"; import { useWebPlayback } from "./hooks/use-web-playback"; import { useCoReview, type ReviewMarkerView, type ReviewAnnotationView, type SessionSource } from "./hooks/use-co-review"; import { QueueDrawer } from "./components/QueueDrawer"; import { TranscriptReader } from "./components/TranscriptReader"; import { TranscriptViewer } from "./components/TranscriptViewer"; import { ReaderPlayerStage, type ReaderSource } from "./components/ReaderPlayerStage"; import { useReaderMarkers } from "./hooks/use-reader-markers"; import { ReaderAnalysis } from "./components/ReaderAnalysis"; import { CommandPalette } from "./components/CommandPalette"; import { ShortcutSheet } from "./components/ShortcutSheet"; import { DropTarget } from "./components/DropTarget"; import { WelcomeScreen } from "./components/WelcomeScreen"; import { PermissionsOnboarding } from "./components/PermissionsOnboarding"; import { RoomSourceBar } from "./components/RoomSourceBar"; import { VIDEO_EXTENSIONS, AUDIO_EXTENSIONS } from "./lib/import-extensions"; import {   findForSource, touchEntry, renameEntryPath as renameTranscriptEntryPath, notifyTranscriptsChanged, getHistory as getTranscriptHistory, type TranscriptHistoryEntry, } from "./lib/transcript-history"; import { prepareCues, renameSpeakerOverridesPath } from "./components/transcript/helpers"; import {   deriveOnboardingSteps, onboardingComplete, loadOnboardingDismissed, saveOnboardingDismissed, type OnboardingStepId, } from "./lib/onboarding"; import type { Command } from "./lib/commands"; import { buildCommands } from "./lib/commands"; import { markRangeFromSeconds as markRange } from "./lib/mark-range"; import { useBatchTranscribe } from "./hooks/use-batch-transcribe"; import { TranscriptSearchModal } from "./components/TranscriptSearchModal"; import { batchSummary } from "./lib/batch-queue"; import {   loadKeybindings, saveKeybindings, buildComboMap, bindingsFor, formatCombo, KEY_ACTION_BY_ID, type KeyActionId, type KeybindingOverrides, } from "./lib/keybindings"; import { migrateLegacyStorageKeys } from "./lib/migrate-storage"; import { sanitizePlaybackRate, stepPlaybackRate } from "./lib/playback-rate"; import { parseSrt } from "./lib/srt"; import { speakerLanes } from "./lib/speaker-stats"; import { speakerColor, loadSpeakerOverrides, resolveAliasChain, SPEAKERS_CHANGED_EVENT } from "./components/transcript/helpers"; import { speakerFingerprint, seedSpeakerOverridesFromFingerprint, linkSpeakerOverridesToFingerprint } from "./lib/speaker-identity"; import { MediaInfoModal } from "./components/MediaInfoModal"; import { loadReview, saveReview, ensureVersion, setActiveVersion, removeVersion, unlinkFingerprint, canUnlinkVersion, carriedComments, statusOf, commentMarkers as reviewMarkersOf, annotationsOf, reviewFingerprint, resolveByFingerprint, linkFingerprint, upsertReviewHistory, loadReviewer, reviewerColorFor, initialsOf, REVIEW_CHANGED_EVENT, type AnnotationStrokes, receivedReviewKey,
} from "./lib/review";
import { loadChapters, adoptSourceChapters, CHAPTERS_CHANGED_EVENT, type Chapter as ChapterMarker } from "./lib/chapters";
import { appUndo } from "./lib/undo";
import { loadClipQueue, loadJson, saveClipQueue, saveJson } from "./lib/storage";
import { useClipExportListeners } from "./hooks/use-clip-export-listeners";
import { usePlaybackPrepListeners } from "./hooks/use-playback-prep-listeners";
import { useCaptionsListeners } from "./hooks/use-captions-listeners";
import { useMenubarEvents } from "./hooks/use-menubar-events";
import { useKeyboardShortcuts } from "./hooks/use-keyboard-shortcuts";
import { useClipExport } from "./hooks/use-clip-export";
import { useClipQueue } from "./hooks/use-clip-queue";
import { loadRecentSources, saveRecentSources, upsertRecent, removeRecent, type RecentSource } from "./lib/recent-sources";
import {
  durationToTc, framesToTc, tcToFrames, isCompleteTc,
  tcDigitsToDisplay,
} from "./lib/timecode";
import { currentQueueSource, queuedRangesForSource } from "./lib/queue-ranges";
import { FDA_GRANTED, NO_PERMISSION_BROWSERS, safariGuidance } from "./lib/safari-fallback";
import { hostnameOf, youTubeThumbnailUrl, isYouTubeBotError, needsCookiesError, looksLikeExtractorRot, prettyHost } from "./lib/validation";
import { sanitizeFilename, suggestFilename } from "./lib/filename";
import { decodeHtmlEntities } from "./lib/text";
import { EXPECTED_BACKEND_BUILD_ID, type BuildIdCheck } from "./lib/build-id";
import { capabilitySummary, probePlatformCapabilities } from "./lib/platform-capabilities";
import { onReviewStoreProblem } from "./lib/review-store";
import { onStorageProblem } from "./lib/storage";
import { onFutureStoreVersion } from "./lib/store-schema";
import { assetUrl } from "./lib/asset-url";
import { buildDiagnosticsReport, diagnosticsFilename, type SessionDiagnostics } from "./lib/diagnostics";
import { extractFrameAsBlob, canMediabunnyDecode } from "./lib/mediabunny-helpers";
import { frameToAvatarDataUrl } from "./lib/avatar";
import { sourceTimecodeFor, setSourceTimecode, clearSourceTimecode } from "./lib/library";
import { webPosterFor, setWebPoster } from "./lib/web-poster-store";
import { migrateCaptionFont } from "./lib/caption-font";
import { isMissingCommandError, staleBinaryMessage } from "./lib/stale-backend";
import { newJobId } from "./lib/job-id";
import { DEFAULT_STUN_URL } from "./lib/ice-servers";

const DEFAULT_FPS_FALLBACK: Record<string, number> = { "24": 24, "25": 25, "30": 30 };


function nowHms(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
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
      // `??` not `||`: an empty string is a DELIBERATE "contact nobody",
      // and must not fall back to the default. See lib/ice-servers.
      stunUrl: stored.stunUrl ?? DEFAULT_STUN_URL,
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
      autoKeepSessionCopy: stored.autoKeepSessionCopy ?? false,
      sessionCopyDest: stored.sessionCopyDest ?? "cache",
      sessionCopyFolder: stored.sessionCopyFolder ?? null,
      // r141 cache retention: 0 = keep everything (the long-standing
      // default). A positive cap LRU-prunes the media cache at boot and
      // whenever the cap is changed in Settings.
      mediaCacheCapGb: stored.mediaCacheCapGb ?? 0,
      clearCacheOnQuit: stored.clearCacheOnQuit ?? false,
      // r143: NLE-style audio blips while dragging the playhead (WebCodecs
      // player). Editors expect scrub audio, so it defaults on.
      scrubAudio: stored.scrubAudio ?? false,
      transcriptionSpeed: stored.transcriptionSpeed ?? "accurate",
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
    invoke("set_clear_cache_on_quit", { enabled: boot.clearOnQuit }).catch((e) => {
      // The marker file IS the setting - the exit handler runs after the
      // webview is gone, so it cannot read the stored pref. If this re-sync
      // fails and the user never opens Settings, clear-on-quit stays switched
      // on in the UI and simply does not happen. There is no switch to put
      // back at boot, so it goes to the pipeline log, which is the channel
      // this app has for exactly that.
      if (boot.clearOnQuit) {
        appendLog("warn", "cache",
          `Clear cache on quit could not be armed: ${formatError(e)}. Toggle it off and on in Settings to retry.`);
      }
    });
    if (boot.cap > 0) {
      invoke<number>("enforce_media_cache_cap", {
        maxBytes: boot.cap * 1024 * 1024 * 1024,
        exclude: [],
      }).catch(() => { /* cache dir may not exist yet */ });
    }
    // appendLog deliberately NOT in the deps: it is declared far below this
    // effect, and a deps array is evaluated during render, so naming it here
    // is a temporal-dead-zone crash on boot rather than a lint nicety. tsc
    // caught it. The effect is a one-shot anyway - `boot.done` above - so
    // there is nothing for a dependency to do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // The export folder, seeded the same way and for a sharper reason: it was
  // the only setting with no default, and `canExport` requires it — so the
  // primary button in the app sat disabled on a fresh install until the user
  // went and browsed for a folder. A first export should not need a detour
  // through Settings. Only applied when nothing is stored, so Browse and the
  // Settings default keep working exactly as they did.
  useEffect(() => {
    if (exportOpts.folder) return;
    (async () => {
      try {
        const p = await invoke<string>("default_export_path");
        if (p) setExportOpts((prev) => (prev.folder ? prev : { ...prev, folder: p }));
      } catch { /* user can still pick one from Settings or Browse */ }
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
  // useCallback with NO deps. The body reads only defaultsRef.current, which is
  // the whole point of the docstring above — a stable function that always sees
  // the live setting. It was a bare arrow, harmless while it stayed inside the
  // component; as a prop to useClipExport an unstable identity would give
  // handleExport a new identity every render, and handleExport is itself a
  // dependency of the keyboard dispatch, so the window listeners would
  // re-subscribe on every render.
  const cookiesBrowserOrNone = useCallback((): string | undefined =>
    defaultsRef.current.ytCookiesBrowser && defaultsRef.current.ytCookiesBrowser !== "none"
      ? defaultsRef.current.ytCookiesBrowser
      : undefined, []);


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
  // Step two of first run. Separate flag from `welcomed` on purpose: an
  // existing install has already been welcomed and would otherwise never be
  // offered the permissions step at all.
  const [showPerms, setShowPerms] = useState<boolean>(() => {
    try { return localStorage.getItem("saucebunny.permissioned") !== "1"; } catch { return false; }
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
    // The URL is the missing half of the 403 test: yt-dlp's own message for the
    // commonest YouTube breakage names no host, so the detector could not tell
    // a stale signed URL from a genuine permissions refusal without it.
    if (!u || !looksLikeExtractorRot(msg, u)) {
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
   * mediabunny-first is the DEFAULT for everyone — the useWebCodecsDecoder
   * toggle ships on, so nobody has to opt in. It is not mandatory: turning it
   * off routes local imports through ffmpeg-prep + <video>. This comment used
   * to say the two were "independent", and they were, which left the toggle's
   * own description ("Disable if local files won't play") promising an escape
   * hatch that moved nothing but the thumbnail. Default and mandatory are not
   * the same thing. Only governs local files; the web path is untouched.
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
   * cascade produces H.264+AAC MP4, which WebCodecs decodes on every Apple
   * Silicon Mac. That sentence used to say "always", and it was false in a
   * way that made this default wrong: the download selector asked for
   * `ext=mp4`, which under yt-dlp's codec sort resolves to AV1 on YouTube
   * (measured: 397+140, av01.0.04M.08). WebCodecs in WKWebView cannot decode
   * av01, so mediabunny failed on EVERY YouTube download fallback and the app
   * logged "Cached copy failed in the mediabunny player" as though it were
   * intermittent. The selector now pins avc1 first (see download_web_preview);
   * the guarantee holds because the format request enforces it, not because
   * mp4 implied it. A background probe demotes to native in the rare case
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

  /**
   * Turn a span of transcript seconds into in/out marks.
   *
   * The arithmetic lives in lib/mark-range because every way it can be wrong
   * is silent - a truncation lands half a frame early on every mark, an
   * unclamped value marks past the end, and an inverted range fails much later
   * in the export with no obvious cause. Undoable like a mark made with I and
   * O: from the user's side it is the same act, and the only difference is
   * that they pointed at words instead of scrubbing.
   */
  const markRangeFromSeconds = useCallback((startSec: number, endSec: number) => {
    const r = markRange(startSec, endSec, fps, durationFrames);
    if (!r) return null;
    pushMarksUndo("Mark from transcript", inFrames, outFrames, r.inFrames, r.outFrames);
    setInFrames(r.inFrames);
    setOutFrames(r.outFrames);
    // RETURNED, not just set. "Add to queue" from a transcript selection runs
    // in the same tick as this, and handleAddToQueue reads inFrames/outFrames
    // out of its own closure - which still holds the PREVIOUS marks until
    // React re-renders. So it queued the last range instead of the selection.
    // Handing the range back is what lets that call site be correct.
    return r;
  }, [fps, durationFrames, inFrames, outFrames, pushMarksUndo]);

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

  // Timeline → TC fields (empty string when the mark is null).
  //
  // A field whose text ALREADY MEANS this mark is left exactly as the user
  // typed it. Rewriting it to the canonical spelling would move their cursor
  // mid-edit for nothing - "0:00:05:00" and "00:00:05:00" are the same frame -
  // and it is this write-back that used to feed the corruption loop below.
  useEffect(() => {
    setExportOpts((prev) => {
      const keep = (text: string, mark: number | null) =>
        text !== "" && mark != null && tcToFrames(text, fps) === mark;
      const nextIn  = keep(prev.inTc, inFrames)   ? prev.inTc
        : inFrames  != null ? framesToTc(inFrames, fps)  : "";
      const nextOut = keep(prev.outTc, outFrames) ? prev.outTc
        : outFrames != null ? framesToTc(outFrames, fps) : "";
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
    } else if (isCompleteTc(exportOpts.inTc, fps)) {
      const inF = tcToFrames(exportOpts.inTc, fps);
      if (inF != null && inF !== inFrames && inF >= 0 && inF <= max) setInFrames(inF);
    }
    if (exportOpts.outTc === "") {
      if (outFrames !== null) setOutFrames(null);
    } else if (isCompleteTc(exportOpts.outTc, fps)) {
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
  /**
   * Stop, as a fact about the queue RUN rather than about whatever it happens
   * to be doing this instant.
   *
   * The token above only exists while a local export is actually converting,
   * and a backend job id only exists while a child is alive. Between two queue
   * items neither is true, so Stop had nothing to look at, returned without
   * even a log line, and the run continued - with the button still enabled,
   * because `status` is "exporting" for the whole queue. This is the state the
   * button was always claiming to act on.
   */
  const queueStopRef = useRef(false);
  const queueRunningRef = useRef(false);
  queueRunningRef.current = queueRunning;
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
  /** Bumped by the Export-review command to open the drawer on Review. */
  const [reviewRequestTick, setReviewRequestTick] = useState(0);
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
  /**
   * Sits directly below `appendLog` on purpose.
   *
   * It used to live 900 lines higher, as a hoisted `function` declaration —
   * the only form that can reference a `const` declared later, because a
   * hoisted body reads it at CALL time rather than at render time. The cost
   * was a new identity every render, so the two hooks that call it could not
   * list it as a dependency without rebuilding themselves on every render,
   * and both carried a suppression saying so.
   *
   * Moving it below its one dependency removes the whole problem: it can be a
   * useCallback, its identity is stable, and both call sites name it honestly.
   */
  const invokeWithCookieRetry = useCallback(async <T,>(
    cmd: string,
    buildArgs: (cookies: string | undefined) => Record<string, unknown>,
  ): Promise<T> => {
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
  }, [appendLog, cookiesBrowserOrNone]);

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
    // A store file written by a NEWER Sauce Bunny. The store has already shut
    // its own write path; this is the half that tells the user, because the
    // alternative reading of a shelf that silently stops saving is that the
    // app is broken. Fires at most once per store, at hydration.
    const unsubFuture = onFutureStoreVersion(({ label, message }) => {
      appendLog("warn", "media", message);
      pushNotification("error", `Not saving ${label}`, message);
    });
    // The same courtesy for localStorage. Speaker renames, chapters, in/out
    // marks, source timecodes and the export queue live only there, and their
    // writer caught the quota and called console.warn - in an app with no
    // console. Past the quota everything kept working and simply stopped
    // being remembered, which the user discovers on the next launch with
    // nothing to explain it. Rate-limited in the store, since a full quota
    // fails on every keystroke that persists.
    const unsubStorage = onStorageProblem(({ key }) => {
      // No advice about clearing transcripts: they are FILES in Documents and
      // free none of this quota. Measured, the irreplaceable work here is 0.81%
      // of the 5 MiB ceiling while a regenerable poster cache was 85.6% of
      // everything stored - so the honest message names what failed and stops,
      // rather than sending someone to delete their work for nothing.
      const msg = `Ran out of room to save "${key}". Recent renames, chapters or marks may not survive a relaunch.`;
      appendLog("err", "media", msg);
      pushNotification("error", "Couldn't save your changes", msg);
    });
    return () => {
      window.removeEventListener("unhandledrejection", onRejection);
      unsubReview();
      unsubFuture();
      unsubStorage();
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
    // Same URL context as classifyExtractorRot — both paths decide the same
    // question and must not disagree about it.
    const rotUrl = activeSourceUrlRef.current;
    const rotMsg = looksLikeExtractorRot(s.message, rotUrl)
      ? s.message
      : errorDetail != null && looksLikeExtractorRot(errorDetail, rotUrl)
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
  /** Removes the grant-watch listener when the choice changes or we unmount. */
  const fdaFocusCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (defaults.ytCookiesBrowser !== "safari") {
      safariFdaPromptedRef.current = false;
      return;
    }
    if (safariFdaPromptedRef.current) return;
    safariFdaPromptedRef.current = true;
    let cancelled = false;
    void (async () => {
      const ok = await invoke<boolean>("safari_fda_status").catch(() => true);
      if (cancelled || ok) return;

      // Which OTHER browsers actually have cookies here. Safari is the only one
      // that needs Full Disk Access, so if any of these is signed in the whole
      // permission dance is avoidable — and never suggest one that is not
      // installed, which is the lesson cookie_browser_ready already encodes.
      const ready: string[] = [];
      for (const b of NO_PERMISSION_BROWSERS) {
        const has = await invoke<boolean>("cookie_browser_ready", { browser: b }).catch(() => false);
        if (has) ready.push(b);
      }
      if (cancelled) return;

      const g = safariGuidance(ready);
      pushNotification("info", g.title, g.body);
      // Only open System Settings when a permission is genuinely the answer.
      // Throwing the pane at someone we just told to switch browsers is the
      // dead end this replaces.
      if (!g.suggestsAlternative) {
        void invoke("open_full_disk_access").catch(() => { /* best-effort */ });
      }

      // CLOSE THE LOOP. Granting Full Disk Access usually means macOS quits and
      // reopens the app, but not always — if access appears while we are still
      // running, say so, rather than leaving someone to guess whether the
      // toggle took. Same focus probe the Settings pane already uses.
      const onFocus = () => {
        void invoke<boolean>("safari_fda_status").then((now) => {
          if (!now) return;
          window.removeEventListener("focus", onFocus);
          pushNotification("info", FDA_GRANTED.title, FDA_GRANTED.body);
        }).catch(() => {});
      };
      window.addEventListener("focus", onFocus);
      fdaFocusCleanupRef.current = () => window.removeEventListener("focus", onFocus);
    })();
    return () => {
      cancelled = true;
      fdaFocusCleanupRef.current?.();
      fdaFocusCleanupRef.current = null;
    };
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

  // ── Clip export listeners ─────────────────────────────────────────
  // yt-dlp/ffmpeg progress and the finished clip. Lifted whole into
  // src/hooks/use-clip-export-listeners.ts — including the queue-resolver
  // branch, which is the part that must not double-report a queued clip.
  useClipExportListeners({
    appendLog, notify, pushNotification, classifyExtractorRot,
    setStatus, setExportPhase, setResultPath, setProgress, setErrorDetail, setRecents,
    jobIdRef, fpsRef, clipJobMetaRef, queueResolverRef,
  });

  // ── Captions listeners ─────────────────────────────────────────
  // yt-dlp's caption fetch. Lifted into src/hooks/use-captions-listeners.ts —
  // see that file for why the old "cannot be lifted" note no longer holds.
  useCaptionsListeners({
    appendLog, setCaptionsState, setCaptionsError, setActiveTranscript,
    setTranscriptArrivedTick, captionsJobIdRef, clipSourceKeyRef, metadataRef,
  });

  // ── Transcription listeners ─────────────────────────────────────────
  // whisper + diarizer: logs, progress, phase, the model download, and the
  // finished transcript. Lifted whole into src/hooks/use-transcript-listeners.ts
  // — see that file for why THIS one was extractable when captions is not.
  useTranscriptListeners({
    appendLog, refreshWhisperModels, notify, pushNotification, logRunTotals,
    setTranscriptState, setTranscriptResolution, setTranscriptError,
    setTranscriptProgress, setTranscriptPhase, setActiveTranscript, setTranscriptArrivedTick,
    transcriptJobIdRef, txChannelRef, clipSourceKeyRef, localFilePathRef,
    metadataRef, stageClockRef,
  });

  // ── Playback prep and the LLM server listeners ─────────────────────
  // ffmpeg's transcode-for-playback, plus llama-server's stderr. Lifted whole
  // into src/hooks/use-playback-prep-listeners.ts.
  usePlaybackPrepListeners({
    appendLog, setPlaybackPrepProgress, playbackPrepJobIdRef, playbackPrepResolverRef,
  });


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
  /**
   * Decode entities ONCE, where scraped metadata enters.
   *
   * yt-dlp's LinkedIn/Reddit extractors scrape page HTML and hand back titles
   * with raw entities ("Tom&#39;s Big Day"). The sidebar decoded for display,
   * so the h2 read correctly while the seeded export name, the "Saves as"
   * preview and the file on disk all kept the entity - one component
   * contradicting itself about the same string. A leading entity was worse:
   * suggestFilename("&quot;Quoted&quot; Title") gave "quot;Quoted&quot;-Title",
   * because the leading-non-alphanumeric strip eats the "&" and promotes the
   * entity NAME to the first word.
   *
   * Decoding here rather than in filename.ts is deliberate. `sanitizeFilename`
   * mirrors Rust's `sanitize_filename` byte for byte, and `suggestFilename` and
   * `matchSlug` are pure node-tested modules - `decodeHtmlEntities` needs a DOM,
   * so pushing it down there would either break the mirror or drag two pure
   * modules into jsdom. At the boundary, display, filename and the stored
   * recents title all agree, which is also what keeps transcript
   * re-association (matchSlug) matching on both sides.
   */
  const decodeMetaTitle = useCallback(
    <T extends { title: string }>(m: T): T => ({ ...m, title: decodeHtmlEntities(m.title) }),
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
    // The TIMECODE STRINGS are the same marks in another representation, and
    // clearing only the frames left the previous source's in/out sitting in
    // the fields. The TC-to-frames effect keys on those strings ALONE, so it
    // could re-apply them to the new source, reinterpreted at the new fps.
    // Two mirrors of one value have to be cleared together, or the survivor
    // restores the other.
    setExportOpts((prev) => (prev.inTc === "" && prev.outTc === ""
      ? prev
      : { ...prev, inTc: "", outTc: "" }));
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
    // Settle the queue runner too, for the same reason as the two resolvers
    // above - and this one was missed. A queued WEB item's promise is resolved
    // only by `clip-done` reaching queueResolverRef, so cancelling the job it
    // was waiting on left the runner awaiting a resolver that nothing would
    // ever call: the export queue stopped, mid-run, with no error and no way
    // to restart it short of relaunching. Loading a different source while a
    // queue is running is an ordinary thing to do, and nothing prevents it.
    if (queueResolverRef.current) {
      const settle = queueResolverRef.current;
      queueResolverRef.current = null;
      settle({ success: false, error: "Cancelled - a different source was loaded" });
    }
  }, [resetWebPlayback]);

  // Moved ABOVE handleFetch deliberately. It used to sit ~1,500 lines below,
  // which meant the two hooks that call it could not name it in their
  // dependency arrays at all: a `const` referenced before its declaration is
  // a temporal-dead-zone error, and tsc rejects it. Two exhaustive-deps
  // suppressions existed only to describe that. Declaration order was the
  // whole obstacle, so the fix was to change the order.
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

  const { handleFetch } = useFetchSource({
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
  });


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

  // ── Single-clip export ──────────────────────────────────────────
  // Lifted verbatim into src/hooks/use-clip-export.ts. `runLocalClipExport` is
  // destructured back out because the queue runner below still calls it — the
  // pattern CLAUDE.md asks for, so no existing reference had to change.
  const { runLocalClipExport, handleExport } = useClipExport({
    metadata, metadataRef, sourceKind, localFilePath, exportOpts, exportOptsRef,
    fps, inFrames, outFrames, sourceSeqRef, localExportCancelRef, clipJobMetaRef,
    appendLog, notify, pushNotification, classifyExtractorRot, cookiesBrowserOrNone,
    setStatus, setProgress, setResultPath, setErrorDetail, setExportPhase,
    setJobId, setRecents,
  });

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
      const jobId = newJobId();
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

  const { loadLocalPath } = useLocalSource({
    defaults,
    sourceSeqRef,
    setMetadata,
    setLocalFilePath,
    setLocalFileSize,
    setLocalPlayer,
    setSourceKind,
    setStatus,
    setErrorDetail,
    setExportOpts,
    setInFrames,
    setOutFrames,
    setUrl,
    resetForNewSource,
    tryAutoLoadTranscript,
    recordRecentSource,
    seedFilename,
    runPlaybackPrep,
    openSourceView,
    appendLog,
  });


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
    // A running queue is stoppable even in the gap between two items, when
    // there is no token and no job id to find. Read from a ref, not the
    // closure: this callback is rebuilt on a render the queue does not wait
    // for. Set BEFORE the awaits below so the loop sees it at its next
    // boundary regardless of how long cancel_job takes to come back.
    const queueRunningNow = queueRunningRef.current;
    if (queueRunningNow) queueStopRef.current = true;
    if (ids.length === 0 && !hasLocalExport && !webDownloading && !queueRunningNow) return;
    appendLog("warn", "control",
      `Stopping ${ids.length + (hasLocalExport ? 1 : 0) + (webDownloading ? 1 : 0) + (queueRunningNow && ids.length === 0 && !hasLocalExport ? 1 : 0)} job(s)…`);
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

  // ── The clip queue ──────────────────────────────────────────────
  // Six handlers lifted verbatim into src/hooks/use-clip-queue.ts. The runner
  // takes runLocalClipExport rather than owning it: that lives in
  // useClipExport and is shared with the single Export button, which is why a
  // running single export makes the queue wait instead of starting a second
  // writer.
  const {
    handleAddToQueue, handleQueueRemove, handleQueueRetry, handleQueueRename,
    handleQueueRenameAll, handleQueueClearAll, handleQueueClearDone, handleExportQueue,
    handleQueueReorder,
  } = useClipQueue({
    metadata, metadataRef, sourceKind, localFilePath, exportOpts, fps,
    inFrames, outFrames, queueRunning, clipQueueRef, queueResolverRef,
    localExportCancelRef, queueStopRef, runLocalClipExport, appendLog, pushNotification,
    cookiesBrowserOrNone, pushMarksUndo,
    setClipQueue, setQueueOpen, setQueueRunning, setStatus, setProgress,
    setJobId, setRecents, setInFrames, setOutFrames,
  });

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
      // Straight into the managed Frames folder, no dialog. Grabbing a frame
      // is a review gesture people make many times in a session, and a save
      // dialog per grab both interrupted that and scattered the results
      // across the Desktop, Downloads and the export folder - after which
      // the app had no idea they existed and could not show them. The
      // Library's Frames shelf is where they go and where they are found;
      // the shelf's own Export verb is the way one leaves.
      const framesDir = await invoke<string>("frames_dir_path");
      await invoke("ensure_dir_exists", { path: framesDir });
      // `unique: true` on the write walks past a collision, so grabbing the
      // same frame twice yields -2 rather than silently replacing the first.
      const dest = `${framesDir}/${defaultName}`;
      const snapMime = "image/jpeg";
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
          // RAW body, not a JSON number array. The JSON route decimal-prints
          // every byte on the WKWebView main thread, so a 4K PNG snapshot
          // became a multi-megabyte string built one element at a time, with
          // the window frozen for it. Same reason the clip exporter uses
          // this path. `x-unique` walks past a collision now that the
          // destination is generated rather than confirmed by a dialog:
          // grabbing the same frame twice must yield a second file, not
          // silently replace the first.
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const written = await invoke<string>("write_raw_to_path", bytes, {
            headers: { "x-dest-path": encodeURIComponent(dest), "x-unique": "1" },
          });
          // Synthesise a result shape matching the ffmpeg path so the
          // success log + notification code below works uniformly.
          // Width/height come from probe metadata when available.
          raw = {
            path: written || dest,
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
      // Tell the Frames shelf. It re-read on window FOCUS alone, which never
      // fires for the case that actually happens: grab here, walk to Library
      // and open Frames without the window ever losing focus. The shelf stays
      // mounted behind the others, so there is no remount to save it either.
      notifyFramesChanged();
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
  }, [metadata, sourceKind, localFilePath, snapshotBusy, fps, defaults.useWebCodecsDecoder, appendLog, notify, pushNotification, invokeWithCookieRetry]);

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
  const {
    resolveTranscriptOutDir,
    handleGenerateTranscript,
    handleRediarize,
    handleFixCaptionTiming,
    handleOpenTranscriptionSettings,
    handleClearTranscript,
    loadTranscriptPath,
    handleImportTranscript,
  } = useTranscriptJobs({
    metadata,
    metadataRef,
    metadataLoading,
    sourceKind,
    localFilePath,
    localFilePathRef,
    activeSourceUrlRef,
    clipSourceKeyRef,
    fps,
    durationFrames,
    inFrames,
    outFrames,
    exportOpts,
    defaults,
    selectedModel,
    cookiesBrowserOrNone,
    activeTranscript,
    activeTranscriptRef,
    setActiveTranscript,
    transcriptState,
    setTranscriptState,
    setTranscriptError,
    setTranscriptPhase,
    setTranscriptProgress,
    setTranscriptResolution,
    setTranscriptJobId,
    setTranscriptArrivedTick,
    transcriptAbortRef,
    jobStartedRef,
    stageClockRef,
    appendLog,
    pushNotification,
    openSourceView,
    setSettingsOpen,
    setSettingsInitialTab,
  });

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
  // useCallback with NO deps: the body reads two refs and nothing else, so the
  // identity can be permanent. It used to be a bare arrow recreated every
  // render, which was invisible while it lived inside the component — but the
  // keyboard dispatch now takes it as a prop, and an unstable function there
  // would re-subscribe the window listeners on every single render.
  const readerFps = useCallback(() => readerSourceRef.current?.fps ?? fpsRef.current ?? 24, []);
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
    const jobId = newJobId();
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
    // Unconditionally, because the FILE moved whether or not history knew
    // about it. renameTranscriptEntryPath only notifies when it rewrote an
    // entry, and history holds just the transcripts opened in this app, so
    // moving any of the others left the picker showing it in the folder it
    // had just left - through the row menu as much as through a drag.
    notifyTranscriptsChanged();
  }, []);

  // THE single-clock gate (r88): exactly one media element is ever unpaused.
  // The Clip player keeps playing across views ([hidden] is display:none, audio
  // deliberately continues), so entering the reader must pause it, and leaving
  // must pause the reader player.
  useEffect(() => {
    if (activeView === "reader") { try { playerRef.current?.pause(); } catch { /* no clip player */ } }
    else { try { readerPlayerRef.current?.pause(); } catch { /* no reader player */ } }
  }, [activeView]);

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
  const diarizerPrepare = useDiarizerPrepare({
    onReady: useCallback(() => {
      setDiarizerReady(true);
      try { localStorage.setItem("saucebunny.diarizerModelsReady", "1"); } catch { /* quota */ }
    }, []),
    notify: pushNotification,
  });

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
      const id = newJobId();
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
  }, [metadata, exportOpts.folder, exportOpts.filename, defaults.transcriptionLanguage, appendLog, resolveTranscriptOutDir, cookiesBrowserOrNone]);

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
        const jobId = newJobId();
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
  }, [webStreaming, activeSourceUrl, webAudioCachedSrc, appendLog, invokeWithCookieRetry]);

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
  /**
   * The live co-review snapshot for a diagnostics report.
   *
   * Written by an effect further down (the session values are declared after
   * this point) and read, never captured, by handleExportDiagnostics. Null
   * until the first commit, which reads as "no session" - correct, because
   * there cannot be one yet.
   */
  const diagSessionRef = useRef<SessionDiagnostics | null>(null);

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
        session: diagSessionRef.current && diagSessionRef.current.role !== "off"
          ? diagSessionRef.current
          : undefined,
      });
      await invoke("write_text_to_path", { path, text: report, atomic: true });
      pushNotification("success", "Diagnostics saved", "Attach this file to a bug report.");
    } catch (err) {
      pushNotification("error", "Diagnostics export failed", formatError(err));
    }
    // Session state is read through diagSessionRef, NOT captured here.
    //
    // This closure used to read coSession/meshStates/capture/shareState
    // directly while memoised on [logs, pushNotification], so it kept whatever
    // session existed when the last log line landed. A report saved after
    // joining a room but before anything else logged recorded `role: "off"` and
    // dropped the session block entirely - a live session reporting as solo,
    // which is the exact confusion the block above exists to prevent. A
    // diagnostics file is the worst place to be quietly wrong: it gets read
    // INSTEAD of asking.
    //
    // Naming them as deps is not available: all four are declared further down
    // the component, and a deps array is evaluated during render, so it is a
    // TDZ crash rather than a lint fix. The ref is the pattern this file
    // already uses for exactly this (see defaultsRef).
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
  // ── Global keyboard dispatch ────────────────────────────────────
  // Lifted verbatim into src/hooks/use-keyboard-shortcuts.ts: 258 lines and a
  // twenty-five entry dependency array, the most tangled effect in this file.
  // Nothing in the body changed, so the diff is a move; tsc enumerated the
  // dependency surface below rather than me guessing at it.
  useKeyboardShortcuts({
    comboToAction, status, fps, readerFps, durationFrames, settingsOpen, exportOpts,
    activeViewRef, homeViewRef, libraryViewRef, clipViewRef, coreviewViewRef,
    readerViewRef, readerPlayerRef, tcEntryRef, kHeldRef,
    reviewRangeGateRef, reviewRangeKeysRef,
    onPlayToggle, shuttleStep, onMarkIn, onMarkOut, onClearMarks,
    onGotoIn, onGotoOut, onStep, onSeek, readerSeekRel,
    handlePlaybackRateStep, handlePlaybackRateChange,
    handleFetch, handleExport, handleAddToQueue,
    performUndo, performRedo, navigateView, pushNotification,
    setTcEntry, setPaletteOpen, setShortcutsOpen, setSettingsOpen, setLogsOpen,
    setQueueOpenChoice,
  });

  // ── Native menubar event wiring ─────────────────────────────────
  // The Rust shell emits `menu:<id>` when a menu item is clicked. Lifted into
  // src/hooks/use-menubar-events.ts, which is where the ten bindings are now
  // testable — menu-surface-contract proves the ids agree, not that they act.
  useMenubarEvents({
    handleImportFile, handleImportTranscript,
    transcriptLibrary: defaults.transcriptLibrary,
    pushNotification, setActiveView, setQueueOpenChoice, setSettingsOpen,
    setSettingsInitialTab, setLogsOpen, setPaletteOpen, setShortcutsOpen,
    sessionRoomRef, activeViewRef,
  });

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
    setQueueOpen: setQueueOpenChoice, setTranscriptArrivedTick, setReviewRequestTick,
    setCaptionsOn, setLogsOpen,
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
      /* receivedReviewKey FIRST. A file that arrived through a session belongs
         to that session's review, and that is a stronger statement than the
         fingerprint's "this looks like that file" - the received copy's name
         carries a <hash8>- prefix, so its fingerprint deliberately does not
         match the host's. Without this the guest's own notes read back empty. */
      ? (receivedReviewKey(localFilePath)
          ?? resolveByFingerprint(reviewFingerprint(metadata.title ?? localFilePath, metadata.duration ?? 0, metadata.width, metadata.height, localFileSize))
          ?? localFilePath)
      : (metadata?.webpage_url ?? null)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fpIndexBump tracks the localStorage index the linter can't see
    [sourceKind, localFilePath, metadata, localFileSize, fpIndexBump],
  );

  // Marks, remembered per source. The restore/save handshake lives in
  // use-source-marks - lifted out of this file because its second shipped bug
  // (re-opening a source erased its stored marks) was only provable by a test,
  // and nothing in a 6,000-line component can be tested. The hook's header
  // carries the full three-state story.
  useSourceMarks({ reviewSourceKey, durationFrames, inFrames, outFrames, setInFrames, setOutFrames });

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
      speed: defaults.transcriptionSpeed,
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
    coSession, coSessionActive, sessionDoc, postSessionOp,
    raisedHands, handRaised, sendReaction, toggleHand,
    theater, setTheater, theaterParticipants,
    meshStreams, meshStates, meshMutedForMe, toggleMuteForMe,
    shareState, shareStream, sharingMembers, startShare, stopShare,
    isPresenter, pendingSource, sourceStatus, makePresenter, adoptPendingSource,
    offeredFile, transfer, offerCurrentFile, offerError, fetchOfferedFile, watchOfferedStream, keepOfferedCopy, canKeepCopy, placeReceivedRef, cancelFetch,
    keepBadge, keepAction, onKeepCancel, onKeepResume, keepEnabled, setKeepEnabled,
    onKeepStall, onKeepStreamInfo,
    startCoReview, joinCoReview, leaveCoReview, pendingJoinCode, clearPendingJoinCode,
  } = useCoReview({
    isPlaying, fps, playbackRate,
    sessionSource, activeSourceUrlRef, reviewSourceKey,
    playerRef, metadataRef,
    onChaseSeek, setUrl, handleFetch, loadLocalPath, loadPeerStream,
    pushNotification, setQueueOpen,
    setReviewMarkers, setReviewAnnotations,
    turn: { url: defaults.turnUrl, username: defaults.turnUsername, password: defaults.turnPassword },
    stunUrl: defaults.stunUrl,
    appendLog,
  });

  /* A clicked review link takes you to the lobby, where the code is already in
     the field and Join is one press away.
     
     Gated on the welcome being closed. A link clicked on a brand-new install
     launches the app into first run, and navigating underneath would put the
     lobby's identity step behind the welcome sheet - e2e/first-run asserts
     that onboarding modals SEQUENCE rather than stack, and this is exactly the
     kind of thing that stacks them. The code is held, not dropped, so it still
     arrives once the welcome is dismissed. */
  useEffect(() => {
    if (!pendingJoinCode || showWelcome) return;
    setActiveView("coreview");
  }, [pendingJoinCode, showWelcome, setActiveView]);

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

  // Keep the diagnostics snapshot current. Deliberately runs on EVERY commit
  // with no deps array: a report is only as useful as it is current, and the
  // alternative was the stale closure this replaced. The body is a handful of
  // small maps over a roster that is single digits in practice.
  useEffect(() => {
    diagSessionRef.current = {
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
    };
  });
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
  // TWO BOUNDARIES, TWO SCOPES. This used to be one clear() on both triggers,
  // which threw away every entry the app had whenever either changed.
  //
  // A source change invalidates everything: marks are per-source, and a review
  // entry replayed against a different doc is meaningless. Clear it all.
  useEffect(() => { appUndo.clear(); }, [reviewSourceKey]);
  // Joining or leaving a session invalidates REVIEW entries only. replayOps
  // captures `inSession` when an entry is made, so a solo entry replayed in a
  // session writes the local file while peers hold the shared doc, and a
  // session entry replayed solo relays into a room. That capture is
  // protective; what was wrong is that marks, speaker overrides and queue
  // rows - pure local-state restores - went with them. Mark an in and an out,
  // join a screening, press cmd+Z, and the mark was simply gone.
  useEffect(() => { appUndo.clearScope("review"); }, [coSession.role]);
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

  /**
   * A streamable offer starts playing on its own.
   *
   * It used to sit behind a full-screen "X is watching Y. That file lives on
   * their Mac." with three buttons, so the guest had to read a paragraph and
   * make a decision before seeing anything - in a LIVE session, where the
   * whole point is that everyone is looking at the same frame right now.
   *
   * Watching is not the consequential act; COPYING is. Those were one button
   * ("Watch now … saves a copy") and are now two: the stream starts here, and
   * the multi-GB write stays a thing you ask for. Settings ▸ Co-review can
   * opt into starting it automatically, and it is off by default because
   * filling someone's disk is not a default.
   *
   * Only when the host's offer carries codec strings - there is no probe on a
   * peer route, so without them nothing can be built and the old affordances
   * are the honest fallback.
   */
  /**
   * Move a finished transfer to the folder the user chose.
   *
   * Only ever runs AFTER the bytes are verified, and only when they asked for
   * a folder: the default stays the cache, which is counted in Settings ▸ Data
   * and swept by the size cap - the right home for something you were handed
   * rather than chose.
   *
   * A failure is not fatal and must not read as one. The file is already
   * whole and already on this Mac; it just did not get moved, and saying so
   * is better than a scary error about a transfer that actually succeeded.
   */
  placeReceivedRef.current = async (path: string, name: string) => {
    if (defaults.sessionCopyDest !== "folder") return;
    const dir = defaults.sessionCopyFolder;
    if (!dir) {
      appendLog("info", "session",
        "Received files are set to go to a folder, but none is chosen yet. Kept in the cache. Settings, General, Co-review calls.");
      return;
    }
    try {
      await invoke("move_library_file", { from: path, to: `${dir.replace(/\/+$/, "")}/${name}` });
      appendLog("ok", "session", `Saved "${name}" to ${dir}.`);
    } catch (e) {
      appendLog("info", "session",
        `"${name}" arrived and is in the cache. Moving it to ${dir} did not work: ${formatError(e)}`);
    }
  };

  const autoWatchedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!offeredFile?.vcodec || !pendingSource || isPresenter) return;
    if (autoWatchedRef.current === offeredFile.blake3) return;
    autoWatchedRef.current = offeredFile.blake3;
    void watchOfferedStream({ keepCopy: defaults.autoKeepSessionCopy });
  }, [offeredFile, pendingSource, isPresenter, watchOfferedStream, defaults.autoKeepSessionCopy]);
  /** The second a pinned drawing belongs to, so the monitor can let it go
   *  once you have scrubbed away. Null = pinned with no home to leave. */
  const [annotationDisplayTime, setAnnotationDisplayTime] = useState<number | null>(null);
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
  // PEEKING AT SOMEONE ELSE'S DRAWING IS NOT A DECISION TO THROW AWAY YOUR
  // OWN. Clicking a comment's drawing badge leaves draw mode to show that
  // annotation, and that used to null the in-progress draft and wipe its undo
  // history in the same breath - a half-finished markup gone with no way back,
  // and ⌘Z afterwards falling through to the app stack and deleting the very
  // comment being looked at. The draft is set aside here instead, and comes
  // back when the pen does.
  const draftStashRef = useRef<{
    draft: AnnotationStrokes | null;
    past: (AnnotationStrokes | null)[];
    future: (AnnotationStrokes | null)[];
  } | null>(null);
  const stashDraft = useCallback(() => {
    if (reviewDraftRef.current == null && draftPastRef.current.length === 0) return;
    draftStashRef.current = {
      draft: reviewDraftRef.current,
      past: draftPastRef.current,
      future: draftFutureRef.current,
    };
    draftPastRef.current = [];
    draftFutureRef.current = [];
  }, []);
  /** Puts a stashed draft back. Returns whether there was one. */
  const restoreDraft = useCallback(() => {
    const stash = draftStashRef.current;
    if (!stash) return false;
    draftStashRef.current = null;
    draftPastRef.current = stash.past;
    draftFutureRef.current = stash.future;
    setReviewDraft(stash.draft);
    return true;
  }, []);
  /** Drops a stash for good — a new source, or a draft that got posted. */
  const dropDraftStash = useCallback(() => { draftStashRef.current = null; }, []);
  const onReviewDraftChange = useCallback((a: AnnotationStrokes) => {
    draftPastRef.current.push(reviewDraftRef.current);
    if (draftPastRef.current.length > 50) draftPastRef.current.shift();
    draftFutureRef.current = [];
    setReviewDraft(a);
  }, []);
  // Register with the keyboard dispatch (plain render-time ref assignment,
  // like sessionDocRef above): only while draw mode is live does ⌘Z route
  // here, and an exhausted history falls through to the app stack.
  // Routed while the pen is live, AND while a peek is showing - otherwise ⌘Z
  // during a peek reaches the app stack and undoes whatever came before,
  // which was usually the comment on screen.
  draftUndoRef.current = (reviewDrawActive || annotationDisplay != null)
    ? {
        undo: () => {
          // A stashed draft is the most recent thing the user lost, so it is
          // the first thing ⌘Z gives back.
          if (restoreDraft()) { setAnnotationDisplay(null); setReviewDrawActive(true); return true; }
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
  /**
   * Escape leaves drawing mode.
   *
   * The only way out was to find the pen in the composer and click it off
   * again, which is a long way to reach for "no, stop". Escape is what every
   * other mode in this app answers to, and a drawing mode that ignores it
   * traps you: the annotation toolbar covers the frame, and every click on
   * the video draws instead of doing what it usually does.
   *
   * Label mode first, then drawing: one press per layer, so Escape peels the
   * mode back rather than jumping straight out of both and losing a label you
   * were mid-way through placing.
   *
   * A capture-phase listener, so it beats the panel's own handlers, and it
   * only acts when a mode is actually on - Escape must keep doing whatever it
   * did before everywhere else.
   */
  useEffect(() => {
    if (!reviewDrawActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // A DIALOG OWNS ESCAPE WHILE IT IS OPEN.
      //
      // This listener is capture-phase on window and calls stopPropagation,
      // so without this guard it ran BEFORE any dialog's own handler and then
      // swallowed the key: open the command palette or Settings while drawing
      // is on, press Escape, and drawing mode exited while the modal stayed
      // put and never saw it. Found auditing my own change rather than by a
      // test, which is the point of the audit.
      if (document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      e.stopPropagation();
      if (reviewLabelMode) { setReviewLabelMode(false); return; }
      setReviewDrawActive(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [reviewDrawActive, reviewLabelMode]);

  useEffect(() => {
    // New source → drop any in-flight drawing + viewed annotation.
    setReviewDrawActive(false);
    setReviewLabelMode(false);
    setReviewDraft(null);
    clearDraftHistory();
    dropDraftStash();
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
  }, [reviewSourceKey, coSessionActive, clearDraftHistory, dropDraftStash]);

  // Auto-chapter markers for the timeline — same pattern as the review
  // markers above: keyed by the source, re-read on CHAPTERS_CHANGED_EVENT
  // (fired by lib/chapters saves in this window; the popped-out panel's
  // saves arrive as a panel:action:chaptersChanged → main re-dispatches the
  // same event, so this one listener covers both windows).
  // The reader's own marker data. Keyed on the source the READER is playing,
  // not the one Clip has loaded - see use-reader-markers for why the in/out
  // marks are the one field that is gated on those being the same source.
  const readerMarkers = useReaderMarkers({
    // The transcript's RECORDED source identity, not the resolved playback
    // path: that is the key chapters and review notes were written under, and
    // it exists for web transcripts too, which have no playable local file.
    readerPath: readerSourceKey,
    clipPath: sourceKind === "file" ? localFilePath : null,
    clipSourceKey: reviewSourceKey,
    inFrames, outFrames, fps,
  });

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
      onRetry: handleQueueRetry,
      // Same seam as the in-window drawer below: seconds from the transcript,
      // frames to the transport, undoable like a manual mark.
      onMarkRange: (a: number, b: number) => markRangeFromSeconds(a, b),
      onQueueRange: (a: number, b: number) => { const r = markRangeFromSeconds(a, b); if (r) handleAddToQueue(r); },
      onClearAll: handleQueueClearAll,
      onClearDone: handleQueueClearDone,
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
  const tcOverlay = tcEntry == null ? null : tcDigitsToDisplay(tcEntry);
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
              // Nothing drills in from Home any more - Home shows assets, not
              // folder cards, and a folder-name search there surfaces the
              // assets inside instead of a tile that navigates away. The
              // browser keeps the handoff props as its API (null = "All",
              // which is the right initial state regardless) for whatever
              // wants to hand it a folder next.
              selection={null}
              selectionTick={0}
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
              onImportTranscript={() => { void handleImportTranscript(); }}
              onGoToClip={handleSwitchToClip}
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
                  markIn={readerMarkers.markIn}
                  markOut={readerMarkers.markOut}
                  chapters={readerMarkers.chapters}
                  comments={readerMarkers.comments}
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

              <main className="cp-main" aria-label="Clip">
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
                  /* A bounded card, not a full-bleed cover. This used to be
                     `inset: 0` filled with --bg-0, so one sentence and a ghost
                     chip took the entire stage and read as a modal that had
                     eaten the page. The layer still spans the stage, because
                     that is what centres the card, but it is transparent and
                     pointer-transparent; only the card is either. */
                  <div className="cp-room-waiting">
                   <div className="cp-room-waiting-card">
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
                        {/* Title then reason, rather than one sentence that
                            buries the filename mid-clause. The name is the
                            thing a guest scans for, so it gets its own line and
                            its own weight. Short, because by the time anyone
                            reads this the stream has already failed to be
                            possible: the old copy explained where the file
                            lived, which is the host's business, not a thing to
                            make a guest read before they can see anything. */}
                        <span className="cp-room-waiting-title">
                          {pendingSource.title ?? (pendingSource.kind === "file" ? "A local file" : "The shared source")}
                        </span>
                        <span className="cp-room-waiting-body">
                          {pendingSource.kind === "file"
                            ? `${presenterName} is showing this, and it cannot be streamed to you.`
                            : "Loading…"}
                        </span>
                        {/* No "Watch now" button any more: a streamable offer
                            starts on its own (see the auto-watch effect), so
                            reaching this block at all means it could not be.
                            What is left are the two things that still need a
                            decision - taking their copy, or pointing at your
                            own. */}
                        <div className="cp-room-waiting-actions">
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
                        </div>
                      </>
                    )}
                   </div>
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
                    /* The copy is OPTIONAL and lives in the player's chip
                       rail beside the quality badge, not under the video and
                       not as a wall you read before you can watch. When no
                       copy is running, the chip offers to start one. */
                    streamKeepBadge={keepBadge ?? (canKeepCopy ? "Save a copy" : null)}
                    streamKeepAction={
                      keepAction ?? (canKeepCopy
                        ? { kind: "start", title: "Keep this file on your Mac. It saves while you watch, so when it finishes you can scrub the whole thing and it is yours afterwards." }
                        : null)
                    }
                    onStreamKeepAction={
                      keepAction?.kind === "resume" ? onKeepResume
                        : keepAction ? onKeepCancel
                        : keepOfferedCopy
                    }
                    onDiag={(tag, msg) => appendLog(asLogTag(tag), "seek", msg)}
                    onAudioDiag={(tag, msg) => appendLog(asLogTag(tag), "audio", msg)}
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
                          `${msg.replace("[WEBCODECS_UNSUPPORTED] ", "")}. Falling back to ffmpeg prep.`);
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
                    annotationTime={annPinned ? annotationDisplayTime : null}
                    onAnnotationDismiss={annPinned ? () => { setAnnotationDisplay(null); setAnnotationDisplayTime(null); } : undefined}
                    annotationLabelMode={annDrawing && reviewLabelMode}
                    annotationLabelColor={annLabelColor}
                    /* Reactions belong ON the picture. This used to be a
                       sibling of Monitor and Transport, and `.cp-monitor-wrap`
                       is position: static — so the absolutely-positioned layer
                       resolved against an ancestor spanning the whole column
                       and a clap surfaced over the timecode field instead of
                       over the video. */
                    stageOverlay={roomActive ? <ReactionLayer /> : null}
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
                    // Only the queued clips that belong to THIS source; see
                    // lib/queue-ranges.ts for why drawing the rest is worse
                    // than untidy.
                    //
                    // AND NONE OF THEM DURING A SCREENING. A queued clip is
                    // this machine's export plan - private working state that
                    // says nothing to the person on the other end - and the
                    // session's timeline is a shared reading surface where the
                    // marks that mean something are the comment dots and their
                    // spans. Drawing an export queue across it puts a second
                    // set of bands on the one track both people are pointing
                    // at, in colours that mean nothing to the guest.
                    //
                    // The queue was never SENT: SessionMsg carries comments,
                    // presence, transport, sharing and reactions, and has no
                    // marks or queue variant at all. This is about what the
                    // host is looking at, not about what leaves the Mac.
                    queuedRanges={coSessionActive ? [] : queuedRangesForSource(
                      clipQueue,
                      currentQueueSource(sourceKind, localFilePath, metadata?.webpage_url),
                    ).map((c) => ({
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
                onRetry={handleQueueRetry}
                reviewRequestTick={reviewRequestTick}
                onMarkRange={markRangeFromSeconds}
                onQueueRange={(a, b) => { const r = markRangeFromSeconds(a, b); if (r) handleAddToQueue(r); }}
                onClearAll={handleQueueClearAll}
                onClearDone={handleQueueClearDone}
                onExportAll={handleExportQueue}
                onStop={handleStop}
                onRenameClip={handleQueueRename}
                onReorderQueue={handleQueueReorder}
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
                  // Read the flag rather than the updater's argument: the
                  // branches below have real side effects, and a state updater
                  // must stay pure enough to run twice.
                  if (reviewDrawActive) {
                    // Putting the pen down is a decision to discard, so this
                    // one really does drop the draft - and the stash with it.
                    setReviewDraft(null); clearDraftHistory(); dropDraftStash();
                    setReviewDrawActive(false);
                  } else {
                    // Turning the pen ON pauses. Drawing over a still-playing
                    // video means the frame moves out from under the stroke
                    // while it is being made, so the mark ends up describing a
                    // frame nobody chose. The composer latches its anchor time
                    // on the same edge, so the note and the drawing agree.
                    playerRef.current?.pause();
                    restoreDraft();
                    setReviewDrawActive(true);
                  }
                }}
                reviewLabelActive={reviewLabelMode}
                onToggleReviewLabel={() => {
                  setAnnotationDisplay(null);
                  // Label click enters draw mode if needed; inside draw mode it
                  // toggles between the label tool and the pen.
                  // Pauses on the same edge the pen does. ReviewPanel latches
                  // the comment's timestamp on the drawActive edge either way,
                  // so entering annotation by the LABEL tool used to latch a
                  // time under a frame that was still moving.
                  if (!reviewDrawActive) {
                    playerRef.current?.pause();
                    setReviewDrawActive(true); setReviewLabelMode(true); return;
                  }
                  setReviewLabelMode((v) => !v);
                }}
                onReviewDraftConsumed={() => { setReviewDraft(null); clearDraftHistory(); dropDraftStash(); setReviewDrawActive(false); setReviewLabelMode(false); }}
                /* Set the draft ASIDE rather than dropping it - see stashDraft.
                   Looking at what someone else drew is not a decision to throw
                   away what you were drawing. */
                onShowAnnotation={(a, color, time) => { stashDraft(); setReviewDrawActive(false); setReviewLabelMode(false); setReviewDraft(null); setAnnotationDisplay(a); setAnnotationDisplayColor(color ?? null); setAnnotationDisplayTime(time ?? null); }}
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
              onJoin={joinCoReview}
              onLeave={leaveCoReview}
              initialCode={pendingJoinCode}
              onInitialCodeUsed={clearPendingJoinCode}
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
        diarizerPrepareState={diarizerPrepare.state}
        diarizerPrepareError={diarizerPrepare.error}
        onPrepareDiarizerModels={diarizerPrepare.prepare}
        onCancelDiarizerPrepare={diarizerPrepare.cancel}
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

      {/* Never open at the same time as the welcome screen. On a true first
          run both gates fire - they latch on independent flags - and the
          welcome painted over this one at z-index 300. Two aria-modal dialogs
          were open at once, and both bind Escape in the CAPTURE phase, so the
          first Escape of a user's life closed the modal they could not see and
          left up the one they could; this one's latch then meant the connect
          prompt never came back. Sequenced instead: welcome first, this after. */}
      <YouTubeAuthModal
        open={ytAuthOpen && !showWelcome && !showPerms}
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
      {/* SEQUENCED, not stacked: the welcome must be gone first. Both sit on
          --z-firstrun, so rendering them together would paint one over the
          other and trap focus in whichever mounted last. */}
      {!showWelcome && showPerms && (
        <PermissionsOnboarding onDone={() => {
          try { localStorage.setItem("saucebunny.permissioned", "1"); } catch { /* quota */ }
          setShowPerms(false);
        }} />
      )}
    </div>
  );
}
