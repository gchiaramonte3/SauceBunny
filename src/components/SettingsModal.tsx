import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

/** Style helper for the sliding-pill segmented control: drives the active
 *  index + segment count CSS vars the .cp-segmented pill animates from. */
const segStyle = (active: number, count: number, extra?: CSSProperties): CSSProperties =>
  ({ ...extra, ["--seg-active"]: Math.max(0, active), ["--seg-count"]: count } as CSSProperties);
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { IconChevronDown, IconHeart, IconReveal, IconSparkles, IconInfo } from "./Icons";
import { loadJson, saveJson } from "../lib/storage";
import { DEVICE_CHOICE_KEY } from "../lib/media-devices";
import { AvSettingsPane } from "./AvSettingsPane";
import { ColorSwatches } from "./ColorSwatches";
import { KeybindingEditor } from "./KeybindingEditor";
import { loadKeybindings, KEYBINDINGS_STORAGE_KEY, type KeybindingOverrides } from "../lib/keybindings";

// localStorage keys an export/import round-trips. Mirror App's DEFAULTS_KEY +
// the section store; kept here (not imported from App) to avoid a settings↔App
// import cycle. Stable strings.
const DEFAULTS_LS_KEY = "cp-defaults-v2";
const SECTIONS_LS_KEY = "saucebunny.settingsSections.v1";
// Bump when the export payload's shape changes incompatibly; import refuses a
// file whose version is higher than this (forward-compat guard).
const SETTINGS_EXPORT_VERSION = 1;
import type {
  ExportOpts, FormatId, ModelDownloadEvent, WhisperModel, DoneEvent,
  CacheStats, AudioInputDevice,
} from "../types";
import type { Command } from "../lib/commands";
import type { LlmModel } from "../bindings/LlmModel";
import { formatError } from "../lib/error-format";
import { CollapsibleSection } from "./CollapsibleSection";
import { YouTubeSettings } from "./YouTubeSettings";
import { AiApiSettings } from "./AiApiSettings";
import { useModalFocus } from "../hooks/use-modal-focus";
import { formatBytes } from "../lib/library";
import logoUrl from "../assets/saucebunny.svg";
import { UpdateRow } from "./UpdateRow";
import { OpenSourceCredits } from "./OpenSourceCredits";
import { SAUCE_BUNNY } from "../lib/open-source";
import { getVersion } from "@tauri-apps/api/app";
import { countHiddenNotices, restoreHiddenNotices } from "../lib/hidden-notices";
import { EXPECTED_BACKEND_BUILD_ID } from "../lib/build-id";
import { newJobId } from "../lib/job-id";
import { DEFAULT_STUN_URL } from "../lib/ice-servers";

type TabId = "general" | "captions" | "devices" | "transcription" | "youtube" | "ai-summary" | "ai-apis" | "commands" | "about" | "credits";

export type Defaults = {
  folder: string | null;
  /** Optional TURN relay for co-review webcams (empty = STUN only).
   *  All three ride to RTCPeerConnection verbatim; nothing is validated
   *  here (a bad server just falls back to direct/STUN candidates). */
  turnUrl: string;
  turnUsername: string;
  turnPassword: string;
  /** STUN server for co-review webcams. Defaults to DEFAULT_STUN_URL, which
   *  is Google's - it used to be hardcoded, so it was neither visible nor
   *  changeable. Empty means no reflexive candidates at all: LAN (and TURN,
   *  if set) only. See lib/ice-servers for what a STUN server learns. */
  stunUrl: string;
  format: FormatId;
  reencode: boolean;
  captions: boolean;
  timecode: "24" | "25" | "30";
  whisperModel: string; // e.g. "base.en"
  /**
   * Active transcription engine. "whisper" → whisper-cli (the bundled
   * default, English-tuned). "parakeet" → FluidAudio's Parakeet TDT v3
   * (Core ML, multilingual, word-level timings) run via the diarize
   * sidecar's --asr mode; requires its ~0.5 GB model to be downloaded
   * first (Settings → Transcription → Parakeet → Download). Both run
   * 100% on-device.
   */
  transcriptionEngine: "whisper" | "parakeet";
  /**
   * Spoken language for transcription — "auto" (whisper.cpp language
   * auto-detect, the default) or an ISO-639-1 code ("en", "es", …).
   * Threaded into every whisper-cli run (`-l`, incl. dictation) and into
   * yt-dlp caption downloads as the preferred subtitle locale. Parakeet
   * handles language itself and ignores this.
   */
  transcriptionLanguage: string;
  /** AI Summary: chosen local llama.cpp model id (Settings → AI Summary). */
  llmSummarizationModel: string;
  /** AI Summary output shape — bullets, numbered list, or prose. */
  summaryFormat: "bullets" | "numbered" | "prose";
  /** AI Summary length target. */
  summaryLength: "brief" | "standard" | "detailed";
  /**
   * When true, imported local files are played via mediabunny + WebCodecs
   * instead of the ffmpeg pre-encode path. Skips the 6–13s prep on import
   * and the cache file, plays native VP9/AV1/HEVC. Marked experimental
   * because we own the playback clock + A/V sync.
   */
  useWebCodecsDecoder: boolean;
  /**
   * When true, web sources (YouTube/etc.) try the INSTANT MSE stream
   * preview (loopback proxy + ffmpeg fMP4 remux) for fastest time-to-play.
   * Default OFF (r70): the reliable default downloads the file to cache
   * first, then plays it natively (full audio, instant native scrub, no
   * MSE fragility). Opt in only if you want fastest playback and accept
   * that live web streaming is less reliable than download-first.
   */
  streamPreview: boolean;
  /**
   * One-shot flag: true once the r72 "hybrid is the default" migration has
   * forced `streamPreview` on for an existing install (which may have saved
   * the old download-first default). After it latches, the user's own
   * toggle is honoured. New installs start migrated.
   */
  hybridMigrated: boolean;
  /**
   * Browser to pull YouTube cookies from for yt-dlp's --cookies-from-
   * browser flag. Required for any video YouTube has gated behind "Sign
   * in to confirm you're not a bot" (most videos under heavy detection
   * as of mid-2026). "none" → no cookies sent.
   */
  ytCookiesBrowser: "none" | "chrome" | "safari" | "firefox" | "brave" | "edge";
  /**
   * Latches true once the user has seen the first-run "Connect YouTube"
   * prompt and either picked a browser or dismissed it. Prevents the
   * welcome modal from nagging on every launch. The bot-check/severed
   * prompts are independent of this and still fire on real failures.
   */
  ytAuthOnboarded: boolean;
  /**
   * When true, the "Generate transcript" flow runs the saucebunny-diarize
   * Swift sidecar after Whisper and stitches speaker labels into the
   * resulting SRT. Off by default — adds 10–60s per transcript and the
   * model cache is hundreds of MB on first run. Users opt in via the
   * Sidebar's Whisper section.
   */
  detectSpeakers: boolean;
  /**
   * Speaker-count hint passed to the diarizer when `detectSpeakers`
   * is on. 0 → auto (let the model estimate). Otherwise the exact
   * speaker count, which skips pyannote's clustering-estimate stage
   * entirely and dramatically improves accuracy when known. Sidebar
   * exposes this as a small dropdown: Auto / 2 / 3 / 4 / 5 / 6+ (6+
   * is implemented as min=6 with no max, not a fixed count).
   */
  expectedSpeakers: number;
  /**
   * Root folder for all generated transcripts (Whisper output AND
   * yt-dlp caption downloads). Defaults to
   * `~/Documents/Sauce Bunny/Transcripts/` and is sub-organized by
   * `YYYY-MM/` so a year of work doesn't pile into one directory.
   *
   * Decoupled from `folder` (which is the clip-export destination
   * the user picks per session): transcripts are byproducts the user
   * wants to find later, exports are deliverables the user is
   * delivering to a specific place. Different intents, different
   * folders.
   */
  transcriptLibrary: string;
  // ── On-video caption appearance (the transport CC overlay) ──
  /** Caption text size in pixels (absolute). Clamped 12–48. */
  captionSizePx: number;
  /** Caption font family — keyed into CAP_FONTS. */
  captionFont: CaptionFontKey;
  /** Opacity of the caption's dark backing pill, 0 (none) – 1 (solid). */
  captionBgOpacity: number;
  /** Caption text colour (hex). */
  captionColor: string;
  /**
   * Max height (px) for the web-preview download — the throwaway copy we
   * fetch via yt-dlp so you can scrub/mark a web source in-app. Lower =
   * far smaller file = faster time-to-play; the actual export still uses
   * the quality you pick on the export form. 480 is plenty for finding
   * clip points; bump to 720/1080 if you want a sharper preview.
   */
  previewMaxHeight: 480 | 720 | 1080;
  /**
   * Media-cache size cap in GB (0 = keep everything, the long-standing
   * default). When set, `enforce_media_cache_cap` prunes the oldest files
   * at launch and whenever the cap changes; files backing the on-screen
   * source and in-flight jobs are never touched.
   */
  mediaCacheCapGb: number;
  /** Empty the media cache automatically when the app quits (r141). */
  clearCacheOnQuit: boolean;
  /**
   * NLE-style audio while scrubbing (r143): dragging the playhead plays
   * short blips of the sound under the cursor. WebCodecs player only; the
   * native <video> players show a silent frame preview instead.
   */
  scrubAudio: boolean;
};

type Props = {
  open: boolean;
  onClose: () => void;
  /** Cache files the current session is actively playing from (web preview
   *  download, audio-master track, playback-prep copy). Clear cache skips
   *  these — their jobs already finished, so the backend's in-flight-job
   *  guard alone would let the on-screen video's file be deleted. */
  cacheExcludePaths?: string[];
  defaults: Defaults;
  setDefaults: (d: Defaults) => void;
  /** Tier B streaming quality: "auto" walks the ladder, a number pins it.
   *  Owned by `useStreamRung` (which persists it) rather than living in
   *  `defaults`, because the policy reads and writes it live during a session
   *  — a downshift happens while the user is watching, not when Settings is
   *  saved. */
  streamRungPref: "auto" | 1080 | 720 | 540 | 360;
  /** S.5: whether watching a peer stream also saves a copy on this Mac. */
  keepEnabled: boolean;
  setKeepEnabled: (on: boolean) => void;
  setStreamRungPref: (p: "auto" | 1080 | 720 | 540 | 360) => void;
  /** User keyboard-shortcut overrides + setter (Settings → Commands). */
  keybindings: KeybindingOverrides;
  setKeybindings: (next: KeybindingOverrides) => void;
  /** Apply current defaults to the in-flight export form. */
  onApplyToCurrent?: (patch: Partial<ExportOpts>) => void;
  /** Optional initial tab to open on. */
  initialTab?: TabId;
  /**
   * Full registry of palette commands, threaded down from App so the
   * Commands tab can render the same list users see in ⌘K. The tab
   * doesn't invoke commands — it's documentation-only — but having the
   * list here keeps shortcuts/keywords/descriptions in sync with the
   * palette automatically (no second source of truth to drift).
   */
  commands?: Command[];
  /** Speaker-diarization model pre-warm flow (see App.tsx). */
  diarizerReady: boolean;
  diarizerPrepareState: "idle" | "running" | "done" | "error";
  diarizerPrepareError: string | null;
  onPrepareDiarizerModels: () => void;
  onCancelDiarizerPrepare: () => void;
};

const TABS: { id: TabId; label: string }[] = [
  { id: "general",       label: "General" },
  { id: "captions",      label: "Captions" },
  { id: "devices",       label: "Camera & Mic" },
  { id: "youtube",       label: "Web sources" },
  { id: "transcription", label: "Transcription" },
  { id: "ai-summary",    label: "AI Summary" },
  { id: "ai-apis",       label: "AI APIs" },
  { id: "commands",      label: "Shortcuts" },
  { id: "about",         label: "About" },
  { id: "credits",       label: "Open source" },
];

const FORMATS: { id: FormatId; label: string }[] = [
  { id: "4k",    label: "4K" },
  { id: "1080",  label: "1080p" },
  { id: "720",   label: "720p" },
  { id: "audio", label: "Audio" },
];

// Caption fonts (Settings → Captions). All are macOS system fonts (no bundling)
// chosen for caption legibility per broadcast/accessibility guidance: wide,
// high-x-height sans faces lead (Verdana is the default — designed for screen
// legibility and on the British Dyslexia Association's even-spaced list), with
// serif/mono and the app's own Nunito Sans rounding out the set.
// MUST stay in sync with FONT_STACK in CaptionOverlay.tsx (same keys + stacks).
export type CaptionFontKey =
  | "verdana" | "helvetica" | "arial" | "tahoma" | "trebuchet" | "georgia" | "courier" | "nunito";
const CAP_FONTS: Record<CaptionFontKey, string> = {
  verdana: "Verdana, Geneva, sans-serif",
  helvetica: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  arial: "Arial, 'Helvetica Neue', sans-serif",
  tahoma: "Tahoma, Geneva, Verdana, sans-serif",
  trebuchet: "'Trebuchet MS', 'Helvetica Neue', sans-serif",
  georgia: "Georgia, 'Times New Roman', serif",
  courier: "'Courier New', Courier, monospace",
  nunito: "'Nunito Sans', system-ui, sans-serif",
};
const CAP_FONT_LABELS: Record<CaptionFontKey, string> = {
  verdana: "Verdana", helvetica: "Helvetica", arial: "Arial", tahoma: "Tahoma",
  trebuchet: "Trebuchet MS", georgia: "Georgia", courier: "Courier", nunito: "Nunito Sans",
};
const CAP_COLORS = ["#ffffff", "#ffe14d", "#7be8ff", "#7bdcb5", "#ff8a8a"];
const CAP_SIZE_MIN = 12;
const CAP_SIZE_MAX = 48;
const clampCaptionSize = (n: number) =>
  Math.max(CAP_SIZE_MIN, Math.min(CAP_SIZE_MAX, Math.round(Number.isFinite(n) ? n : CAP_SIZE_MIN)));

function formatMB(bytes: number): string {
  if (!isFinite(bytes) || bytes <= 0) return "—";
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}

// small.en is the accuracy sweet spot (~3.4% WER vs base's much higher rate)
// and still fast on Apple Silicon. base.en was the old default but its word
// errors were the top transcription complaint. medium.en / large are offered
// for users who want maximum accuracy and will accept a slower pass.
const RECOMMENDED_MODEL = "small.en";

// Settings → Transcription → Language. Codes are whisper-cli `-l` values
// (ISO-639-1); "auto" = whisper.cpp language auto-detection. The same code is
// passed to yt-dlp caption downloads as the preferred subtitle locale (the
// backend adds regional/base forms itself — e.g. "zh" is enough for Chinese).
const TRANSCRIPTION_LANGUAGES: { code: string; label: string }[] = [
  { code: "auto", label: "Auto-detect" },
  { code: "en",   label: "English" },
  { code: "es",   label: "Spanish" },
  { code: "fr",   label: "French" },
  { code: "de",   label: "German" },
  { code: "it",   label: "Italian" },
  { code: "pt",   label: "Portuguese" },
  { code: "ja",   label: "Japanese" },
  { code: "ko",   label: "Korean" },
  { code: "zh",   label: "Chinese" },
  { code: "ru",   label: "Russian" },
  { code: "ar",   label: "Arabic" },
  { code: "hi",   label: "Hindi" },
];

type ModelInfo = {
  tagline: string;
  accuracy: string;
  speed: string;
  whenToUse: string;
};
const MODEL_INFO: Record<string, ModelInfo> = {
  "tiny.en": {
    tagline: "Fastest, lowest accuracy.",
    accuracy: "Decent for clean speech; struggles with accents, jargon, overlapping speakers.",
    speed: "~32× realtime on Apple Silicon.",
    whenToUse: "Quick rough drafts when you'll hand-edit the transcript anyway.",
  },
  "base.en": {
    tagline: "Balanced, the recommended starting point.",
    accuracy: "Good for most podcasts and interviews; trips on technical terms.",
    speed: "~16× realtime on Apple Silicon.",
    whenToUse: "Default for most clips. Best size:accuracy trade-off.",
  },
  "small.en": {
    tagline: "Better accuracy, noticeably slower.",
    accuracy: "Handles accents, jargon, and faster speech reliably.",
    speed: "~6× realtime on Apple Silicon.",
    whenToUse: "Long-form interviews, anything you'd publish without heavy editing.",
  },
  "medium.en": {
    tagline: "High accuracy, slow.",
    accuracy: "Near-pro quality. Robust to noise, overlapping voices, varied audio.",
    speed: "~2× realtime on Apple Silicon.",
    whenToUse: "Final captions for delivery; archival transcripts.",
  },
};

function ModelInfoPopover({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // Capture + stop: Esc dismisses just the popover — without this it
      // bubbles on to SettingsModal's and App's Escape handlers and closes
      // the whole Settings window (CommandPalette uses the same pattern).
      e.stopImmediatePropagation();
      e.preventDefault();
      setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const info = MODEL_INFO[id];
  if (!info) return null;

  return (
    <div className="cp-model-info" ref={ref}>
      <button
        type="button"
        className="cp-model-info-btn"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        title="About this model"
      >
        <IconInfo size={13} />
      </button>
      {open && (
        <div className="cp-model-info-popover" onClick={(e) => e.stopPropagation()}>
          <div className="tag">{info.tagline}</div>
          <dl>
            <dt>Accuracy</dt><dd>{info.accuracy}</dd>
            <dt>Speed</dt><dd>{info.speed}</dd>
            <dt>Use for</dt><dd>{info.whenToUse}</dd>
          </dl>
        </div>
      )}
    </div>
  );
}

export function SettingsModal(props: Props) {
  const {
    open, onClose, defaults, setDefaults, keybindings, setKeybindings,
    streamRungPref, setStreamRungPref, keepEnabled, setKeepEnabled,
    onApplyToCurrent, initialTab, commands,
    diarizerReady, diarizerPrepareState, diarizerPrepareError,
    onPrepareDiarizerModels, onCancelDiarizerPrepare,
  } = props;
  // Read from the bundle, never hardcoded: the About tab used to claim v0.1.0
  // while the app was 0.2.0. The build number distinguishes two DMGs of the
  // same version (see scripts/set-version.sh) — and it is RENDERED, which for
  // a long time it was not: this comment described the build number as the
  // thing telling two builds apart while the line below printed the semver
  // alone, so every 0.2.0 build read identically in the one place a user can
  // check what they are running. __BUILD_NUMBER__ comes from vite.config.ts,
  // read out of the same tauri.conf.json the bundler stamps.
  const [appVersion, setAppVersion] = useState<string | null>(null);
  /** How many "don't show again" flags are set, recounted each time the modal
   *  opens so the row cannot claim a stale number. */
  const [hiddenCount, setHiddenCount] = useState(0);
  const [restored, setRestored] = useState(0);
  useEffect(() => {
    if (!open) return;
    setHiddenCount(countHiddenNotices());
    setRestored(0);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    void getVersion().then(setAppVersion).catch(() => setAppVersion(null));
  }, [open]);
  const [tab, setTab] = useState<TabId>(initialTab ?? "general");

  // When opening, jump to requested tab.
  useEffect(() => {
    if (open && initialTab) setTab(initialTab);
  }, [open, initialTab]);

  // Whisper model state.
  const [models, setModels] = useState<WhisperModel[]>([]);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  // Set SYNCHRONOUSLY in startDownload before any await. The event
  // listeners are mounted once and filter against this ref — re-subscribing on
  // a state change (the old design) raced the backend: events emitted before
  // the new listener attached were dropped, leaving "Downloading…" stuck.
  const downloadJobIdRef = useRef<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<{
    modelId: string;
    percent: number;
    done: number;
    total: number;
  } | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  // Collapsible Settings sections (chevron headers). Collapsed by default so a
  // tab opens tight; each section's open/closed state is remembered per id so a
  // user can expand the ones they care about and have it persist.
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(
    () => loadJson<Record<string, boolean>>("saucebunny.settingsSections.v1", {}),
  );
  // Open by default — a section stays open unless the user has explicitly
  // collapsed it (persisted in saucebunny.settingsSections.v1).
  const sectionOpen = useCallback((id: string) => openSections[id] ?? true, [openSections]);
  const toggleSection = useCallback((id: string) => {
    setOpenSections((prev) => {
      const next = { ...prev, [id]: !(prev[id] ?? true) };
      saveJson("saucebunny.settingsSections.v1", next);
      return next;
    });
  }, []);
  // Transcription-engine tree (host → models). Both open by default.
  const [whisperOpen, setWhisperOpen] = useState(true);
  const [parakeetOpen, setParakeetOpen] = useState(true);
  // Parakeet engine state. null = not yet checked. The model downloads via the
  // diarize sidecar (--prepare-asr-models), which has no byte-level progress, so
  // this is a simple busy/ready flag rather than the percent bar Whisper uses.
  const [parakeetReady, setParakeetReady] = useState<boolean | null>(null);
  const [parakeetBusy, setParakeetBusy] = useState(false);
  const [parakeetError, setParakeetError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    invoke<boolean>("parakeet_model_downloaded")
      .then(setParakeetReady)
      .catch(() => setParakeetReady(false));
  }, [open]);

  const downloadParakeet = useCallback(async () => {
    setParakeetBusy(true);
    setParakeetError(null);
    try {
      const id = newJobId();
      await invoke("download_parakeet_model", { jobId: id });
      // Confirm against disk rather than assuming success, so the row never
      // shows "Installed/In use" without the model actually being present.
      setParakeetReady(await invoke<boolean>("parakeet_model_downloaded").catch(() => true));
    } catch (e) {
      setParakeetError(formatError(e));
    } finally {
      setParakeetBusy(false);
    }
  }, []);

  const deleteParakeet = useCallback(async () => {
    setParakeetError(null);
    try {
      await invoke("delete_parakeet_model");
      setParakeetReady(false);
      // If Parakeet was the active engine, fall back to Whisper so there's
      // always a usable engine selected.
      if (defaults.transcriptionEngine === "parakeet") {
        setDefaults({ ...defaults, transcriptionEngine: "whisper" });
      }
    } catch (e) {
      setParakeetError(formatError(e));
    }
  }, [defaults, setDefaults]);

  // ── Backup: export / import / reset all settings (Settings → General) ──
  const [backupMsg, setBackupMsg] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  /**
   * Arming for the two model Delete buttons, keyed `whisper:<id>` / `llm:<id>`
   * so one piece of state serves both lists and arming one disarms the other.
   *
   * These were the most expensive single-click actions in the app. A model is
   * a multi-GB download measured in minutes or hours, the button sat directly
   * beside "Use as default" in the same `btn btn-ghost` styling, and the only
   * statement of what it did lived in a `title` nobody reads before clicking.
   *
   * The rule was already written down. CachedWebPane says it in full: a
   * multi-GB consequence gets named in the control the user clicks and never
   * only in a tooltip. Clearing the cache asks (and names the bytes); the
   * settings reset asks. The two actions that cost the most were the two that
   * did not, so this is the existing policy reaching the places it missed
   * rather than a new pattern.
   */
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  useEffect(() => {
    if (!armedDelete) return;
    // An armed button disarms itself. A confirm that stays hot is a mine: the
    // next ordinary click on this row would be the destructive one.
    // Escape is NOT handled here. CachedWebPane can own its own Escape because
    // it is a pane; this is a modal that already closes on Escape, and a second
    // window listener would fire alongside the first, disarming AND closing
    // Settings in one keystroke. The precedence lives in that one handler
    // below, where the innermost dismissable thing wins.
    const t = setTimeout(() => setArmedDelete(null), 4000);
    return () => clearTimeout(t);
  }, [armedDelete]);

  const exportSettings = useCallback(async () => {
    setBackupMsg(null);
    try {
      const path = await saveDialog({
        defaultPath: "sauce-bunny-settings.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      const payload = {
        app: "sauce-bunny", kind: "settings", version: SETTINGS_EXPORT_VERSION,
        // The TURN password is Keychain-only (r140) - the export carries the
        // field blanked so old-shape importers stay happy without the secret.
        defaults: { ...defaults, turnPassword: "" },
        keybindings: loadKeybindings(),
        sections: loadJson<Record<string, boolean>>(SECTIONS_LS_KEY, {}),
        media: loadJson<Record<string, unknown>>(DEVICE_CHOICE_KEY, {}),
      };
      await invoke("write_text_to_path", { path, text: JSON.stringify(payload, null, 2), atomic: true });
      setBackupMsg(`Saved to ${path.split("/").pop()}`);
    } catch (e) {
      setBackupMsg(formatError(e));
    }
  }, [defaults]);

  const importSettings = useCallback(async () => {
    setBackupMsg(null);
    try {
      const picked = await openDialog({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
      if (typeof picked !== "string" || !picked) return;
      const text = await invoke<string>("read_text_file_capped", { path: picked, maxBytes: 4 * 1024 * 1024 });
      const parsed = JSON.parse(text) as { kind?: string; version?: number; defaults?: unknown; keybindings?: unknown; sections?: unknown; media?: unknown };
      if (parsed.kind !== "settings") {
        setBackupMsg("That file isn't a settings export from this app.");
        return;
      }
      // Forward-compat guard: refuse a file written by a newer schema rather
      // than silently importing fields this build doesn't understand.
      if (typeof parsed.version === "number" && parsed.version > SETTINGS_EXPORT_VERSION) {
        setBackupMsg(`This file was exported by a newer app version (v${parsed.version}). Update the app, then import.`);
        return;
      }
      // Only accept plain objects (reject arrays / null) per field; a malformed
      // shape is skipped rather than written, so a bad file can't corrupt prefs.
      const isObj = (v: unknown): v is Record<string, unknown> =>
        typeof v === "object" && v !== null && !Array.isArray(v);
      const wrote: string[] = [];
      if (isObj(parsed.defaults)) { saveJson(DEFAULTS_LS_KEY, { ...parsed.defaults, turnPassword: "" }); wrote.push("preferences"); }
      if (isObj(parsed.keybindings)) { saveJson(KEYBINDINGS_STORAGE_KEY, parsed.keybindings); wrote.push("shortcuts"); }
      if (isObj(parsed.sections)) { saveJson(SECTIONS_LS_KEY, parsed.sections); wrote.push("section layout"); }
      if (isObj(parsed.media)) { saveJson(DEVICE_CHOICE_KEY, parsed.media); wrote.push("devices"); }
      if (wrote.length === 0) {
        setBackupMsg("That export didn't contain any settings to import.");
        return;
      }
      // Reload so every useState initializer re-reads the imported values.
      window.location.reload();
    } catch (e) {
      setBackupMsg(formatError(e));
    }
  }, []);

  const resetSettings = useCallback(() => {
    try {
      localStorage.removeItem(DEFAULTS_LS_KEY);
      localStorage.removeItem(KEYBINDINGS_STORAGE_KEY);
      localStorage.removeItem(SECTIONS_LS_KEY);
      localStorage.removeItem(DEVICE_CHOICE_KEY);
    } catch { /* ignore */ }
    window.location.reload();
  }, []);

  const refreshModels = useCallback(async () => {
    try {
      const list = await invoke<WhisperModel[]>("list_whisper_models");
      setModels(list);
    } catch (err) {
      // Non-fatal: backend may not yet be initialised.
      console.warn("list_whisper_models failed", err);
    }
  }, []);

  // ── Dictation microphone chooser (avfoundation inputs) ──
  const DICTATION_DEVICE_KEY = "saucebunny.dictation.device";
  const [audioInputs, setAudioInputs] = useState<AudioInputDevice[]>([]);
  const [dictDevice, setDictDevice] = useState<string>(() => loadJson<string>(DICTATION_DEVICE_KEY, "default"));
  const refreshAudioInputs = useCallback(async () => {
    try { setAudioInputs(await invoke<AudioInputDevice[]>("list_audio_input_devices")); }
    catch (err) { console.warn("list_audio_input_devices failed", err); }
  }, []);
  const pickDictDevice = useCallback((d: string) => { setDictDevice(d); saveJson(DICTATION_DEVICE_KEY, d); }, []);

  // ── AI Summary (local LLM) models — share the whisper download channel ──
  const [llmModels, setLlmModels] = useState<LlmModel[]>([]);
  const refreshLlmModels = useCallback(async () => {
    try { setLlmModels(await invoke<LlmModel[]>("list_llm_models")); }
    catch (err) { console.warn("list_llm_models failed", err); }
  }, []);
  const startLlmDownload = useCallback(async (modelId: string) => {
    setDownloadError(null);
    setDownloadingId(modelId);
    setDownloadProgress(null);
    try {
      const id = newJobId();
      downloadJobIdRef.current = id;
      await invoke("download_llm_model", { args: { model_id: modelId, job_id: id } });
    } catch (e) {
      downloadJobIdRef.current = null;
      setDownloadingId(null);
      setDownloadError(formatError(e));
    }
  }, []);
  const deleteLlmModel = useCallback(async (modelId: string) => {
    try {
      await invoke("delete_llm_model", { modelId });
      if (defaults.llmSummarizationModel === modelId) {
        const fallback = llmModels.find((m) => m.recommended && m.id !== modelId)
          ?? llmModels.find((m) => m.id !== modelId);
        if (fallback) setDefaults({ ...defaults, llmSummarizationModel: fallback.id });
      }
      refreshLlmModels();
    } catch (e) { setDownloadError(formatError(e)); }
  }, [refreshLlmModels, defaults, setDefaults, llmModels]);

  useEffect(() => {
    if (open) { refreshModels(); refreshLlmModels(); refreshAudioInputs(); }
  }, [open, refreshModels, refreshLlmModels, refreshAudioInputs]);

  // Listen for download events. Mounted ONCE — filtering goes through
  // downloadJobIdRef so a new job never has to wait for a re-subscription
  // round-trip (events fired during that gap were silently dropped).
  useEffect(() => {
    const unlistens: UnlistenFn[] = [];
    let mounted = true;
    (async () => {
      const a = await listen<ModelDownloadEvent>("model-download-progress", (e) => {
        if (!mounted || e.payload.job_id !== downloadJobIdRef.current) return;
        setDownloadProgress({
          modelId: e.payload.model_id,
          percent: e.payload.percent,
          done: e.payload.bytes_done,
          total: e.payload.bytes_total,
        });
      });
      const b = await listen<DoneEvent>("model-download-done", (e) => {
        if (!mounted || e.payload.job_id !== downloadJobIdRef.current) return;
        downloadJobIdRef.current = null;
        if (e.payload.success) {
          setDownloadingId(null);
          setDownloadProgress(null);
          setDownloadError(null);
          refreshModels();
          refreshLlmModels();
        } else {
          setDownloadError(e.payload.error ?? "Download failed");
          setDownloadingId(null);
          setDownloadProgress(null);
        }
      });
      unlistens.push(a, b);
      // Cleanup during the two awaits above saw an empty array — release the
      // late registrations here (StrictMode hits this on every modal open).
      if (!mounted) { unlistens.forEach((u) => u()); unlistens.length = 0; }
    })();
    return () => {
      mounted = false;
      unlistens.forEach((u) => u());
    };
  }, [refreshModels, refreshLlmModels]);

  // Auto-select first downloaded model if none selected.
  useEffect(() => {
    if (!models.length) return;
    const stillExists = models.some((m) => m.id === defaults.whisperModel && m.downloaded);
    if (!stillExists) {
      const firstDownloaded = models.find((m) => m.downloaded);
      if (firstDownloaded) {
        setDefaults({ ...defaults, whisperModel: firstDownloaded.id });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models]);

  async function startDownload(modelId: string) {
    setDownloadError(null);
    setDownloadingId(modelId);
    try {
      const id = newJobId();
      downloadJobIdRef.current = id; // sync, BEFORE the download can emit
      await invoke<string>("download_whisper_model", { args: { model_id: modelId, job_id: id } });
      // The backend early-returns WITHOUT emitting any event when the model
      // file already exists — resolve that here so "Downloading…" can't stick.
      const fresh = await invoke<WhisperModel[]>("list_whisper_models").catch(() => null);
      if (fresh) {
        setModels(fresh);
        if (fresh.some((m) => m.id === modelId && m.downloaded)) {
          downloadJobIdRef.current = null;
          setDownloadingId(null);
          setDownloadProgress(null);
        }
      }
    } catch (err) {
      downloadJobIdRef.current = null;
      setDownloadError(formatError(err));
      setDownloadingId(null);
    }
  }

  async function deleteModel(modelId: string) {
    try {
      await invoke("delete_whisper_model", { modelId });
      await refreshModels();
    } catch (err) {
      setDownloadError(formatError(err));
    }
  }

  function chooseModel(modelId: string) {
    // Picking a Whisper model also makes Whisper the active engine — exactly one
    // engine is ever "in use" at a time (mirrors Parakeet's "Use as default").
    setDefaults({ ...defaults, whisperModel: modelId, transcriptionEngine: "whisper" });
  }

  // Close on Esc.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      // Innermost first: an armed Delete is the thing the user most recently
      // opened, so Escape cancels that and leaves Settings where it was.
      // Closing the whole modal instead would be a surprising amount of
      // dismissal for a keystroke aimed at one button.
      if (armedDelete) { setArmedDelete(null); return; }
      onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, armedDelete]);

  // Trap Tab inside the dialog + restore focus to the opener on close.
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(open, dialogRef);

  if (!open) return null;

  async function chooseFolder() {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") {
      setDefaults({ ...defaults, folder: picked });
    }
  }

  function applyToCurrent() {
    if (!onApplyToCurrent) return;
    onApplyToCurrent({
      folder: defaults.folder,
      format: defaults.format,
      reencode: defaults.reencode,
      captions: defaults.captions,
    });
  }

  return (
    <div className="cp-modal-backdrop" onClick={onClose}>
      <div
        className="cp-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cp-modal-header">
          <h2>Settings</h2>
          <span className="crumb">{TABS.find((t) => t.id === tab)?.label}</span>
          <div className="filler" />
          <button className="cp-modal-close" onClick={onClose} title="Close (Esc)" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="cp-modal-body">
          <div className="cp-modal-tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={"cp-modal-tab" + (tab === t.id ? " active" : "")}
                onClick={() => setTab(t.id)}
              >
                <IconChevronDown size={11} className="tab-icon" style={{ transform: "rotate(-90deg)" }} />
                <span className="grow">{t.label}</span>
              </button>
            ))}
          </div>

          <div className="cp-modal-content">
            {tab === "general" && (
              <section>
                <h3 className="cp-pane-title">General</h3>
                <p className="cp-pane-sub">
                  Defaults for new clips. Apply them to the current export form below, or just save
                  them as the starting point for the next URL you fetch.
                </p>

                <CollapsibleSection id="gen-output" label="Output" open={sectionOpen("gen-output")} onToggle={() => toggleSection("gen-output")}>
                  <div className="cp-pane-row">
                    <div className="k">
                      Default folder
                      <span className="desc">Pre-fills the output folder at launch.</span>
                    </div>
                    <div className="v">
                      <div className="cp-folder" style={{ minWidth: 320 }}>
                        <span className={"path" + (defaults.folder ? "" : " empty")}>
                          {defaults.folder ?? "Not set"}
                        </span>
                        <button onClick={chooseFolder}>Browse</button>
                      </div>
                    </div>
                  </div>
                  <div className="cp-pane-row">
                    <div className="k">
                      Default quality
                      <span className="desc">Which yt-dlp format selector to use by default.</span>
                    </div>
                    <div className="v">
                      <div className="cp-segmented" style={segStyle(FORMATS.findIndex((f) => f.id === defaults.format), FORMATS.length, { minWidth: 260 })}>
                        {FORMATS.map((f) => (
                          <button
                            key={f.id}
                            className={defaults.format === f.id ? "active" : ""}
                            onClick={() => setDefaults({ ...defaults, format: f.id })}
                          >
                            {f.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="cp-pane-row">
                    <div className="k">
                      Re-encode by default
                      <span className="desc">Frame-accurate cut at the cost of speed. Off uses keyframe-aligned cut.</span>
                    </div>
                    <div className="v">
                      <button
                        className={"cp-toggle-switch" + (defaults.reencode ? " on" : "")}
                role="switch"
                aria-checked={defaults.reencode}
                aria-label="Re-encode by default"
                        onClick={() => setDefaults({ ...defaults, reencode: !defaults.reencode })}
                      />
                    </div>
                  </div>
                </CollapsibleSection>

                <CollapsibleSection id="gen-coreview" label="Co-review calls" open={sectionOpen("gen-coreview")} onToggle={() => toggleSection("gen-coreview")}>
                  <div className="cp-pane-row">
                    <div className="k">
                      Streaming quality
                      <span className="desc">
                        When you watch a file streamed from someone else&rsquo;s Mac, they encode it live for you.
                        Auto starts at 720p and drops a step if the picture keeps stalling, then climbs back once
                        it has been steady for a while. Pin a size if you know the connection. Speech stays at full
                        quality on every setting. A relayed connection is always held at the smallest size.
                      </span>
                    </div>
                    <div className="v">
                      <select
                        className="cp-select"
                        aria-label="Streaming quality"
                        value={String(streamRungPref)}
                        onChange={(e) => {
                          const v = e.target.value;
                          setStreamRungPref(v === "auto" ? "auto" : (Number(v) as 1080 | 720 | 540 | 360));
                        }}
                      >
                        <option value="auto">Auto</option>
                        <option value="1080">1080p</option>
                        <option value="720">720p</option>
                        <option value="540">540p</option>
                        <option value="360">360p</option>
                      </select>
                    </div>
                  </div>
                  <div className="cp-pane-row">
                    <div className="k">
                      Save a copy while watching
                      <span className="desc">
                        When you watch a file streamed from someone else&rsquo;s Mac, it is also copied here in
                        the background. When the copy finishes, playback switches to it, you can scrub the whole
                        file, and you keep it afterwards. The copy always gives way to the picture, so it never
                        costs you quality. Turn this off if you are short of disk space. Nothing is ever saved
                        over a relayed connection.
                      </span>
                    </div>
                    <div className="v">
                      <button
                        className={"cp-toggle-switch" + (keepEnabled ? " on" : "")}
                        role="switch"
                        aria-checked={keepEnabled}
                        aria-label="Save a copy while watching"
                        onClick={() => setKeepEnabled(!keepEnabled)}
                      />
                    </div>
                  </div>
                  <div className="cp-pane-row">
                    <div className="k">
                      STUN server
                      <span className="desc">
                        Finds your public address so webcams can reach each other through a router. This is
                        the one part of a session that contacts an outside server, and that server learns
                        your IP address. Leave it empty to stay on your local network. Default is {DEFAULT_STUN_URL}.
                      </span>
                    </div>
                    <div className="v" style={{ minWidth: 320 }}>
                      <input className="cp-input" aria-label="STUN server" placeholder="Empty: local network only" value={defaults.stunUrl}
                        onChange={(e) => setDefaults({ ...defaults, stunUrl: e.target.value })} spellCheck={false} />
                    </div>
                  </div>
                  <div className="cp-pane-row">
                    <div className="k">
                      TURN relay
                      <span className="desc">Optional. Webcams connect direct or via STUN; a TURN server helps strict networks. Empty uses STUN only. The password is stored in the macOS Keychain and never included in settings exports.</span>
                    </div>
                    <div className="v" style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 320 }}>
                      <input className="cp-input" aria-label="TURN relay URL" placeholder="turn:host:3478" value={defaults.turnUrl}
                        onChange={(e) => setDefaults({ ...defaults, turnUrl: e.target.value })} spellCheck={false} />
                      <input className="cp-input" aria-label="TURN username" placeholder="Username" value={defaults.turnUsername}
                        onChange={(e) => setDefaults({ ...defaults, turnUsername: e.target.value })} spellCheck={false} />
                      <input className="cp-input" aria-label="TURN password" placeholder="Password" type="password" value={defaults.turnPassword}
                        onChange={(e) => setDefaults({ ...defaults, turnPassword: e.target.value })} />
                    </div>
                  </div>
                </CollapsibleSection>

                <CollapsibleSection id="gen-local-playback" label="Local playback" open={sectionOpen("gen-local-playback")} onToggle={() => toggleSection("gen-local-playback")}>
                  <div className="cp-pane-row">
                    <div className="k">
                      WebCodecs decoder (experimental)
                      <span className="desc">Skip the ffmpeg pre-encode on import. Plays the original file directly via WebCodecs (VP9, AV1, HEVC, etc.). Disable if local files won't play.</span>
                    </div>
                    <div className="v">
                      <button
                        className={"cp-toggle-switch" + (defaults.useWebCodecsDecoder ? " on" : "")}
                role="switch"
                aria-checked={defaults.useWebCodecsDecoder}
                aria-label="WebCodecs decoder"
                        onClick={() => setDefaults({ ...defaults, useWebCodecsDecoder: !defaults.useWebCodecsDecoder })}
                      />
                    </div>
                  </div>
                  <div className="cp-pane-row">
                    <div className="k">
                      Audio while scrubbing
                      <span className="desc">Dragging the playhead plays short blips of the sound under the cursor, like an NLE. Applies to the WebCodecs player; follows the player volume and mute.</span>
                    </div>
                    <div className="v">
                      <button
                        className={"cp-toggle-switch" + (defaults.scrubAudio ? " on" : "")}
                        role="switch"
                        aria-checked={defaults.scrubAudio}
                        aria-label="Audio while scrubbing"
                        onClick={() => setDefaults({ ...defaults, scrubAudio: !defaults.scrubAudio })}
                      />
                    </div>
                  </div>
                  <CacheControls
                    excludePaths={props.cacheExcludePaths}
                    capGb={defaults.mediaCacheCapGb}
                    clearOnQuit={defaults.clearCacheOnQuit}
                    onRetentionChange={(patch) => setDefaults({ ...defaults, ...patch })}
                  />
                </CollapsibleSection>

                <CollapsibleSection id="gen-web-playback" label="Web playback" open={sectionOpen("gen-web-playback")} onToggle={() => toggleSection("gen-web-playback")}>
                  <div className="cp-pane-row">
                    <div className="k">
                      Stream while you watch
                      <span className="desc">On (default): stream instantly and mark in/out without waiting; export downloads only the marked clip, and a failed stream falls back to downloading. Off: download the full video before playing (slower, most reliable on flaky connections).</span>
                    </div>
                    <div className="v">
                      <button
                        className={"cp-toggle-switch" + (defaults.streamPreview ? " on" : "")}
                role="switch"
                aria-checked={defaults.streamPreview}
                aria-label="Stream while you watch"
                        onClick={() => setDefaults({ ...defaults, streamPreview: !defaults.streamPreview })}
                      />
                    </div>
                  </div>
                </CollapsibleSection>

                <CollapsibleSection id="gen-timecode" label="Timecode" open={sectionOpen("gen-timecode")} onToggle={() => toggleSection("gen-timecode")}>
                  <div className="cp-pane-row">
                    <div className="k">
                      Frame rate fallback
                      <span className="desc">Used when the source doesn't report a frame rate.</span>
                    </div>
                    <div className="v">
                      <div className="cp-segmented" style={segStyle(["24", "25", "30"].indexOf(defaults.timecode), 3, { minWidth: 200 })}>
                        {(["24","25","30"] as const).map((f) => (
                          <button
                            key={f}
                            className={defaults.timecode === f ? "active" : ""}
                            onClick={() => setDefaults({ ...defaults, timecode: f })}
                          >
                            {f} fps
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </CollapsibleSection>

                <CollapsibleSection id="gen-backup" label="Backup & reset" open={sectionOpen("gen-backup")} onToggle={() => toggleSection("gen-backup")}>
                  <div className="cp-pane-row">
                    <div className="k">
                      Settings file
                      <span className="desc">Save all your preferences + shortcuts to a file, or load them back (e.g. on another Mac).</span>
                    </div>
                    <div className="v cp-backup-actions">
                      <button className="btn btn-ghost" onClick={exportSettings}>Export…</button>
                      <button className="btn btn-ghost" onClick={importSettings}>Import…</button>
                    </div>
                  </div>
                  <div className="cp-pane-row">
                    <div className="k">
                      Hidden warnings and tips
                      <span className="desc">
                        Brings back everything you told the app not to show again: the rename
                        warning, first-run tips, and per-transcript notices. Leaves the rest of
                        your settings alone, unlike Reset to defaults.
                      </span>
                    </div>
                    <div className="v">
                      <button
                        className="btn btn-ghost"
                        disabled={hiddenCount === 0}
                        onClick={() => {
                          const n = restoreHiddenNotices();
                          setHiddenCount(0);
                          setRestored(n);
                        }}
                      >
                        {hiddenCount === 0
                          ? (restored > 0 ? `Restored ${restored}` : "Nothing hidden")
                          : `Restore ${hiddenCount}`}
                      </button>
                    </div>
                  </div>
                  <div className="cp-pane-row">
                    <div className="k">
                      Reset everything
                      <span className="desc">Restore every setting, shortcut, and panel to its default. Doesn't touch your transcripts or exports.</span>
                    </div>
                    <div className="v">
                      <button
                        className="btn btn-ghost"
                        onClick={() => { if (confirmReset) resetSettings(); else setConfirmReset(true); }}
                        onBlur={() => setConfirmReset(false)}
                      >
                        {confirmReset ? "Click again to confirm" : "Reset to defaults"}
                      </button>
                    </div>
                  </div>
                  {backupMsg && <div className="cp-source-hint muted" style={{ marginTop: 10 }}>{backupMsg}</div>}
                </CollapsibleSection>

                {onApplyToCurrent && (
                  <div style={{ marginTop: 18, display: "flex", justifyContent: "flex-end" }}>
                    <button className="btn btn-ghost" onClick={applyToCurrent}>
                      Apply to current export
                    </button>
                  </div>
                )}
              </section>
            )}

            {tab === "captions" && (
              <section>
                <h3 className="cp-pane-title">Captions</h3>
                <p className="cp-pane-sub">
                  How the on-video captions (the transport <strong>CC</strong> button) are drawn.
                  Captions are kept to two lines at the broadcast-standard ~42 characters per line.
                  Changes apply live.
                </p>
                <CollapsibleSection id="cap-style" label="Caption style" open={sectionOpen("cap-style")} onToggle={() => toggleSection("cap-style")}>
                  <div className="cp-pane-row">
                    <div className="k">
                      Preview
                      <span className="desc">A sample caption styled with your current settings.</span>
                    </div>
                    <div className="v">
                      <div className="cp-cap-preview">
                        <span
                          className="cp-cap-preview-cue"
                          style={{
                            ["--cap-size" as string]: `${defaults.captionSizePx}px`,
                            fontFamily: CAP_FONTS[defaults.captionFont],
                            color: defaults.captionColor,
                            background: `rgba(0,0,0,${defaults.captionBgOpacity})`,
                          } as React.CSSProperties}
                        >
                          The quick brown fox.
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="cp-pane-row">
                    <div className="k">
                      Size
                      <span className="desc">Caption text size in pixels.</span>
                    </div>
                    <div className="v cp-cap-range">
                      <input
                        type="range"
                        aria-label="Caption size"
                        min={CAP_SIZE_MIN}
                        max={CAP_SIZE_MAX}
                        step={1}
                        value={defaults.captionSizePx}
                        onChange={(e) => setDefaults({ ...defaults, captionSizePx: Number(e.target.value) })}
                      />
                      <input
                        type="number"
                        className="cp-cap-size-num"
                        aria-label="Caption size in pixels"
                        min={CAP_SIZE_MIN}
                        max={CAP_SIZE_MAX}
                        step={1}
                        value={defaults.captionSizePx}
                        onChange={(e) => setDefaults({ ...defaults, captionSizePx: clampCaptionSize(Number(e.target.value)) })}
                      />
                      <span className="cp-cap-range-val">px</span>
                    </div>
                  </div>
                  <div className="cp-pane-row">
                    <div className="k">
                      Font
                      <span className="desc">System fonts picked for caption legibility.</span>
                    </div>
                    <div className="v">
                      <select
                        className="cp-select cp-cap-font-select"
                        aria-label="Caption font"
                        value={defaults.captionFont}
                        onChange={(e) => setDefaults({ ...defaults, captionFont: e.target.value as CaptionFontKey })}
                      >
                        {(Object.keys(CAP_FONTS) as CaptionFontKey[]).map((key) => (
                          <option key={key} value={key} style={{ fontFamily: CAP_FONTS[key] }}>
                            {CAP_FONT_LABELS[key]}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="cp-pane-row">
                    <div className="k">Background</div>
                    <div className="v cp-cap-range">
                      <input
                        type="range"
                        aria-label="Caption background opacity"
                        min={0}
                        max={100}
                        value={Math.round(defaults.captionBgOpacity * 100)}
                        onChange={(e) => setDefaults({ ...defaults, captionBgOpacity: Number(e.target.value) / 100 })}
                      />
                      <span className="cp-cap-range-val">{Math.round(defaults.captionBgOpacity * 100)}%</span>
                    </div>
                  </div>
                  <div className="cp-pane-row">
                    <div className="k">Text colour</div>
                    <div className="v cp-cap-colors">
                      <ColorSwatches
                        colors={CAP_COLORS}
                        value={defaults.captionColor}
                        onPick={(c) => setDefaults({ ...defaults, captionColor: c })}
                        ariaLabel="Caption colour"
                      />
                    </div>
                  </div>
                </CollapsibleSection>
              </section>
            )}

            {tab === "youtube" && (
              <YouTubeSettings defaults={defaults} setDefaults={setDefaults} sectionOpen={sectionOpen} toggleSection={toggleSection} />
            )}
            {tab === "devices" && (
              <AvSettingsPane sectionOpen={sectionOpen} toggleSection={toggleSection} />
            )}

            {tab === "transcription" && (
              <section>
                <h3 className="cp-pane-title">Transcription</h3>
                <p className="cp-pane-sub">
                  Transcription runs <strong>100% on your Mac</strong>. Choose an engine,
                  download a model once, and every clip can get an .srt. Nothing leaves
                  your machine.
                </p>

                <CollapsibleSection id="tx-engine" label="Transcription engine" open={sectionOpen("tx-engine")} onToggle={() => toggleSection("tx-engine")}>
                  <CollapsibleSection
                    id="eng-whisper"
                    label="Whisper"
                    meta={defaults.transcriptionEngine === "whisper" ? "In use" : "whisper.cpp · local"}
                    summary={defaults.transcriptionEngine === "whisper" ? "In use" : "whisper.cpp · local"}
                    open={whisperOpen}
                    onToggle={() => setWhisperOpen((o) => !o)}
                  >
                  <div className="cp-models">
                    {models.length === 0 && (
                      <div className="cp-source-hint muted">Loading models…</div>
                    )}
                    {/* Float the recommended model to the top, then
                        installed-but-not-recommended (so users see
                        what's actually on their machine next), then
                        everything else. Stable sort otherwise — model
                        list arrives in size order from the backend. */}
                    {[...models].sort((a, b) => {
                      const aRec = a.id === RECOMMENDED_MODEL ? 0 : (a.downloaded ? 1 : 2);
                      const bRec = b.id === RECOMMENDED_MODEL ? 0 : (b.downloaded ? 1 : 2);
                      return aRec - bRec;
                    }).map((m) => {
                      const isDownloading = downloadingId === m.id;
                      const progress = isDownloading && downloadProgress?.modelId === m.id ? downloadProgress : null;
                      const isSelected = defaults.whisperModel === m.id;
                      // "Active" = this is the selected model AND Whisper is the
                      // engine in use. Cross-engine exclusivity: when Parakeet is
                      // active, no Whisper row shows "In use".
                      const isActive = isSelected && defaults.transcriptionEngine === "whisper";
                      const isRecommended = m.id === RECOMMENDED_MODEL;
                      return (
                        <div key={m.id} className={"cp-model-row" + (isActive ? " selected" : "")}>
                          <div className="cp-model-info-wrap">
                            <div className="cp-model-head">
                              <IconSparkles size={13} stroke="var(--fg-3)" />
                              <span className="name">{m.name}</span>
                              <span className="size">{formatMB(m.size_bytes)}</span>
                              {isRecommended && <span className="badge recommended">Recommended</span>}
                              {m.downloaded && <span className="badge installed">Installed</span>}
                              {isActive && m.downloaded && <span className="badge selected">In use</span>}
                              <ModelInfoPopover id={m.id} />
                            </div>
                            {progress && (
                              <div className="cp-model-progress">
                                <div className="bar"><span style={{ width: `${progress.percent}%` }} /></div>
                                <span className="meta">
                                  {progress.percent.toFixed(0)}%
                                  {progress.total > 0 && ` · ${formatMB(progress.done)} / ${formatMB(progress.total)}`}
                                </span>
                              </div>
                            )}
                          </div>
                          <div className="cp-model-actions">
                            {!m.downloaded && (
                              <button
                                className="btn btn-ghost"
                                onClick={() => startDownload(m.id)}
                                disabled={!!downloadingId}
                              >
                                {isDownloading ? "Downloading…" : "Download"}
                              </button>
                            )}
                            {m.downloaded && !isActive && (
                              <button className="btn btn-ghost" onClick={() => chooseModel(m.id)}>
                                Use as default
                              </button>
                            )}
                            {m.downloaded && (
                              <button
                                className={"btn btn-ghost" + (armedDelete === `whisper:${m.id}` ? " armed" : "")}
                                onClick={() => {
                                  if (armedDelete === `whisper:${m.id}`) { setArmedDelete(null); deleteModel(m.id); return; }
                                  setArmedDelete(`whisper:${m.id}`);
                                }}
                                title={`Remove this model file from disk. Re-downloading it is ${formatBytes(m.size_bytes)}.`}
                                aria-label={armedDelete === `whisper:${m.id}`
                                  ? `Confirm deleting ${m.name}, ${formatBytes(m.size_bytes)}`
                                  : `Delete ${m.name}, ${formatBytes(m.size_bytes)}`}
                              >
                                {armedDelete === `whisper:${m.id}` ? `Delete ${formatBytes(m.size_bytes)}?` : "Delete"}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {downloadError && (
                    <div className="cp-source-hint err" style={{ marginTop: 12 }}>
                      {downloadError}
                    </div>
                  )}
                  </CollapsibleSection>
                  <CollapsibleSection
                    id="eng-parakeet"
                    label="Parakeet"
                    meta={defaults.transcriptionEngine === "parakeet" ? "In use" : "NVIDIA · word-level"}
                    summary={defaults.transcriptionEngine === "parakeet" ? "In use" : "NVIDIA · word-level"}
                    open={parakeetOpen}
                    onToggle={() => setParakeetOpen((o) => !o)}
                  >
                    <div className="cp-source-hint muted" style={{ lineHeight: 1.6, marginBottom: 12 }}>
                      <strong>Parakeet TDT v3</strong> (NVIDIA) runs fully on-device on Apple
                      Silicon via Core ML and emits <strong>word-level</strong> timestamps.
                      Multilingual, with tighter caption sync than Whisper's segment timing.
                      One-time download is about 0.5 GB.
                    </div>
                    {(() => {
                      // Parakeet has a single model; "active" mirrors the Whisper
                      // row — installed AND the engine in use.
                      const parakeetActive = parakeetReady === true && defaults.transcriptionEngine === "parakeet";
                      return (
                    <div className={"cp-model-row" + (parakeetActive ? " selected" : "")}>
                      <div className="cp-model-info-wrap">
                        <div className="cp-model-head">
                          <IconSparkles size={13} stroke="var(--fg-3)" />
                          <span className="name">Parakeet TDT v3</span>
                          <span className="size">≈0.5 GB</span>
                          {parakeetReady && <span className="badge installed">Installed</span>}
                          {parakeetActive && <span className="badge selected">In use</span>}
                        </div>
                      </div>
                      <div className="cp-model-actions">
                        {parakeetReady === null ? (
                          <span className="size">checking…</span>
                        ) : !parakeetReady ? (
                          <button
                            className="btn btn-ghost"
                            onClick={downloadParakeet}
                            disabled={parakeetBusy}
                          >
                            {parakeetBusy ? "Downloading…" : "Download"}
                          </button>
                        ) : (
                          <>
                            {!parakeetActive && (
                              <button
                                className="btn btn-ghost"
                                onClick={() => setDefaults({ ...defaults, transcriptionEngine: "parakeet" })}
                              >
                                Use as default
                              </button>
                            )}
                            {/* Armed like the other two model deletes. The size
                                is deliberately NOT in the label: Parakeet has
                                no model list, so it carries no size_bytes, and
                                the only figure available is the "~0.5 GB" that
                                transcript.rs states in two places already. A
                                third copy in a third language is exactly the
                                drift duplicated-tables-contract exists to stop,
                                and the arming does the load-bearing work here
                                without it. */}
                            <button
                              className={"btn btn-ghost" + (armedDelete === "parakeet" ? " armed" : "")}
                              onClick={() => {
                                if (armedDelete === "parakeet") { setArmedDelete(null); deleteParakeet(); return; }
                                setArmedDelete("parakeet");
                              }}
                              title="Remove the Parakeet model from disk. It downloads again the next time you pick it."
                              aria-label={armedDelete === "parakeet"
                                ? "Confirm deleting the Parakeet model"
                                : "Delete the Parakeet model"}
                            >
                              {armedDelete === "parakeet" ? "Delete the model?" : "Delete"}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                      );
                    })()}
                    {parakeetBusy && (
                      <div className="cp-source-hint muted" style={{ marginTop: 10 }}>
                        Downloading the Parakeet model. This runs once and can take a few
                        minutes. You can keep using the app meanwhile.
                      </div>
                    )}
                    {parakeetError && (
                      <div className="cp-source-hint err" style={{ marginTop: 10 }}>
                        {parakeetError}
                      </div>
                    )}
                  </CollapsibleSection>
                </CollapsibleSection>

                <CollapsibleSection id="tx-language" label="Language" open={sectionOpen("tx-language")} onToggle={() => toggleSection("tx-language")}>
                  <div className="cp-pane-row">
                    <div className="k">
                      Language
                      <span className="desc">Whisper transcription language. Auto-detect works for most sources.</span>
                    </div>
                    <div className="v">
                      <select
                        className="cp-select"
                        aria-label="Language"
                        value={defaults.transcriptionLanguage}
                        onChange={(e) => setDefaults({ ...defaults, transcriptionLanguage: e.target.value })}
                      >
                        {TRANSCRIPTION_LANGUAGES.map((l) => (
                          <option key={l.code} value={l.code}>{l.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {/* `*.en` Whisper models are English-only — whisper-cli would
                      silently force English, so surface the mismatch right where
                      the language is picked (the backend also logs it at run
                      time; see warn_if_english_only_mismatch in transcript.rs). */}
                  {defaults.whisperModel.endsWith(".en")
                    && defaults.transcriptionLanguage !== "auto"
                    && defaults.transcriptionLanguage !== "en" && (
                    <div className="cp-source-hint warn" style={{ marginTop: 8 }}>
                      The selected model is English-only. Pick a multilingual model for other languages.
                    </div>
                  )}
                </CollapsibleSection>

                <CollapsibleSection id="tx-library" label="Transcript library" open={sectionOpen("tx-library")} onToggle={() => toggleSection("tx-library")}>
                  <p style={{ fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-3)", lineHeight: 1.6, margin: "0 0 10px" }}>
                    All generated transcripts land here, sub-organized by month.
                    Kept separate from your clip-export folder.
                  </p>
                  <div className="cp-folder-row">
                    <span className="cp-folder-path" title={defaults.transcriptLibrary}>
                      {defaults.transcriptLibrary || "(resolving default…)"}
                    </span>
                    <button
                      className="btn btn-ghost"
                      onClick={async () => {
                        try {
                          const picked = await openDialog({
                            directory: true,
                            multiple: false,
                            title: "Choose transcript library folder",
                          });
                          if (typeof picked === "string" && picked) {
                            setDefaults({ ...defaults, transcriptLibrary: picked });
                          }
                        } catch { /* user cancelled */ }
                      }}
                    >
                      Change…
                    </button>
                    <button
                      className="btn btn-ghost"
                      title="Open the library in Finder"
                      onClick={() => {
                        if (!defaults.transcriptLibrary) return;
                        // Create the folder lazily before revealing so a
                        // user who's never generated a transcript still
                        // sees the right thing in Finder.
                        invoke("ensure_dir_exists", { path: defaults.transcriptLibrary })
                          .then(() => invoke("reveal_in_finder", { path: defaults.transcriptLibrary }))
                          .catch(() => { /* ignore */ });
                      }}
                    >
                      <IconReveal size={12} />
                    </button>
                    <button
                      className="btn btn-ghost"
                      title="Reset to ~/Documents/Sauce Bunny/Transcripts/"
                      onClick={async () => {
                        try {
                          const p = await invoke<string>("default_transcript_library_path");
                          if (p) setDefaults({ ...defaults, transcriptLibrary: p });
                        } catch { /* ignore */ }
                      }}
                    >
                      Reset
                    </button>
                  </div>
                </CollapsibleSection>

                <CollapsibleSection id="tx-dictation" label="Dictation microphone" open={sectionOpen("tx-dictation")} onToggle={() => toggleSection("tx-dictation")}>
                  <p style={{ fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-3)", lineHeight: 1.6, margin: "0 0 10px" }}>
                    The mic the review composer records from when you dictate a comment.
                    Leave on <em>System default</em> unless that picks up the wrong
                    input (e.g. a capture card).
                  </p>
                  <div className="cp-pane-row">
                    <div className="k">
                      Microphone
                      <span className="desc">avfoundation audio input.</span>
                    </div>
                    <div className="v" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <select
                        className="cp-select"
                        aria-label="Microphone"
                        value={dictDevice}
                        onChange={(e) => pickDictDevice(e.target.value)}
                      >
                        <option value="default">System default</option>
                        {audioInputs.map((d) => (
                          // Store by NAME (avfoundation matches names too) — indices
                          // shift between launches, names don't.
                          <option key={d.index} value={d.name}>{d.name}</option>
                        ))}
                      </select>
                      <button className="btn btn-ghost" onClick={refreshAudioInputs} title="Rescan audio inputs">Rescan</button>
                    </div>
                  </div>
                </CollapsibleSection>

                <CollapsibleSection id="tx-diarization" label="Speaker diarization" open={sectionOpen("tx-diarization")} onToggle={() => toggleSection("tx-diarization")}>
                  <p style={{ fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-3)", lineHeight: 1.6, margin: "0 0 10px" }}>
                    When <em>Detect speakers</em> is on in the sidebar, the FluidAudio sidecar
                    runs after Whisper and stitches speaker labels into the SRT
                    (<code>SPEAKER_00</code>, <code>SPEAKER_01</code>, etc., renameable in the
                    transcript viewer). First run downloads a few hundred MB of models.
                    Pre-warm here so the first real transcript doesn't pause.
                  </p>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    {diarizerPrepareState === "running" ? (
                      <>
                        <button className="btn btn-ghost" onClick={onCancelDiarizerPrepare}>
                          Cancel download
                        </button>
                        <span style={{ fontSize: 11, color: "var(--fg-3)" }}>
                          Downloading speaker models…
                        </span>
                      </>
                    ) : diarizerReady ? (
                      <>
                        <button className="btn btn-ghost" onClick={onPrepareDiarizerModels}>
                          Re-download models
                        </button>
                        <span className="cp-settings-ready">
                          ✓ Models cached locally
                        </span>
                      </>
                    ) : (
                      <>
                        <button className="btn btn-primary" onClick={onPrepareDiarizerModels}>
                          Download speaker models
                        </button>
                        <span style={{ fontSize: 11, color: "var(--fg-3)" }}>
                          Not downloaded · happens on first diarization otherwise
                        </span>
                      </>
                    )}
                  </div>
                  {diarizerPrepareState === "error" && diarizerPrepareError && (
                    <div className="cp-source-hint err" style={{ marginTop: 8 }}>
                      {diarizerPrepareError}
                    </div>
                  )}
                </CollapsibleSection>

                <CollapsibleSection id="tx-how" label="How it works" open={sectionOpen("tx-how")} onToggle={() => toggleSection("tx-how")}>
                  <p style={{ fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-3)", lineHeight: 1.6, margin: 0 }}>
                    Click <em>Generate transcript</em> on the source card. yt-dlp grabs the audio for
                    your in→out range only (not the whole video), pipes it through ffmpeg, and
                    whisper-cli writes <code>&lt;filename&gt;.srt</code> next to where your clip would
                    save. Larger models = better accuracy, longer transcribe time.
                  </p>
                </CollapsibleSection>
              </section>
            )}

            {tab === "ai-summary" && (
              <section>
                <h3 className="cp-pane-title">AI Summary</h3>
                <p className="cp-pane-sub">
                  Summarize and chat with transcripts using a local AI model. Runs entirely on
                  your Mac via llama.cpp (Metal); nothing leaves the machine.
                  Pick the model that fits your Mac's memory.
                </p>

                <CollapsibleSection id="ai-model" label="Model" open={sectionOpen("ai-model")} onToggle={() => toggleSection("ai-model")}>
                  <div className="cp-model-list">
                    {llmModels.map((m) => {
                      const isSel = defaults.llmSummarizationModel === m.id;
                      const prog = downloadProgress?.modelId === m.id ? downloadProgress : null;
                      return (
                        <div key={m.id} className={"cp-model-row" + (isSel && m.downloaded ? " selected" : "")}>
                          <div className="cp-model-info-wrap">
                            <div className="cp-model-head">
                              <IconSparkles size={13} stroke="var(--fg-3)" />
                              <span className="name">{m.name}</span>
                              <span className="size">{formatMB(m.size_bytes)}</span>
                              {m.recommended && <span className="badge recommended">Recommended</span>}
                              {m.downloaded && <span className="badge installed">Installed</span>}
                              {isSel && m.downloaded && <span className="badge selected">Default</span>}
                            </div>
                            <div className="cp-model-blurb">{m.blurb}</div>
                            {prog && (
                              <div className="cp-model-progress">
                                <div className="bar"><span style={{ width: `${prog.percent}%` }} /></div>
                                <span className="meta">
                                  {prog.percent.toFixed(0)}%
                                  {prog.total > 0 && ` · ${formatMB(prog.done)} / ${formatMB(prog.total)}`}
                                </span>
                              </div>
                            )}
                          </div>
                          <div className="cp-model-actions">
                            {!m.downloaded ? (
                              <button className="btn btn-primary" disabled={!!downloadingId} onClick={() => startLlmDownload(m.id)}>
                                {downloadingId === m.id ? "Downloading…" : "Download"}
                              </button>
                            ) : isSel ? (
                              <span className="cp-ytdlp-version">In use</span>
                            ) : (
                              <button className="btn btn-primary" onClick={() => setDefaults({ ...defaults, llmSummarizationModel: m.id })}>
                                Use as default
                              </button>
                            )}
                            {m.downloaded && (
                              <button
                                className={"btn btn-ghost" + (armedDelete === `llm:${m.id}` ? " armed" : "")}
                                onClick={() => {
                                  if (armedDelete === `llm:${m.id}`) { setArmedDelete(null); deleteLlmModel(m.id); return; }
                                  setArmedDelete(`llm:${m.id}`);
                                }}
                                title={`Remove this model file from disk. Re-downloading it is ${formatBytes(m.size_bytes)}.`}
                                aria-label={armedDelete === `llm:${m.id}`
                                  ? `Confirm deleting ${m.name}, ${formatBytes(m.size_bytes)}`
                                  : `Delete ${m.name}, ${formatBytes(m.size_bytes)}`}
                              >
                                {armedDelete === `llm:${m.id}` ? `Delete ${formatBytes(m.size_bytes)}?` : "Delete"}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {downloadError && <div className="cp-source-hint err" style={{ marginTop: 12 }}>{downloadError}</div>}
                </CollapsibleSection>

                <CollapsibleSection id="ai-style" label="Summary style" open={sectionOpen("ai-style")} onToggle={() => toggleSection("ai-style")}>
                  <div className="cp-pane-row">
                    <div className="k">
                      Format
                      <span className="desc">How answers are structured.</span>
                    </div>
                    <div className="v">
                      <div className="cp-segmented" style={segStyle(["bullets", "numbered", "prose"].indexOf(defaults.summaryFormat), 3, { minWidth: 270 })}>
                        {(["bullets", "numbered", "prose"] as const).map((f) => (
                          <button
                            key={f}
                            className={defaults.summaryFormat === f ? "active" : ""}
                            onClick={() => setDefaults({ ...defaults, summaryFormat: f })}
                          >
                            {f === "bullets" ? "Bullets" : f === "numbered" ? "Numbered" : "Prose"}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="cp-pane-row">
                    <div className="k">
                      Length
                      <span className="desc">Roughly how much detail the model includes.</span>
                    </div>
                    <div className="v">
                      <div className="cp-segmented" style={segStyle(["brief", "standard", "detailed"].indexOf(defaults.summaryLength), 3, { minWidth: 270 })}>
                        {(["brief", "standard", "detailed"] as const).map((l) => (
                          <button
                            key={l}
                            className={defaults.summaryLength === l ? "active" : ""}
                            onClick={() => setDefaults({ ...defaults, summaryLength: l })}
                          >
                            {l[0].toUpperCase() + l.slice(1)}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </CollapsibleSection>
              </section>
            )}

            {tab === "ai-apis" && <AiApiSettings />}

            {tab === "commands" && (
              <section>
                <h3 className="cp-pane-title">Shortcuts</h3>
                <p className="cp-pane-sub">
                  Every action the app exposes, plus the source-monitor keymap. Open the
                  palette anywhere with <kbd>⌘</kbd><kbd>K</kbd>.
                </p>

                {/* Editable keymap — Record re-binds any action; transport &
                    marking keys release while a text field or the timecode HUD
                    is focused so typing never scrubs the video. */}
                <CollapsibleSection id="cmd-shortcuts" label="Keyboard shortcuts" open={sectionOpen("cmd-shortcuts")} onToggle={() => toggleSection("cmd-shortcuts")}>
                  <KeybindingEditor overrides={keybindings} onChange={setKeybindings} />
                </CollapsibleSection>

                <CollapsibleSection id="cmd-all" label="All commands" open={sectionOpen("cmd-all")} onToggle={() => toggleSection("cmd-all")}>
                {(() => {
                  const list = commands ?? [];
                  if (list.length === 0) {
                    return <p className="cp-pane-sub">No commands registered.</p>;
                  }
                  // Group preserving registration order — App.tsx already
                  // groups them in a sensible reading order (Source first,
                  // App last) so we don't re-sort.
                  const byGroup = new Map<string, Command[]>();
                  for (const c of list) {
                    const bucket = byGroup.get(c.group);
                    if (bucket) bucket.push(c);
                    else byGroup.set(c.group, [c]);
                  }
                  return (
                    <div className="cp-shortcuts-grid">
                      {Array.from(byGroup.entries()).map(([group, cmds]) => (
                        <div className="cp-shortcut-cat" key={group}>
                          <div className="cp-shortcut-cat-title">{group}</div>
                          {cmds.map((c) => (
                            <div className="cp-shortcut-row" key={c.id}>
                              <span className="lbl">
                                {c.label}
                                {c.description && (
                                  <span style={{
                                    display: "block",
                                    fontSize: 11,
                                    color: "var(--text-muted, #888)",
                                    marginTop: 2,
                                  }}>
                                    {c.description}
                                  </span>
                                )}
                              </span>
                              <span className="keys">
                                {c.hotkey
                                  ? <kbd className={c.hotkey.length > 1 ? "sym" : ""}>{c.hotkey}</kbd>
                                  : <span className="cp-cmd-empty-key">—</span>}
                              </span>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  );
                })()}
                </CollapsibleSection>
              </section>
            )}

            {tab === "about" && (
              <section>
                <div className="cp-about-hero">
                  {/* Canonical brand mark (src/assets/saucebunny.svg) — same
                      asset the nav rail renders; no placeholder tiles. */}
                  <div className="mark">
                    <img src={logoUrl} alt="" draggable={false} />
                  </div>
                  <div>
                    <div className="cp-about-name">
                      Sauce Bunny <span className="ver">{appVersion ? `v${appVersion} (${__BUILD_NUMBER__})` : ""}</span>
                    </div>
                    <div className="cp-about-tag">
                      Local-first transcription, diarization and review for video and audio.
                      Everything runs on this Mac.
                    </div>
                  </div>
                </div>

                <UpdateRow />

                <div className="cp-about-grid">
                  <div className="cp-about-row"><span className="k">Build</span><span className="v">{EXPECTED_BACKEND_BUILD_ID}</span></div>
                  <div className="cp-about-row"><span className="k">Engine</span><span className="v">Tauri 2 + Wry</span></div>
                  <div className="cp-about-row"><span className="k">UI</span><span className="v">React 18 + Vite 6</span></div>
                  <div className="cp-about-row"><span className="k">Sidecars</span><span className="v">yt-dlp · ffmpeg · whisper-cli · diarizer · llama-server</span></div>
                  <div className="cp-about-row">
                    <span className="k">Transcripts</span>
                    <span className="v">yt-dlp captions · whisper.cpp · SpeakerKit</span>
                  </div>
                  <div className="cp-about-row">
                    <span className="k">License</span>
                    <span className="v">{SAUCE_BUNNY.license} · open source</span>
                  </div>
                  {/* "no cloud" stopped being true when the opt-in cloud-AI
                      path landed. It is still off unless the user configures
                      a key, and saying so is more reassuring than a claim
                      they can catch out. */}
                  <div className="cp-about-row"><span className="k">Data</span><span className="v">no accounts · no telemetry · cloud AI off unless you add a key</span></div>
                  <div className="cp-about-row">
                    <span className="k">Model dir</span>
                    <span className="v"><button className="btn btn-ghost" style={{ height: 24, fontSize: 11 }} onClick={async () => {
                      try {
                        const list = await invoke<WhisperModel[]>("list_whisper_models");
                        const first = list.find((m) => m.downloaded);
                        if (first?.path) await invoke("reveal_in_finder", { path: first.path });
                      } catch { /* ignore */ }
                    }}>
                      <IconReveal size={11} /> Reveal in Finder
                    </button></span>
                  </div>
                </div>

                {/* The full network-call list. It had gone stale in both
                    directions - it still said the app makes no cloud calls
                    at all, and it never mentioned co-review, which is the
                    one place bytes actually leave the Mac. */}
                <p style={{ marginTop: 18, fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-4)", lineHeight: 1.6 }}>
                  Use it on content you have the rights to clip. Bundled binaries are tested releases of
                  yt-dlp, ffmpeg, whisper.cpp and llama.cpp, all run locally. No telemetry, ever. The app
                  reaches the network only when you ask it to: the web source you fetch, the thumbnail URL
                  when you save or copy a poster, HuggingFace when you download a Whisper model, GitHub when
                  you check for an update, a live co-review session with a peer, and a cloud model only if
                  you have added your own API key under AI APIs.
                </p>

                {/* A pointer, not a second copy of the list. The credits get
                    their own tab because twelve projects with sponsor links
                    would bury the six facts above them. */}
                <div className="cp-about-credits-cta">
                  <span>
                    Most of this app is other people&rsquo;s work, and it is {SAUCE_BUNNY.license}-licensed itself.
                  </span>
                  <button className="btn btn-ghost" onClick={() => setTab("credits")}>
                    <IconHeart size={12} /> Built on &amp; sponsors
                  </button>
                </div>
              </section>
            )}

            {tab === "credits" && <OpenSourceCredits />}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The user-clearable cache categories (r112), in display order. */
const CACHE_CATEGORIES = [
  { id: "downloads", label: "Downloads", hint: "Full copies of web sources, reused on re-open" },
  { id: "audio", label: "Audio", hint: "Cached audio tracks for instant transcription" },
  { id: "meta", label: "Metadata", hint: "Saved titles, durations, and stream links" },
  { id: "thumbnails", label: "Thumbnails", hint: "Poster frames for imported files" },
  // Listed LAST and worded as a warning, because it is the one category here
  // that does not come back. Everything above is derived - re-download, re-
  // extract, re-read. A received file came off a peer's machine and the
  // session is over. It is also exempt from the size cap for that reason, so
  // this row is the only place it is visible or clearable at all.
  { id: "transfers", label: "Received files", hint: "Files sent to you in a co-review session. These cannot be re-downloaded" },
] as const;

/**
 * Settings row that surfaces cache sizes + user-controlled purges.
 * Cache = `saucebunny-*` in `app_cache_dir()`: the persistent media cache
 * (`saucebunny-media/` — downloads, audio, metadata; reused across sessions,
 * exempt from the startup sweep), keyed thumbnails, and short-lived working
 * files. Files NOT under that prefix (e.g. whisper-models/) are never
 * touched. Per-category sizes + Clear buttons — no automatic size caps,
 * just visibility and control (everything regenerates on demand).
 */
function CacheControls({ excludePaths, capGb, clearOnQuit, onRetentionChange }: {
  excludePaths?: string[];
  /** Current media-cache size cap in GB; 0 = no cap. */
  capGb: number;
  /** Whether the media cache is emptied on quit. */
  clearOnQuit: boolean;
  /** Persist retention prefs into Defaults (localStorage). */
  onRetentionChange: (patch: { mediaCacheCapGb?: number; clearCacheOnQuit?: boolean }) => void;
}) {
  // CacheStats now comes from the canonical Rust definition (r49 +
  // r50). The inline-anonymous-type pattern was a workaround from
  // before the bindings existed.
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [cachePath, setCachePath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Why the clear-on-quit switch snapped back, if it did. */
  const [quitErr, setQuitErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await invoke<CacheStats>("get_cache_stats");
      setStats(s);
      if (s.path) setCachePath(s.path);
    } catch (e) {
      // get_cache_stats was migrated to Result<_, AppError> in r50.
      // formatError() handles both the new shape and any pre-migration
      // String errors that might come back from other commands.
      console.error("get_cache_stats:", formatError(e));
      setStats(null);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const onClearAll = async () => {
    if (!stats || stats.file_count === 0) return;
    if (!confirm(`Delete ${stats.file_count} cached file${stats.file_count === 1 ? "" : "s"} (${formatBytes(stats.bytes_total)})? This won't affect your exported clips.`)) return;
    setBusy(true);
    try {
      await invoke<number>("clear_all_cache", { exclude: excludePaths ?? [] });
    } catch (err) {
      console.warn("clear_all_cache failed", err);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const onClearCategory = async (category: string) => {
    setBusy(true);
    try {
      await invoke<number>("clear_cache_category", { category, exclude: excludePaths ?? [] });
    } catch (err) {
      console.warn("clear_cache_category failed", err);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const onCapChange = async (gb: number) => {
    onRetentionChange({ mediaCacheCapGb: gb });
    if (gb <= 0) return;
    // Apply immediately so picking a cap visibly shrinks the numbers above
    // instead of silently waiting for the next launch.
    setBusy(true);
    try {
      await invoke<number>("enforce_media_cache_cap", {
        maxBytes: gb * 1024 * 1024 * 1024,
        exclude: excludePaths ?? [],
      });
    } catch (err) {
      console.warn("enforce_media_cache_cap failed", err);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const onQuitToggle = (next: boolean) => {
    onRetentionChange({ clearCacheOnQuit: next });
    setQuitErr(null);
    // The marker file must exist before quit; localStorage alone is
    // invisible to the Rust exit handler (the webview is gone by then).
    invoke("set_clear_cache_on_quit", { enabled: next }).catch((err) => {
      // The marker IS the setting. Without it the exit handler finds nothing
      // and keeps the cache, so leaving the switch on would be the UI telling
      // the user their downloads get cleared when they will not - and this is
      // the setting people reach for precisely because they would rather not
      // leave media on disk. Put it back where it really is, and say why:
      // console.warn alone is invisible in a packaged app.
      console.warn("set_clear_cache_on_quit failed", err);
      onRetentionChange({ clearCacheOnQuit: !next });
      setQuitErr(formatError(err));
    });
  };

  const sizeLabel = stats ? formatBytes(stats.bytes_total) : "—";
  const countLabel = stats ? `${stats.file_count} file${stats.file_count === 1 ? "" : "s"}` : "checking…";

  return (
    <div className="cp-pane-row">
      <div className="k">
        Cache
        <span className="desc">Downloaded copies, audio tracks, saved details, thumbnails, and working files. Safe to clear; everything regenerates and exported clips are untouched.</span>
      </div>
      <div className="v cp-cache-controls">
        <span className="cp-cache-total">
          {countLabel} · {sizeLabel}
        </span>
        <div className="cp-cache-cats">
          {CACHE_CATEGORIES.map(({ id, label, hint }) => {
            const cat = stats?.[id];
            return (
              <div className="cp-cache-cat" key={id} title={hint}>
                <span className="cp-cache-cat-name">{label}</span>
                <span className="cp-cache-cat-size">
                  {cat ? `${cat.file_count} · ${formatBytes(cat.bytes_total)}` : "—"}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-compact"
                  onClick={() => onClearCategory(id)}
                  disabled={busy || !cat || cat.file_count === 0}
                >
                  Clear
                </button>
              </div>
            );
          })}
        </div>
        <div className="cp-cache-retention">
          <label className="cp-cache-ret-item">
            <span className="cp-cache-ret-label">Size limit</span>
            <select
              className="cp-select"
              value={String(capGb)}
              onChange={(e) => { void onCapChange(Number(e.target.value)); }}
              disabled={busy}
            >
              <option value="0">Off, keep everything</option>
              <option value="2">2 GB</option>
              <option value="5">5 GB</option>
              <option value="10">10 GB</option>
              <option value="25">25 GB</option>
            </select>
          </label>
          <div className="cp-cache-ret-item">
            <span className="cp-cache-ret-label">Clear on quit</span>
            <button
              type="button"
              className={"cp-toggle-switch" + (clearOnQuit ? " on" : "")}
              role="switch"
              aria-checked={clearOnQuit}
              aria-label="Clear cache on quit"
              onClick={() => onQuitToggle(!clearOnQuit)}
            />
          </div>
        </div>
        {quitErr && (
          <span className="cp-cache-ret-note cp-cache-ret-err" role="alert">
            Clear on quit could not be turned on: {quitErr}
          </span>
        )}
        <span className="cp-cache-ret-note">
          With a size limit, the oldest files are removed first; whatever is on screen stays.
          Cached downloads include videos fetched with your browser sign-in, so set a limit or
          clear on quit if you'd rather not keep those on disk.
        </span>
        {cachePath && (
          // Cache path visibility (r39 — user asked for "set a cache
          // folder in settings"). Setting a custom path is r40 work
          // (needs Rust to honour the override on every cache write);
          // for now we surface the OS default + a Reveal so users can
          // SEE where files land.
          <span className="cp-cache-path" title={cachePath}>
            {cachePath}
          </span>
        )}
        <div className="cp-cache-actions">
          {cachePath && (
            <button
              type="button"
              className="btn btn-ghost btn-compact"
              onClick={() => invoke("reveal_in_finder", { path: cachePath }).catch(() => { /* ignore */ })}
              title="Open cache folder in Finder"
            >
              Reveal
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-compact"
            onClick={onClearAll}
            disabled={busy || !stats || stats.file_count === 0}
          >
            {busy ? "Clearing…" : "Clear all"}
          </button>
        </div>
      </div>
    </div>
  );
}


