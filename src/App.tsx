import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { Toolbar } from "./components/Toolbar";
import { Sidebar } from "./components/Sidebar";
import { Monitor, type AspectId } from "./components/Monitor";
import type { Notif } from "./components/NotificationBell";
import type { ToastKind } from "./components/CanvasToast";
import { playSuccess, playError, playInfo } from "./lib/sound";
import { Transport } from "./components/Transport";
import { Timeline } from "./components/Timeline";
import { ViewOptions } from "./components/ViewOptions";
import { LogsPanel } from "./components/LogsPanel";
import { SettingsModal, type Defaults } from "./components/SettingsModal";
import { YouTubeAuthModal } from "./components/YouTubeAuthModal";
import type { PlayerHandle } from "./components/player-handle";
import type {
  AppStatus, ClientLog, DoneEvent, ExportOpts,
  LocalFileMeta, LogEvent, Metadata, ProgressEvent, QueuedClip, RecentClip,
  SourceKind, WhisperModel,
} from "./types";
import { asLogTag } from "./types";
import { formatError } from "./lib/error-format";
import { usePanelBus } from "./hooks/use-panel-bus";
import { QueueDrawer } from "./components/QueueDrawer";
import { CommandPalette } from "./components/CommandPalette";
import {
  recordTranscript,
  findForSource,
  touchEntry,
  type TranscriptHistoryEntry,
} from "./lib/transcript-history";
import type { Command } from "./lib/commands";
import { buildCommands } from "./lib/commands";
import { migrateLegacyStorageKeys } from "./lib/migrate-storage";
import { loadJson, saveJson } from "./lib/storage";
import {
  durationToTc, framesToTc, secondsToTc,
  tcToFrames, tcToSeconds,
} from "./lib/timecode";
import { isLikelyVideoUrl, normalizeUrl, hostnameOf, youTubeThumbnailUrl, isYouTubeBotError } from "./lib/validation";
import { buildProxyUrl } from "./lib/stream-proxy";
import { sanitizeFilename, stripExt, suggestFilename } from "./lib/filename";
import { EXPECTED_BACKEND_BUILD_ID, type BuildIdCheck } from "./lib/build-id";
import { extractFrameAsBlob } from "./lib/mediabunny-helpers";
import { exportLocalClipViaMediabunny } from "./lib/mediabunny-export";
import { extractAudioAsWav16k } from "./lib/mediabunny-audio";

const DEFAULT_FPS_FALLBACK: Record<string, number> = { "24": 24, "25": 25, "30": 30 };

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

// v2 bump: re-encode default flipped from ON to OFF. Older v1 settings are
// intentionally abandoned so users get the new, much faster default.
const DEFAULTS_KEY  = "cp-defaults-v2";
const RECENTS_KEY   = "cp-recents";
const ASPECT_KEY    = "cp-aspect";

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
      whisperModel: stored.whisperModel ?? "base.en",
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
      // 0 = auto. Other values pass through as --num-speakers to the
      // Swift sidecar; pyannote clustering then skips estimation.
      expectedSpeakers: stored.expectedSpeakers ?? 0,
      // Empty string here = "ask backend for the default and persist
      // it on first app boot." See the resolver effect just below.
      transcriptLibrary: stored.transcriptLibrary ?? "",
    };
  });
  const setDefaults = useCallback((d: Defaults) => {
    setDefaultsState(d);
    saveJson(DEFAULTS_KEY, d);
  }, []);

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
        if (p) setDefaults({ ...defaults, transcriptLibrary: p });
      } catch { /* user can still set it manually from Settings */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // r72: one-shot — flip existing installs onto the hybrid (stream-first)
  // default, even if they saved the old download-first value. Latches so the
  // user's own Web-playback toggle is respected afterward.
  useEffect(() => {
    if (defaults.hybridMigrated) return;
    setDefaults({ ...defaults, streamPreview: true, hybridMigrated: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fallbackFps = DEFAULT_FPS_FALLBACK[defaults.timecode] ?? 24;

  /**
   * Returns the configured cookies-browser identifier, or undefined when
   * the user has it disabled. Threaded into every yt-dlp invoke so we
   * authenticate consistently across fetch / clip / captions / snapshot
   * / transcript. Backend treats undefined / "none" identically.
   */
  const cookiesBrowserOrNone = (): string | undefined =>
    defaults.ytCookiesBrowser && defaults.ytCookiesBrowser !== "none"
      ? defaults.ytCookiesBrowser
      : undefined;

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
  const [ytAuthMode, setYtAuthMode] = useState<"welcome" | "blocked" | "severed">("blocked");
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
    if (!isYouTubeBotError(msg)) return;
    if (ytAuthPromptedSeqRef.current === seq) return; // one prompt per source load
    ytAuthPromptedSeqRef.current = seq;
    // Already picked a browser but STILL bot-checked = the sign-in got severed.
    setYtAuthMode(defaults.ytCookiesBrowser !== "none" ? "severed" : "blocked");
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

  // ====== URL bar ======
  const [url, setUrl] = useState("");

  // ====== Metadata + status ======
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [status, setStatus] = useState<AppStatus>("empty");
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  // YouTube source vs imported local file. Most paths key off this.
  const [sourceKind, setSourceKind] = useState<SourceKind>("youtube");
  const [localFilePath, setLocalFilePath] = useState<string | null>(null);
  /**
   * Path of the ffmpeg-normalised playback copy (WKWebView-compatible MP4 /
   * MP3). When set, the LocalMediaPlayer uses this; otherwise it falls back
   * to the original `localFilePath`. The original is always what we hand to
   * `transcribe_local_file` / export pipelines.
   */
  const [playbackPath, setPlaybackPath] = useState<string | null>(null);
  /**
   * For non-YouTube web sources (Vimeo, TikTok, Twitter/X, etc.): the
   * signed direct-stream URL yt-dlp resolved via `-g`. We hand this
   * straight to <video src> — Safari does range-fetch to the CDN itself,
   * no download wait, no disk usage. Null for YouTube (uses IFrame) and
   * for local files.
   */
  const [webStreamUrl, setWebStreamUrl] = useState<string | null>(null);
  /**
   * Per-import fallback for web sources whose CDN rejects cross-origin
   * fetches (LinkedIn, X, Instagram, FB — most major social platforms
   * check the Referer header). When `<video>` errors trying to load
   * `webStreamUrl`, we download via yt-dlp into the app cache and swap
   * the player to this local path. Cleared by resetForNewSource.
   */
  const [webCachePath, setWebCachePath] = useState<string | null>(null);
  /** True while the web-preview download is in flight. */
  const [webPreviewDownloading, setWebPreviewDownloading] = useState(false);
  /** True once the active player has reported ready (loadedmetadata /
   *  SourceBuffer open). Drives the r62 "resolving / starting playback"
   *  overlay so the user sees a clear status over the poster during the
   *  yt-dlp resolve + MSE buffer window. Reset on every new source. */
  const [playerReady, setPlayerReady] = useState(false);
  /**
   * Watchdog timer ID for the direct-stream load. Many social-CDN 403s
   * never surface as <video> error events — Safari just stalls silently.
   * We start this timer when we mount a web stream and clear it when
   * onPlayerReady fires. If it expires, we trigger the download fallback
   * the same way an explicit error would.
   */
  const webStreamWatchdogRef = useRef<number | null>(null);
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

  // Effective fps and duration in frames.
  const fps = metadata?.fps && metadata.fps > 0 ? metadata.fps : fallbackFps;
  const durationFrames = useMemo(
    () => metadata?.duration != null ? Math.floor(metadata.duration * Math.max(1, Math.round(fps))) : 0,
    [metadata, fps]
  );
  const durationTc = useMemo(() => durationToTc(metadata?.duration ?? 0, fps), [metadata, fps]);

  // ====== Playback (driven by YouTube player when available) ======
  const playerRef = useRef<PlayerHandle>(null);
  const [playheadFrames, setPlayheadFrames] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  // ====== In/out + export form ======
  // null = mark not set. With both null the export is the full clip
  // (no --download-sections passed to yt-dlp) — fastest path for "just give
  // me the mp3" workflows.
  const [inFrames, setInFrames] = useState<number | null>(null);
  const [outFrames, setOutFrames] = useState<number | null>(null);

  const [exportOpts, setExportOpts] = useState<ExportOpts>(() => ({
    inTc: "",
    outTc: "",
    filename: "clip",
    folder: defaults.folder,
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

  // ====== Captions / transcript ======
  const [captionsJobId, setCaptionsJobId] = useState<string | null>(null);
  const [captionsState, setCaptionsState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [captionsError, setCaptionsError] = useState<string | null>(null);

  // ====== Whisper transcript ======
  const [transcriptJobId, setTranscriptJobId] = useState<string | null>(null);
  const [transcriptState, setTranscriptState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [transcriptProgress, setTranscriptProgress] = useState(0);
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

  // ====== Aspect crop guide + captions display ======
  const [aspect, setAspect] = useState<AspectId>(() => loadJson<AspectId>(ASPECT_KEY, "off"));
  useEffect(() => saveJson(ASPECT_KEY, aspect), [aspect]);
  const [captionsOn, setCaptionsOn] = useState<boolean>(() => loadJson<boolean>("cp-captions-on", false));
  useEffect(() => saveJson("cp-captions-on", captionsOn), [captionsOn]);

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

  // ====== Command palette (⌘K) ======
  const [paletteOpen, setPaletteOpen] = useState(false);

  // ====== Settings modal ======
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<"general" | "transcription" | "shortcuts" | "commands" | "about">("general");

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

  // ====== Backend build ID handshake ======
  // Persistent banner state when the running Rust binary doesn't match the
  // frontend's expectations (i.e. the user changed Rust code but didn't
  // restart the dev server). null = healthy / not yet checked.
  const [buildCheck, setBuildCheck] = useState<BuildIdCheck | null>(null);

  // ====== In-app notifications + canvas toast ======
  // The notification bell holds a session history of completion events; the
  // toast is the transient confirmation that pops over the canvas.
  const [notifications, setNotifications] = useState<Notif[]>([]);
  const [toast, setToast] = useState<{ kind: ToastKind; title: string; body?: string } | null>(null);

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
      setToast({ kind, title, body });
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
  const appendLog = useCallback((tag: ClientLog["tag"], source: string, message: string) => {
    logIdRef.current += 1;
    setLogs((prev) => [...prev, { id: logIdRef.current, ts: nowHms(), tag, source, message }]);
  }, []);

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
          setResultPath(e.payload.path);
          setProgress(0);
          const filename = e.payload.path.split("/").pop() ?? "Done.";
          pushNotification("success", "Clip exported", filename, e.payload.path);
          notify("Clip exported", filename);
          const m = metadataRef.current;
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
          setErrorDetail(null);
          setProgress(0);
          appendLog("warn", "ffmpeg", "Export cancelled");
          pushNotification("info", "Export cancelled", "");
        } else {
          setStatus("error");
          setErrorDetail(e.payload.error ?? "Export failed");
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
          invoke("reveal_in_finder", { path: e.payload.path }).catch(() => { /* ignore */ });
        } else {
          setCaptionsState("error");
          const msg = e.payload.error ?? "Caption download failed";
          setCaptionsError(msg);
          appendLog("err", "captions", msg);
        }
      });
      const g = await listen<LogEvent>("transcript-log", (e) => {
        if (!mounted || e.payload.job_id !== transcriptJobIdRef.current) return;
        appendLog(asLogTag(e.payload.tag), "whisper", e.payload.line);
      });
      const h = await listen<DoneEvent>("transcript-done", (e) => {
        if (!mounted || e.payload.job_id !== transcriptJobIdRef.current) return;
        if (e.payload.success && e.payload.path) {
          setTranscriptState("done");
          setTranscriptError(null);
          setTranscriptProgress(100);
          setTranscriptPhase(null);
          const filename = e.payload.path.split("/").pop() ?? "Whisper finished.";
          appendLog("ok", "whisper", `Transcript saved → ${e.payload.path}`);
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
        } else if (e.payload.error === "Cancelled" || e.payload.error?.startsWith("whisper-cli exited with code")) {
          // Whisper exits non-zero when killed via SIGTERM — treat as cancel.
          setTranscriptState("idle");
          setTranscriptError(null);
          setTranscriptProgress(0);
          setTranscriptPhase(null);
          appendLog("warn", "whisper", "Transcription cancelled");
        } else {
          setTranscriptState("error");
          setTranscriptPhase(null);
          const msg = e.payload.error ?? "Whisper transcription failed";
          setTranscriptError(msg);
          appendLog("err", "whisper", msg);
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
    // appendLog / refreshWhisperModels / notify are all stable (empty deps),
    // so this effect runs exactly once for the app's lifetime.
  }, [appendLog, refreshWhisperModels, notify, pushNotification]);

  // ====== Player callbacks ======
  // Sync our playhead from the YouTube player's current time while it's playing.
  const onPlayerTimeUpdate = useCallback((seconds: number) => {
    const r = Math.max(1, Math.round(fps));
    setPlayheadFrames(Math.floor(seconds * r));
  }, [fps]);

  const onPlayerStateChange = useCallback((playing: boolean) => {
    setIsPlaying(playing);
  }, []);

  const onPlayerReady = useCallback((dur: number) => {
    // Player loaded metadata successfully — disarm the web-stream stall
    // watchdog so we don't trigger an unnecessary download fallback.
    if (webStreamWatchdogRef.current != null) {
      window.clearTimeout(webStreamWatchdogRef.current);
      webStreamWatchdogRef.current = null;
    }
    // Player is up → drop the resolving/buffering overlay (r62).
    setPlayerReady(true);
    // Apply persisted volume + mute as soon as a player becomes ready.
    const p = playerRef.current;
    if (p) {
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
  }, [volume, muted]);

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
    setMetadata(null);
    setErrorDetail(null);
    setLogs([]);
    setResultPath(null);
    setProgress(0);
    setCaptionsState("idle");
    setCaptionsError(null);
    setTranscriptState("idle");
    setTranscriptError(null);
    setTranscriptProgress(0);
    setTranscriptPhase(null);
    // Drop the previous video's transcript so the Transcript tab doesn't
    // show stale captions over a different source. The next successful
    // generate/download repopulates it (and bumps arrivedTick to switch
    // the tab back into view).
    setActiveTranscript(null);
    setMetadataLoading(false);
    setPlayheadFrames(0);
    setInFrames(null);
    setOutFrames(null);
    setIsPlaying(false);
    setSourceKind("youtube");
    setLocalFilePath(null);
    setPlaybackPath(null);
    setPlaybackPrepBusy(false);
    setPlaybackPrepJobId(null);
    setPlaybackPrepProgress(0);
    setWebCodecsFallbackForImport(false);
    setWebStreamUrl(null);
    setWebCachePath(null);
    setWebPreviewDownloading(false);
    setPlayerReady(false);
    if (webStreamWatchdogRef.current != null) {
      window.clearTimeout(webStreamWatchdogRef.current);
      webStreamWatchdogRef.current = null;
    }
    // Cancel any in-flight mediabunny local export tied to the previous
    // source — without this, switching sources mid-export would leave
    // the Conversion writing into a buffer for a file the user no
    // longer cares about (and the success notification would surface
    // against the wrong source).
    if (localExportCancelRef.current) {
      localExportCancelRef.current.cancelled = true;
      localExportCancelRef.current = null;
    }
  }, []);

  const handleFetch = useCallback(async (urlOverride?: string) => {
    // `urlOverride` lets callers (e.g. paste-and-fetch) pass the URL directly
    // instead of relying on the `url` state having committed — avoids the
    // race where a freshly-pasted URL hasn't landed in state yet.
    const full = normalizeUrl(urlOverride ?? url);
    if (!isLikelyVideoUrl(full)) {
      setErrorDetail("Paste a video URL (YouTube, Vimeo, TikTok, Twitter/X, Reddit, Instagram, or any page with embedded video).");
      setStatus("error");
      return;
    }
    resetForNewSource();
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
    setPlayheadFrames(0);
    setInFrames(null);
    setOutFrames(null);
    // Auto-load any previously-generated transcript for this URL.
    // No await — runs in the background; if found, the Transcript tab
    // pulses + auto-opens via the standard arrivedTick flow.
    void tryAutoLoadTranscript({ sourceUrl: full });
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
    // ─── Web-source playback path (r72: HYBRID, stream-first by default) ──
    // Stream instantly so the user can WATCH and mark in/out without waiting
    // for a full download (critical on long videos). Export then downloads
    // ONLY the marked clip (create_clip's section download). If streaming
    // fails at any point, onMediaError / the watchdog fall back to the
    // reliable download-to-cache path — so it's fast when it works, reliable
    // when it doesn't. Turn `streamPreview` OFF (Settings → Web playback) for
    // the download-first path (slower, max reliability on flaky connections).
    if (defaults.streamPreview) {
      // ── STREAM-FIRST (default): MSE via the loopback proxy, download fallback. ──
      void (async () => {
        try {
          appendLog("info", "yt-dlp", `Resolving stream URL for ${hostnameOf(full)}…`);
          const stream = await invoke<{ url: string; width: number | null; height: number | null; vcodec: string | null }>(
            "get_direct_stream_url",
            { url: full, cookiesBrowser: cookiesBrowserOrNone() },
          );
          if (sourceSeqRef.current !== seq) return;
          // base is null only if the proxy failed to bind at startup — then
          // we hand the raw CDN URL through (won't play; watchdog → download).
          const proxyBase = await invoke<string | null>("get_stream_proxy_base").catch(() => null);
          if (sourceSeqRef.current !== seq) return;
          const proxied = buildProxyUrl(proxyBase, stream.url);
          setWebStreamUrl(proxied);
          appendLog("ok", "yt-dlp",
            `Direct stream ready · ${stream.width ?? "?"}×${stream.height ?? "?"} ${stream.vcodec ?? ""} · via 127.0.0.1 proxy`.trim());
          // r74: be explicit that PLAYBACK is a low-res proxy (YouTube only
          // serves a muxed stream at ≤360p; higher res is VP9/AV1 DASH that
          // WKWebView can't decode). This keeps scrubbing fast and light. The
          // EXPORT pulls the user's selected quality (up to the source 4K) via
          // its own yt-dlp call, so clip quality is unaffected.
          if ((stream.height ?? 0) > 0 && (stream.height ?? 0) <= 480) {
            appendLog("info", "media",
              `Preview is ${stream.height}p for instant scrubbing — your export downloads full quality (up to the source resolution).`);
          }
          // Stall watchdog: if the proxy/MSE pipeline doesn't open in 15s,
          // fall back to the reliable download path.
          if (webStreamWatchdogRef.current != null) window.clearTimeout(webStreamWatchdogRef.current);
          webStreamWatchdogRef.current = window.setTimeout(() => {
            webStreamWatchdogRef.current = null;
            if (sourceSeqRef.current !== seq) return;
            if (webCachePath || webPreviewDownloading) return;
            appendLog("warn", "media", "Stream didn't open in 15s — falling back to download.");
            pushNotification("info", "Downloading preview…",
              "Fetching the file via yt-dlp so you can scrub and mark in-app.");
            void runWebPreviewDownload(full, seq);
          }, 15000);
        } catch (err) {
          if (sourceSeqRef.current !== seq) return;
          const sErr = formatError(err);
          appendLog("warn", "yt-dlp", `Direct stream failed: ${sErr} — falling back to download.`);
          maybePromptYtAuth(sErr, seq);
          void runWebPreviewDownload(full, seq);
        }
      })();
    } else {
      // ── DOWNLOAD-FIRST (default, reliable): fetch the file to cache, then
      //    LocalMediaPlayer plays it natively. Failures (e.g. YouTube bot-
      //    check) surface as a clean "download failed" + the auth modal,
      //    not a broken player. ──
      appendLog("info", "yt-dlp", `Downloading ${hostnameOf(full)} for in-app playback…`);
      void runWebPreviewDownload(full, seq);
    }

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
      // Don't blow the canvas away — the direct-stream path is independent
      // of metadata. Just record the error so the sidebar/notification surfaces it.
      setErrorDetail(msg);
      pushNotification("error", "Metadata fetch failed",
        "The player is still active, but export quality options may be limited until metadata loads.");
      maybePromptYtAuth(msg, seq);
    } finally {
      if (sourceSeqRef.current === seq) setMetadataLoading(false);
    }
  }, [url, appendLog, defaults, fallbackFps, resetForNewSource, pushNotification, maybePromptYtAuth]);

  // Re-run the current fetch after the user picks a browser in the YouTube
  // auth modal. By the time this fires, `defaults.ytCookiesBrowser` (and thus
  // a freshly-rebuilt handleFetch) already reflect the choice.
  useEffect(() => {
    if (ytAuthRetry === 0) return;
    void handleFetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ytAuthRetry]);

  const handleExport = useCallback(async () => {
    if (!metadata || !exportOpts.folder) return;

    // ─── Local-file branch ──────────────────────────────────────────
    // Drive the clip via mediabunny's Conversion API (demux + stream-
    // copy or WebCodecs re-encode, no ffmpeg subprocess). MP3 audio
    // export still rides the ffmpeg path because mediabunny needs the
    // @mediabunny/mp3-encoder extension and we haven't installed it yet.
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
      // Pick container + extension based on the user's format selection.
      // Mp3 path goes through Mp3OutputFormat (mediabunny's mp3-encoder
      // extension is registered at app startup in main.tsx). Everything
      // else writes MP4 — Mediabunny's Conversion handles passthrough
      // vs. re-encode internally based on codec compatibility.
      const isAudioOnly = exportOpts.format === "audio";
      const exportFormat: "video-mp4" | "audio-mp3" = isAudioOnly ? "audio-mp3" : "video-mp4";
      const ext = isAudioOnly ? "mp3" : "mp4";
      const destPath = `${exportOpts.folder}/${safe}.${ext}`;

      setErrorDetail(null);
      setResultPath(null);
      setProgress(0);
      setStatus("exporting");
      appendLog("info", "mediabunny",
        `Exporting local clip ${startSec != null && endSec != null ? `${startSec.toFixed(2)}s → ${endSec.toFixed(2)}s` : "full"} → ${destPath}`);

      const cancelToken = { cancelled: false };
      localExportCancelRef.current = cancelToken;
      try {
        const result = await exportLocalClipViaMediabunny({
          inputPath: localFilePath,
          startSeconds: startSec,
          endSeconds: endSec,
          format: exportFormat,
          onProgress: (p) => setProgress(p * 100),
        }, cancelToken);

        if (result.kind === "cancelled") {
          setStatus("loaded");
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
          setErrorDetail(result.reason);
          pushNotification("error", "Local export not supported",
            "This file's codecs aren't compatible with the in-browser exporter yet. ffmpeg fallback for local clips is on the roadmap.");
          return;
        }
        if (result.kind === "error") {
          throw new Error(result.message);
        }

        // Persist via the small bytes-writer command we already have.
        // For >50MB clips this is a one-shot invoke; large but works.
        await invoke("write_bytes_to_path", {
          path: destPath,
          bytes: Array.from(result.bytes),
        });

        setStatus("loaded");
        setResultPath(destPath);
        setProgress(0);
        const filename = destPath.split("/").pop() ?? "Done.";
        appendLog("ok", "mediabunny",
          `Wrote ${(result.bytes.byteLength / 1_000_000).toFixed(1)} MB → ${destPath}`);
        pushNotification("success", "Clip exported", filename, destPath);
        notify("Clip exported", filename);

        // Add to recents.
        const m = metadataRef.current;
        if (m) {
          const dur = (endSec != null && startSec != null)
            ? secondsToTc(endSec - startSec, fps)
            : (m.duration != null ? secondsToTc(m.duration, fps) : "Full");
          const r: RecentClip = {
            id: Math.random().toString(36).slice(2),
            title: m.title,
            path: destPath,
            dur,
            when: Date.now(),
            thumbnail: m.thumbnail,
          };
          setRecents((prev) => [r, ...prev].slice(0, 6));
        }
      } catch (err) {
        // formatError handles Error / AppError / string — `err instanceof Error`
        // alone misses the r51 discriminated-union shape.
        const msg = formatError(err);
        setErrorDetail(msg);
        appendLog("err", "mediabunny", msg);
        setStatus("error");
        pushNotification("error", "Local export failed", msg);
      } finally {
        localExportCancelRef.current = null;
      }
      return;
    }

    setErrorDetail(null);
    setResultPath(null);
    setProgress(0);
    setStatus("exporting");
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
      // Marks may be null (full-clip export) — pass null through, the
      // backend skips --download-sections so yt-dlp just grabs the whole stream.
      const startStr = inFrames  != null ? framesToTc(inFrames,  fps) : null;
      const endStr   = outFrames != null ? framesToTc(outFrames, fps) : null;
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
      appendLog("err", "ffmpeg", msg);
      setStatus("error");
    }
  }, [metadata, sourceKind, exportOpts, fps, inFrames, outFrames, appendLog, pushNotification]);

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

  /**
   * Web-source fallback: when LocalMediaPlayer fails to load a Referer-
   * gated CDN URL (LinkedIn licdn, X twimg, IG cdninstagram, FB fbcdn —
   * all 403 cross-origin requests), download the file via yt-dlp into
   * the app cache and swap the player to the local asset:// URL. Reuses
   * the playback-prep event channels for progress/done so the pipeline
   * UI lights up the same way as a local-file ffmpeg prep.
   */
  const runWebPreviewDownload = useCallback(async (url: string, seq: number) => {
    if (webPreviewDownloading) return;
    try {
      setWebPreviewDownloading(true);
      setPlaybackPrepBusy(true);
      setPlaybackPrepProgress(0);
      const jobId = await invoke<string>("new_job_id");
      setPlaybackPrepJobId(jobId);
      appendLog("info", "web-preview", "CDN rejected cross-origin fetch — downloading via yt-dlp…");
      const cachePath = await new Promise<string>((resolve, reject) => {
        playbackPrepResolverRef.current = { resolve, reject };
        invoke("download_web_preview", {
          args: {
            url,
            job_id: jobId,
            cookies_browser: cookiesBrowserOrNone(),
          },
        }).catch((err) => {
          if (playbackPrepResolverRef.current) {
            playbackPrepResolverRef.current = null;
            reject(err);
          }
        });
      });
      if (sourceSeqRef.current !== seq) return;
      setWebCachePath(cachePath);
      appendLog("ok", "web-preview", `Cached preview ready → ${cachePath}`);
    } catch (err) {
      if (sourceSeqRef.current !== seq) return;
      const msg = formatError(err);
      if (msg.includes("Source changed")) return;
      if (msg.includes("Cancelled")) {
        appendLog("warn", "web-preview", "Preview download cancelled");
      } else {
        appendLog("err", "web-preview", `Preview download failed: ${msg}`);
        pushNotification("error", "Preview unavailable", msg);
        maybePromptYtAuth(msg, seq);
      }
    } finally {
      if (sourceSeqRef.current === seq) {
        setWebPreviewDownloading(false);
        setPlaybackPrepBusy(false);
        setPlaybackPrepJobId(null);
        setPlaybackPrepProgress(0);
      }
    }
  }, [webPreviewDownloading, appendLog, pushNotification, maybePromptYtAuth]);

  const handleImportFile = useCallback(async () => {
    try {
      const picked = await import("@tauri-apps/plugin-dialog").then((m) =>
        m.open({
          multiple: false,
          directory: false,
          filters: [
            { name: "Video", extensions: ["mp4", "mov", "m4v", "mkv", "webm", "avi"] },
            { name: "Audio", extensions: ["mp3", "m4a", "wav", "flac", "ogg", "aac"] },
            { name: "All", extensions: ["*"] },
          ],
        })
      );
      if (typeof picked !== "string") return;

      resetForNewSource();
      const seq = ++sourceSeqRef.current;
      setStatus("fetching");
      appendLog("info", "import", `Probing local file: ${picked}`);

      const lf = await invoke<LocalFileMeta>("probe_local_file", { path: picked });
      if (sourceSeqRef.current !== seq) return;

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
      //   1. extractFrameAsBlob → object URL → set as data thumbnail
      //   2. generate_local_thumbnail (ffmpeg) → asset:// URL (legacy
      //      fallback for codecs WebCodecs can't decode). Has its own
      //      hash-based cache so re-imports stay instant.
      if (lf.has_video) {
        (async () => {
          const thumbTime = lf.duration ? Math.min(5, lf.duration * 0.1) : 0;
          try {
            // Step 1: try mediabunny if the user has it enabled.
            const blob = defaults.useWebCodecsDecoder
              ? await extractFrameAsBlob(lf.path, thumbTime, { maxWidth: 640, mimeType: "image/jpeg", quality: 0.85 })
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
              args: { input_path: lf.path, duration_seconds: lf.duration },
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
      setUrl("");
      setPlayheadFrames(0);
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
      // path. Silent miss — first-time imports proceed normally.
      void tryAutoLoadTranscript({ sourcePath: picked });
      setStatus("loaded");

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
      // Conservative ruleset that holds on every supported Mac:
      //   h264 video + (aac | mp3 | no audio)  →  NATIVE (zero prep)
      //   everything else                       →  TRANSCODE
      //
      // Audio-only files with mp3/aac → native. opus/flac/etc → transcode.
      const vc = (lf.vcodec ?? "").toLowerCase();
      const ac = (lf.acodec ?? "").toLowerCase();
      const videoNative = !lf.has_video || vc.startsWith("h264") || vc.startsWith("avc");
      const audioNative = !lf.has_audio || ac.startsWith("aac") || ac.startsWith("mp3");
      const ext = (lf.filename.split(".").pop() ?? "").toLowerCase();
      // Container check — for video-bearing files we accept ISOBMFF
      // family (mp4/m4v/mov). For audio-only we ALSO accept mp4/m4v/mov
      // since audio-only mp4 is a thing (podcast feeds, ripped chapters)
      // and Safari plays them natively as long as the audio codec is
      // aac/mp3. Without this the mis-routing forces a needless transcode.
      const containerOk = lf.has_video
        ? ["mp4", "m4v", "mov"].includes(ext)
        : ["mp3", "m4a", "aac", "wav", "mp4", "m4v", "mov"].includes(ext);

      if (videoNative && audioNative && containerOk) {
        appendLog("ok", "import", "Codecs natively supported — playing original file (no transcode).");
        return;
      }

      // WebCodecs path — only fires for non-native files. Mediabunny will
      // try to decode; if it can't, onMediaError triggers runPlaybackPrep
      // as the final fallback (per-import, doesn't flip Settings).
      if (defaults.useWebCodecsDecoder) {
        appendLog("info", "import",
          `Non-native codecs (${vc || "?"} / ${ac || "?"}) — trying WebCodecs decoder.`);
        return;
      }

      // ffmpeg-prep path. Surface what we're transcoding and why so the
      // user understands the wait.
      const reasonParts: string[] = [];
      if (!videoNative) reasonParts.push(`video ${vc || "?"} → h264`);
      if (!audioNative) reasonParts.push(`audio ${ac || "?"} → aac`);
      if (!containerOk)  reasonParts.push(`container .${ext} → .mp4`);
      appendLog("info", "import",
        `Transcoding for playback: ${reasonParts.join(", ")}.`);
      await runPlaybackPrep(lf.path, lf.has_video, lf.duration, seq);
    } catch (err) {
      const msg = formatError(err);
      setErrorDetail(msg);
      appendLog("err", "import", msg);
      setStatus("error");
    }
  }, [appendLog, defaults.folder, defaults.useWebCodecsDecoder, resetForNewSource, runPlaybackPrep]);

  const handleStop = useCallback(async () => {
    const ids = [jobId, transcriptJobId, playbackPrepJobId].filter((x): x is string => !!x);
    const hasLocalExport = !!localExportCancelRef.current;
    const hadPlaybackPrep = !!playbackPrepJobId;
    if (ids.length === 0 && !hasLocalExport) return;
    appendLog("warn", "control",
      `Stopping ${ids.length + (hasLocalExport ? 1 : 0)} job(s)…`);
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
      setWebPreviewDownloading(false);
    }
    for (const id of ids) {
      try {
        await invoke<boolean>("cancel_job", { jobId: id });
      } catch (err) {
        appendLog("err", "control", `Cancel failed: ${formatError(err)}`);
      }
    }
  }, [jobId, transcriptJobId, playbackPrepJobId, appendLog]);

  /** Add the current active selection as a new queued item, then clear marks. */
  const handleAddToQueue = useCallback(() => {
    if (sourceKind !== "youtube") {
      pushNotification("info", "Queue is YouTube-only for now",
        "Local-file clip export is coming next; queue currently only handles YouTube sources.");
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
    const nextIndex = clipQueueRef.current.length + 1;
    const baseName = sanitizeFilename(exportOpts.filename || "clip");
    const item: QueuedClip = {
      id: Math.random().toString(36).slice(2),
      inFrames,
      outFrames,
      filename: baseName === "clip" ? `clip-${nextIndex}` : `${baseName}-${nextIndex}`,
      format: exportOpts.format,
      reencode: exportOpts.reencode,
      captions: exportOpts.captions,
      status: "queued",
    };
    setClipQueue((prev) => [...prev, item]);
    setInFrames(null);
    setOutFrames(null);
    setQueueOpen(true);
    appendLog("info", "queue", `Queued ${item.filename} (${framesToTc(item.inFrames, fps)} → ${framesToTc(item.outFrames, fps)})`);
  }, [sourceKind, inFrames, outFrames, fps, exportOpts.filename, exportOpts.format, exportOpts.reencode, exportOpts.captions, appendLog, pushNotification]);

  const handleQueueRemove = useCallback((id: string) => {
    setClipQueue((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const handleQueueClearAll = useCallback(() => {
    setClipQueue([]);
  }, []);

  /** Run every "queued" item through create_clip sequentially. */
  const handleExportQueue = useCallback(async () => {
    if (!metadata || !exportOpts.folder) return;
    if (queueRunning) return;
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
      const jobId = await invoke<string>("new_job_id");
      setJobId(jobId);
      appendLog("info", "queue", `Exporting ${item.filename} (${framesToTc(item.inFrames, fps)} → ${framesToTc(item.outFrames, fps)})…`);
      const result = await new Promise<{ success: boolean; path?: string; error?: string }>((resolve) => {
        queueResolverRef.current = resolve;
        invoke("create_clip", {
          args: {
            url: metadata.webpage_url,
            start: framesToTc(item.inFrames, fps),
            end: framesToTc(item.outFrames, fps),
            fps,
            output_dir: exportOpts.folder,
            filename: item.filename,
            job_id: jobId,
            format: item.format,
            reencode: item.reencode,
            captions: item.captions,
            cookies_browser: cookiesBrowserOrNone(),
          },
        }).catch((err) => {
          if (queueResolverRef.current) {
            queueResolverRef.current = null;
            resolve({ success: false, error: formatError(err) });
          }
        });
      });
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
        if (result.path && metadata) {
          const span = (item.outFrames - item.inFrames) / Math.max(1, Math.round(fps));
          const r: RecentClip = {
            id: Math.random().toString(36).slice(2),
            title: metadata.title,
            path: result.path,
            dur: secondsToTc(span, fps),
            when: Date.now(),
            thumbnail: metadata.thumbnail,
          };
          setRecents((prev) => [r, ...prev].slice(0, 6));
        }
      } else {
        failCount++;
      }
    }
    setQueueRunning(false);
    setStatus("loaded");
    setProgress(0);
    if (cancelled) {
      pushNotification("info", "Queue stopped", `${okCount} exported, ${failCount} failed, rest still queued.`);
    } else if (failCount === 0) {
      pushNotification("success", "Queue complete", `${okCount} ${okCount === 1 ? "clip" : "clips"} exported.`);
    } else {
      pushNotification("error", "Queue finished with errors", `${okCount} ok · ${failCount} failed.`);
    }
  }, [metadata, exportOpts.folder, queueRunning, fps, appendLog, pushNotification]);

  const handleSnapshot = useCallback(async () => {
    if (!metadata || snapshotBusy) return;
    const r = Math.max(1, Math.round(fps));
    const seconds = playheadFrames / r;
    const base = sanitizeFilename(metadata.title || "frame");
    const tcLabel = framesToTc(playheadFrames, fps).replace(/:/g, "");
    const defaultName = `${base}_${tcLabel}.jpg`;
    try {
      const dest = await saveDialog({
        defaultPath: exportOpts.folder ? `${exportOpts.folder}/${defaultName}` : defaultName,
        filters: [{ name: "Image", extensions: ["jpg", "jpeg", "png"] }],
      });
      if (!dest) return;
      setSnapshotBusy(true);
      appendLog("info", "snapshot", `Grabbing frame at ${framesToTc(playheadFrames, fps)} (${seconds.toFixed(2)}s)…`);
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
        raw = await invoke("extract_frame", {
          args: {
            url: metadata.webpage_url,
            timestamp_seconds: seconds,
            dest,
            cookies_browser: cookiesBrowserOrNone(),
          },
        });
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
  }, [metadata, sourceKind, localFilePath, snapshotBusy, fps, playheadFrames, exportOpts.folder, defaults.useWebCodecsDecoder, appendLog, notify, pushNotification]);

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
    // Resolve the per-month transcript-library subdir. Falls back to
    // exportOpts.folder for the brief moment between first launch and
    // the library-default-resolver effect landing.
    const outDir = await resolveTranscriptOutDir() ?? exportOpts.folder;
    if (!outDir) {
      setTranscriptState("error");
      setTranscriptError("Transcript library isn't set up yet — open Settings → Transcription and pick a folder.");
      return;
    }
    if (!selectedModel?.downloaded) {
      setTranscriptState("error");
      setTranscriptError(`Whisper model "${defaults.whisperModel}" is not downloaded. Opening Settings → Transcription.`);
      setSettingsInitialTab("transcription");
      setSettingsOpen(true);
      return;
    }
    setTranscriptState("running");
    setTranscriptError(null);
    setTranscriptProgress(0);
    setTranscriptPhase(null); // backend will emit "whisper" then "diarize-*"
    const srcLabel = sourceKind === "file" ? metadata.title : `${exportOpts.inTc || "00:00:00:00"} → ${exportOpts.outTc || "end"}`;
    appendLog("info", "whisper", `Transcribing ${srcLabel} with ${selectedModel.name}…`);
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
        const wavBlob = defaults.useWebCodecsDecoder
          ? await extractAudioAsWav16k(localFilePath).catch(() => null)
          : null;
        if (wavBlob) {
          appendLog("info", "whisper",
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
            },
          });
        } else {
          appendLog("info", "whisper", "Mediabunny can't decode this audio codec — falling back to ffmpeg.");
          await invoke<string>("transcribe_local_file", {
            args: {
              input_path: localFilePath,
              output_dir: outDir,
              filename: sanitizeFilename(exportOpts.filename || "transcript"),
              model_id: defaults.whisperModel,
              job_id: id,
              detect_speakers: defaults.detectSpeakers,
              expected_speakers: defaults.expectedSpeakers > 0 ? defaults.expectedSpeakers : null,
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
          },
        });
      }
    } catch (err) {
      const msg = formatError(err);
      setTranscriptState("error");
      setTranscriptError(msg);
      appendLog("err", "whisper", msg);
    }
  }, [metadata, exportOpts, fps, selectedModel, defaults.whisperModel,
      defaults.detectSpeakers, defaults.expectedSpeakers,
      appendLog, resolveTranscriptOutDir, localFilePath, sourceKind,
      durationFrames, inFrames, outFrames]);

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
  }) => {
    const entry = findForSource(input);
    if (!entry) return;
    try {
      // Probe existence/readability. Use the SAME 8 MB cap the viewer
      // reads with — read_text_file_capped *errors* when a file exceeds
      // the cap, so a tiny cap (the old 64 bytes) rejected every real
      // transcript with "File too large". We don't keep the result; the
      // viewer fetches the file itself when the path changes.
      await invoke<string>("read_text_file_capped", { path: entry.srtPath, maxBytes: 8 * 1024 * 1024 });
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
   * Triggered from the empty-state Import button AND the macOS File
   * menu (r42), so route both through this single callback.
   */
  const handleImportTranscript = useCallback(async () => {
    try {
      const picked = await import("@tauri-apps/plugin-dialog").then((m) =>
        m.open({
          multiple: false,
          directory: false,
          filters: [{ name: "Transcript", extensions: ["srt", "vtt"] }],
          title: "Import transcript",
        })
      );
      if (typeof picked !== "string" || !picked) return;
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
  }, [appendLog, pushNotification]);

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
      await invoke<string>("download_captions", {
        args: {
          url: metadata.webpage_url,
          output_dir: outDir,
          filename: sanitizeFilename(exportOpts.filename || "transcript"),
          job_id: id,
          cookies_browser: cookiesBrowserOrNone(),
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
  }, [metadata, exportOpts.folder, exportOpts.filename, appendLog, resolveTranscriptOutDir]);

  const handleClearLogs = useCallback(() => setLogs([]), []);
  const handleCopyLogs = useCallback(() => {
    const text = logs.map((l) => `${l.ts} ${l.source.padEnd(8)} ${l.message}`).join("\n");
    navigator.clipboard.writeText(text).catch(() => { /* ignore */ });
  }, [logs]);

  const handlePickRecent = useCallback((r: RecentClip) => {
    invoke("reveal_in_finder", { path: r.path }).catch(() => { /* ignore */ });
  }, []);

  /** Wipes the sidebar's Recent list. Files on disk are not touched. */
  const handleClearRecents = useCallback(() => {
    setRecents([]);
    appendLog("info", "control", "Cleared recent exports history.");
  }, [appendLog]);

  // ====== Transport ======
  // ── Variable-speed shuttle (J-K-L double-tap) ───────────────────────
  // rate: 0 = normal · >0 = fast-forward × · <0 = rewind ×. Routed to the live
  // player, which honors it per-engine (MediaBunny does true smooth reverse;
  // WebKit fast-forwards natively + scans backward — see PlayerHandle).
  const shuttleRateRef = useRef(0);
  const dblTapRef = useRef({ l: 0, j: 0 });
  const applyShuttle = useCallback((rate: number) => {
    shuttleRateRef.current = rate;
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
    setPlayheadFrames((f) => {
      const next = Math.max(0, Math.min(Math.max(0, durationFrames - 1), f + delta));
      if (p && p.isReady()) {
        p.pause();
        p.seekTo(next / r);
      }
      return next;
    });
  }, [durationFrames, fps, exitShuttle]);

  const seekBySeconds = useCallback((deltaSec: number) => {
    exitShuttle();
    const r = Math.max(1, Math.round(fps));
    const p = playerRef.current;
    const currentSec = p?.isReady() ? (p.getCurrentTime?.() ?? 0) : playheadFrames / r;
    const targetSec = Math.max(0, Math.min((durationFrames - 1) / r, currentSec + deltaSec));
    setPlayheadFrames(Math.floor(targetSec * r));
    if (p?.isReady()) p.seekTo(targetSec);
  }, [fps, playheadFrames, durationFrames, exitShuttle]);

  const onMarkIn = useCallback(() => {
    const r = Math.max(1, Math.round(fps));
    // If an out mark already exists and the playhead is past it, bump out a frame.
    setInFrames(() => {
      if (outFrames != null && playheadFrames >= outFrames) {
        return Math.max(0, outFrames - r);
      }
      return playheadFrames;
    });
  }, [playheadFrames, outFrames, fps]);

  const onMarkOut = useCallback(() => {
    const r = Math.max(1, Math.round(fps));
    setOutFrames(() => {
      if (inFrames != null && playheadFrames <= inFrames) {
        return Math.min(Math.max(0, durationFrames - 1), inFrames + r);
      }
      return playheadFrames;
    });
  }, [playheadFrames, inFrames, fps, durationFrames]);

  // Clear literally clears — no selection at all.
  const onClearMarks = useCallback(() => {
    setInFrames(null);
    setOutFrames(null);
  }, []);

  const onGotoIn = useCallback(() => {
    if (inFrames == null) return;
    exitShuttle();
    const r = Math.max(1, Math.round(fps));
    setPlayheadFrames(inFrames);
    playerRef.current?.seekTo?.(inFrames / r);
  }, [inFrames, fps, exitShuttle]);

  const onGotoOut = useCallback(() => {
    if (outFrames == null) return;
    exitShuttle();
    const r = Math.max(1, Math.round(fps));
    setPlayheadFrames(outFrames);
    playerRef.current?.seekTo?.(outFrames / r);
  }, [outFrames, fps, exitShuttle]);

  const onSeek = useCallback((f: number) => {
    exitShuttle();
    const r = Math.max(1, Math.round(fps));
    const clamped = Math.max(0, Math.min(Math.max(0, durationFrames - 1), f));
    setPlayheadFrames(clamped);
    playerRef.current?.seekTo?.(clamped / r);
  }, [durationFrames, fps, exitShuttle]);

  // ====== Keyboard ======
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const inField = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
      const cmd = e.metaKey || e.ctrlKey;

      // ⌘K — command palette toggle. Highest-priority shortcut (works
      // even when focus is in the URL bar / filename field) because the
      // palette is the universal escape hatch.
      if (cmd && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen((p) => !p);
        return;
      }
      if (cmd && e.key === ",")     { e.preventDefault(); setSettingsOpen((p) => !p); return; }
      if (e.key === "Escape" && settingsOpen) { e.preventDefault(); setSettingsOpen(false); return; }
      if (cmd && e.key === "Enter") { e.preventDefault(); handleFetch(); return; }
      if (cmd && e.key === "\\")    { e.preventDefault(); setLogsOpen((p) => !p); return; }
      // ⌘⇧A — add the current active selection to the queue (the modifier
      // separates this from the bare I/O keys used to mark in/out).
      if (cmd && e.shiftKey && (e.key === "A" || e.key === "a")) {
        e.preventDefault();
        handleAddToQueue();
        return;
      }
      // ⌘⇧Q — toggle the queue drawer.
      if (cmd && e.shiftKey && (e.key === "Q" || e.key === "q")) {
        e.preventDefault();
        setQueueOpen((p) => !p);
        return;
      }
      if (e.altKey && (e.key === "e" || e.key === "E")) {
        if (status === "loaded") { e.preventDefault(); handleExport(); }
        return;
      }

      if (inField || settingsOpen) return;

      switch (e.key) {
        case " ": e.preventDefault(); onPlayToggle(); break;
        case "k": case "K": onPlayToggle(); break;
        case "j": case "J": {
          // Double-tap J → rewind shuttle; single tap → back 5s (exits shuttle).
          const now = Date.now();
          if (now - dblTapRef.current.j < 350) { dblTapRef.current.j = 0; applyShuttle(-2); }
          else { dblTapRef.current.j = now; seekBySeconds(-5); }
          break;
        }
        case "l": case "L": {
          // Double-tap L → fast-forward shuttle; single tap → forward 5s.
          const now = Date.now();
          if (now - dblTapRef.current.l < 350) { dblTapRef.current.l = 0; applyShuttle(2); }
          else { dblTapRef.current.l = now; seekBySeconds(5); }
          break;
        }
        case "i": case "I": onMarkIn(); break;
        case "o": case "O": onMarkOut(); break;
        case "g": case "G": onClearMarks(); break;
        case "q": case "Q": onGotoIn(); break;
        case "w": case "W": onGotoOut(); break;
        case ",": onStep(e.shiftKey ? -Math.round(fps) : -1); break;
        case ".": onStep(e.shiftKey ?  Math.round(fps) :  1); break;
        case "ArrowLeft":  onStep(e.shiftKey ? -Math.round(fps) : -1); break;
        case "ArrowRight": onStep(e.shiftKey ?  Math.round(fps) :  1); break;
        case "Home": onSeek(0); break;
        case "End":  onSeek(Math.max(0, durationFrames - 1)); break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    handleFetch, handleExport, handleAddToQueue, status, fps, durationFrames, settingsOpen,
    onPlayToggle, seekBySeconds, onMarkIn, onMarkOut, onClearMarks,
    onGotoIn, onGotoOut, onStep, onSeek, applyShuttle,
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
          // Just focus the URL input — it's already in the toolbar.
          const el = document.querySelector<HTMLInputElement>(".cp-toolbar-url input");
          el?.focus();
          el?.select();
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
  }, [handleImportFile, handleImportTranscript, defaults.transcriptLibrary]);

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
    url, hasSource, isPlaying, inFrames, outFrames, durationFrames,
    captionsOn, logsOpen, clipQueueLength: clipQueue.length, queueRunning,
    activeTranscriptPath: activeTranscript?.path ?? null,
    exportFolder: exportOpts.folder, sourceKind, status, transcriptState, playbackPrepBusy,
    handleFetch, handleImportFile, handleClear, onPlayToggle, seekBySeconds,
    onStep, onSeek, onMarkIn, onMarkOut, onClearMarks, onGotoIn, onGotoOut,
    handleExport, handleSnapshot, handleAddToQueue, handleExportQueue,
    handleQueueClearAll, handleImportTranscript, handleGenerateTranscript,
    handleDownloadCaptions, handleStop,
    setQueueOpen, setTranscriptArrivedTick, setCaptionsOn, setLogsOpen,
    setSettingsOpen, setPaletteOpen,
    onProbeDiarizer: async () => {
      try {
        const ver = await invoke<string>("probe_diarizer");
        pushNotification("success", "Diarizer ready", ver);
      } catch (e) {
        pushNotification("error", "Diarizer probe failed", formatError(e));
      }
    },
  }), [
    url, hasSource, isPlaying, inFrames, outFrames, durationFrames,
    captionsOn, logsOpen, clipQueue.length, queueRunning, activeTranscript,
    exportOpts.folder, sourceKind, status, transcriptState, playbackPrepBusy,
    handleFetch, handleImportFile, handleClear, onPlayToggle, seekBySeconds,
    onStep, onSeek, onMarkIn, onMarkOut, onClearMarks, onGotoIn, onGotoOut,
    handleExport, handleSnapshot, handleAddToQueue, handleExportQueue,
    handleQueueClearAll, handleGenerateTranscript, handleDownloadCaptions, handleImportTranscript,
    handleStop,
  ]);

  // ====== Side-panel pop-out (r44.B + r52 extract) ======
  // Cross-window state-sync bridge lives in src/hooks/use-panel-bus.ts.
  // We hand it the rendered snapshot + freshly-bound handlers; the hook
  // owns the listeners, the ref discipline, and the popout dispatch.
  const transcriptPlayhead = hasSource ? playheadFrames / Math.max(1, Math.round(fps)) : null;
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
    },
  });

  // ====== Derived ======
  const playheadTc = framesToTc(playheadFrames, fps);
  const titleSuffix = (status === "loaded" || status === "exporting" || status === "success") && exportOpts.filename
    ? ` — ${exportOpts.filename}`
    : "";

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

      <Toolbar
        url={url}
        onChange={setUrl}
        onFetch={handleFetch}
        onClear={handleClear}
        onImportFile={handleImportFile}
        onToggleQueue={() => setQueueOpen((p) => !p)}
        queueCount={clipQueue.length}
        queueOpen={queueOpen}
        hasSource={status === "loaded" || status === "exporting" || status === "success" || status === "error"}
        status={status}
        onOpenSettings={() => setSettingsOpen(true)}
        notifications={notifications}
        onMarkAllRead={onMarkAllRead}
        onClearNotifications={onClearNotifications}
        onDismissNotification={onDismissNotification}
      />

      <div className="cp-body">
        <Sidebar
          status={status}
          metadata={metadata}
          exportOpts={exportOpts}
          setExportOpts={setExportOpts}
          recents={recents}
          onExport={handleExport}
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
          transcriptError={transcriptError}
          transcriptProgress={transcriptProgress}
          transcriptPhase={transcriptPhase}
          whisperModelReady={whisperModelReady}
          whisperModelLabel={whisperModelLabel}
          onOpenTranscriptionSettings={handleOpenTranscriptionSettings}
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
              <ViewOptions aspect={aspect} onAspectChange={setAspect} />
            </div>
            <Monitor
              ref={playerRef}
              status={status}
              metadata={metadata}
              errorDetail={errorDetail}
              aspect={aspect}
              sourceKind={sourceKind}
              /* Prefer the ffmpeg-normalised playback copy when ready —
                 it's the WKWebView-compatible MP4/MP3. Falls back to the
                 original so the user still sees a player even if prep is
                 still running or failed. */
              localFilePath={playbackPath ?? localFilePath}
              /* Prefer the cached local copy (from runWebPreviewDownload)
                 over the direct stream — the cache is set only after the
                 direct stream actually failed, so this swap = "we know
                 the CDN was rejecting us, use the local bytes". */
              webStreamUrl={webCachePath ?? webStreamUrl}
              initialVolume={muted ? 0 : volume}
              playbackPrepBusy={playbackPrepBusy}
              playbackPrepProgress={playbackPrepProgress}
              /* r62: friendly "what's happening" overlay over the poster
                 while a web source resolves (yt-dlp ~8s) then buffers
                 (MSE). Null once the player is ready or for local files /
                 the download fallback (which has its own banner). */
              streamLoadingPhase={
                sourceKind === "youtube" && status === "loaded" && !playerReady
                  && !webPreviewDownloading && !playbackPrepBusy
                  ? ((webStreamUrl || webCachePath) ? "Starting playback…" : "Resolving stream…")
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
              useWebCodecs={defaults.useWebCodecsDecoder && !webCodecsFallbackForImport}
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

                // Web-source playback fallback (r60): the web branch streams
                // through MediaBunnyPlayer (WebCodecs over the loopback
                // proxy). If mediabunny can't open/demux/decode the stream
                // — "Failed to open file…", "[WEBCODECS_UNSUPPORTED]…",
                // "Video/Audio decode failed…" — OR the old <video> path
                // reports MEDIA_ERR_*, fall back to the yt-dlp download.
                // We match on the web-source CONTEXT, not the message text,
                // so any failure mode degrades gracefully to the path that
                // always works. (No-op once we're already downloading or
                // playing the cached local file.)
                if (
                  sourceKind === "youtube"            // i.e. web (not local file)
                  && webStreamUrl                      // we WERE trying to stream
                  && !webCachePath                     // not already in fallback
                  && !webPreviewDownloading            // not already downloading
                  && metadata
                ) {
                  appendLog("warn", "media",
                    `Stream playback failed (${msg}) — falling back to download.`);
                  pushNotification("info", "Downloading preview…",
                    "Couldn't stream this source in-app. Sauce Bunny is fetching the file via yt-dlp so you can scrub and mark.");
                  const seq = sourceSeqRef.current;
                  void runWebPreviewDownload(metadata.webpage_url, seq);
                  return;
                }

                appendLog("err", "media", msg);
                pushNotification("error", "Playback error", msg);
              }}
              toast={toast}
              onToastDismiss={() => setToast(null)}
              onPlayerTimeUpdate={onPlayerTimeUpdate}
              onPlayerStateChange={onPlayerStateChange}
              onPlayerReady={onPlayerReady}
              onSurfaceClick={onPlayToggle}
            />
            <Transport
              status={status}
              isPlaying={isPlaying}
              playheadTc={playheadTc}
              durationTc={durationTc}
              captionsOn={captionsOn}
              snapshotBusy={snapshotBusy}
              canSnapshot={status === "loaded" || status === "exporting" || status === "success"}
              volume={volume}
              muted={muted}
              onPlayToggle={onPlayToggle}
              onStep={onStep}
              onMarkIn={onMarkIn}
              onMarkOut={onMarkOut}
              onClearMarks={onClearMarks}
              onToggleCaptions={() => setCaptionsOn((p) => !p)}
              onSnapshot={handleSnapshot}
              onVolumeChange={handleVolumeChange}
              onMutedChange={handleMutedChange}
            />
            <Timeline
              status={status}
              durationFrames={durationFrames}
              playheadFrames={playheadFrames}
              inFrames={inFrames}
              outFrames={outFrames}
              fps={fps}
              queuedRanges={clipQueue.map((c) => ({
                id: c.id,
                inFrames: c.inFrames,
                outFrames: c.outFrames,
                status: c.status,
              }))}
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
              ) : ""}
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
            transcriptState={transcriptState}
            transcriptProgress={transcriptProgress}
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
          transcriptPath={activeTranscript?.path ?? null}
          transcriptOrigin={activeTranscript?.origin ?? "unknown"}
          transcriptPlayhead={hasSource ? playheadFrames / Math.max(1, Math.round(fps)) : null}
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
          onImportTranscript={handleImportTranscript}
        />}
      </div>

      <SettingsModal
        open={settingsOpen}
        onClose={() => { setSettingsOpen(false); refreshWhisperModels(); }}
        defaults={defaults}
        setDefaults={setDefaults}
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
        current={defaults.ytCookiesBrowser}
        onPick={handleYtAuthPick}
        onClose={handleYtAuthClose}
      />

      {/* ⌘K command palette — mounted at top level so its portal sits
          above every panel/drawer/modal. Always rendered; the component
          short-circuits to null when closed so the overhead is one
          `if (!open) return null`. */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
      />
    </div>
  );
}
