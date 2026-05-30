import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { IconChevronDown, IconReveal, IconSparkles, IconInfo } from "./Icons";
import type {
  ExportOpts, FormatId, ModelDownloadEvent, WhisperModel, DoneEvent,
  CacheStats,
} from "../types";
import type { Command } from "../lib/commands";
import { formatError } from "../lib/error-format";
import { YouTubeSettings } from "./YouTubeSettings";

type TabId = "general" | "transcription" | "youtube" | "shortcuts" | "commands" | "about";

export type Defaults = {
  folder: string | null;
  format: FormatId;
  reencode: boolean;
  captions: boolean;
  timecode: "24" | "25" | "30";
  whisperModel: string; // e.g. "base.en"
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
};

type Props = {
  open: boolean;
  onClose: () => void;
  defaults: Defaults;
  setDefaults: (d: Defaults) => void;
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
  { id: "youtube",       label: "YouTube" },
  { id: "transcription", label: "Transcription" },
  { id: "shortcuts",     label: "Shortcuts" },
  { id: "commands",      label: "Commands" },
  { id: "about",         label: "About" },
];

const SHORTCUTS: { category: string; items: { label: string; keys: string[] }[] }[] = [
  {
    category: "Transport",
    items: [
      { label: "Play / pause",       keys: ["Space"] },
      { label: "Play / pause (alt)", keys: ["K"] },
      { label: "Skip back 5s",       keys: ["J"] },
      { label: "Skip forward 5s",    keys: ["L"] },
      { label: "Step 1 frame back",  keys: [",", "←"] },
      { label: "Step 1 frame forward", keys: [".", "→"] },
      { label: "Step 1 second back", keys: ["⇧", "←"] },
      { label: "Step 1 second forward", keys: ["⇧", "→"] },
      { label: "Jump to start",      keys: ["Home"] },
      { label: "Jump to end",        keys: ["End"] },
    ],
  },
  {
    category: "Marking",
    items: [
      { label: "Mark in",            keys: ["I"] },
      { label: "Mark out",           keys: ["O"] },
      { label: "Clear marks",        keys: ["G"] },
      { label: "Go to in",           keys: ["Q"] },
      { label: "Go to out",          keys: ["W"] },
    ],
  },
  {
    category: "Source",
    items: [
      { label: "Fetch URL",          keys: ["⌘", "↩"] },
    ],
  },
  {
    category: "Export",
    items: [
      { label: "Export clip",        keys: ["⌥", "E"] },
    ],
  },
  {
    category: "Window",
    items: [
      { label: "Toggle pipeline log",keys: ["⌘", "\\"] },
      { label: "Open settings",      keys: ["⌘", ","] },
      { label: "Close settings",     keys: ["Esc"] },
    ],
  },
];

const FORMATS: { id: FormatId; label: string }[] = [
  { id: "4k",    label: "4K" },
  { id: "1080",  label: "1080p" },
  { id: "720",   label: "720p" },
  { id: "audio", label: "Audio" },
];

function formatMB(bytes: number): string {
  if (!isFinite(bytes) || bytes <= 0) return "—";
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}

const RECOMMENDED_MODEL = "base.en";

type ModelInfo = {
  tagline: string;
  accuracy: string;
  speed: string;
  whenToUse: string;
};
const MODEL_INFO: Record<string, ModelInfo> = {
  "tiny.en": {
    tagline: "Fastest — lowest accuracy.",
    accuracy: "Decent for clean speech; struggles with accents, jargon, overlapping speakers.",
    speed: "~32× realtime on Apple Silicon.",
    whenToUse: "Quick rough drafts when you'll hand-edit the transcript anyway.",
  },
  "base.en": {
    tagline: "Balanced — recommended starting point.",
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
    tagline: "High accuracy — slow.",
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
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
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
    open, onClose, defaults, setDefaults, onApplyToCurrent, initialTab, commands,
    diarizerReady, diarizerPrepareState, diarizerPrepareError,
    onPrepareDiarizerModels, onCancelDiarizerPrepare,
  } = props;
  const [tab, setTab] = useState<TabId>(initialTab ?? "general");

  // When opening, jump to requested tab.
  useEffect(() => {
    if (open && initialTab) setTab(initialTab);
  }, [open, initialTab]);

  // Whisper model state.
  const [models, setModels] = useState<WhisperModel[]>([]);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadJobId, setDownloadJobId] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<{
    modelId: string;
    percent: number;
    done: number;
    total: number;
  } | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const refreshModels = useCallback(async () => {
    try {
      const list = await invoke<WhisperModel[]>("list_whisper_models");
      setModels(list);
    } catch (err) {
      // Non-fatal: backend may not yet be initialised.
      console.warn("list_whisper_models failed", err);
    }
  }, []);

  useEffect(() => {
    if (open) refreshModels();
  }, [open, refreshModels]);

  // Listen for download events.
  useEffect(() => {
    const unlistens: UnlistenFn[] = [];
    let mounted = true;
    (async () => {
      const a = await listen<ModelDownloadEvent>("model-download-progress", (e) => {
        if (!mounted || e.payload.job_id !== downloadJobId) return;
        setDownloadProgress({
          modelId: e.payload.model_id,
          percent: e.payload.percent,
          done: e.payload.bytes_done,
          total: e.payload.bytes_total,
        });
      });
      const b = await listen<DoneEvent>("model-download-done", (e) => {
        if (!mounted || e.payload.job_id !== downloadJobId) return;
        if (e.payload.success) {
          setDownloadingId(null);
          setDownloadProgress(null);
          setDownloadJobId(null);
          setDownloadError(null);
          refreshModels();
        } else {
          setDownloadError(e.payload.error ?? "Download failed");
          setDownloadingId(null);
          setDownloadProgress(null);
          setDownloadJobId(null);
        }
      });
      unlistens.push(a, b);
    })();
    return () => {
      mounted = false;
      unlistens.forEach((u) => u());
    };
  }, [downloadJobId, refreshModels]);

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
      const id = await invoke<string>("new_job_id");
      setDownloadJobId(id);
      await invoke<string>("download_whisper_model", { args: { model_id: modelId, job_id: id } });
    } catch (err) {
      setDownloadError(formatError(err));
      setDownloadingId(null);
      setDownloadJobId(null);
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
    setDefaults({ ...defaults, whisperModel: modelId });
  }

  // Close on Esc.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

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
      <div className="cp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="cp-modal-header">
          <h2>Settings</h2>
          <span className="crumb">{TABS.find((t) => t.id === tab)?.label}</span>
          <div className="filler" />
          <button className="cp-modal-close" onClick={onClose} title="Close (Esc)">
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

                <div className="cp-pane-section">
                  <div className="cp-pane-section-label">Output</div>
                  <div className="cp-pane-row">
                    <div className="k">
                      Default folder
                      <span className="desc">Pre-fills the output folder when Sauce Bunny starts.</span>
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
                      <div className="cp-segmented" style={{ minWidth: 260, gridTemplateColumns: "repeat(4, 1fr)" }}>
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
                        onClick={() => setDefaults({ ...defaults, reencode: !defaults.reencode })}
                      />
                    </div>
                  </div>
                </div>

                <div className="cp-pane-section">
                  <div className="cp-pane-section-label">Local playback</div>
                  <div className="cp-pane-row">
                    <div className="k">
                      WebCodecs decoder (experimental)
                      <span className="desc">Skip the ffmpeg pre-encode on import. Plays the original file directly via WebCodecs (VP9, AV1, HEVC, etc.). Disable if local files won't play.</span>
                    </div>
                    <div className="v">
                      <button
                        className={"cp-toggle-switch" + (defaults.useWebCodecsDecoder ? " on" : "")}
                        onClick={() => setDefaults({ ...defaults, useWebCodecsDecoder: !defaults.useWebCodecsDecoder })}
                      />
                    </div>
                  </div>
                  <CacheControls />
                </div>

                <div className="cp-pane-section">
                  <div className="cp-pane-section-label">Web playback</div>
                  <div className="cp-pane-row">
                    <div className="k">
                      Stream while you watch
                      <span className="desc">On (default) — stream instantly so you can watch and mark in/out without waiting, then export downloads only the clip you marked. If a stream fails it falls back to downloading automatically. Off — download the full video first before playing (slower, but the most reliable on flaky connections).</span>
                    </div>
                    <div className="v">
                      <button
                        className={"cp-toggle-switch" + (defaults.streamPreview ? " on" : "")}
                        onClick={() => setDefaults({ ...defaults, streamPreview: !defaults.streamPreview })}
                      />
                    </div>
                  </div>
                </div>

                <div className="cp-pane-section">
                  <div className="cp-pane-section-label">Timecode</div>
                  <div className="cp-pane-row">
                    <div className="k">
                      Frame rate fallback
                      <span className="desc">Used when the source doesn't report a frame rate.</span>
                    </div>
                    <div className="v">
                      <div className="cp-segmented" style={{ minWidth: 200, gridTemplateColumns: "repeat(3, 1fr)" }}>
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
                </div>

                {onApplyToCurrent && (
                  <div style={{ marginTop: 18, display: "flex", justifyContent: "flex-end" }}>
                    <button className="btn btn-ghost" onClick={applyToCurrent}>
                      Apply to current export
                    </button>
                  </div>
                )}
              </section>
            )}

            {tab === "youtube" && (
              <YouTubeSettings defaults={defaults} setDefaults={setDefaults} />
            )}

            {tab === "transcription" && (
              <section>
                <h3 className="cp-pane-title">Transcription</h3>
                <p className="cp-pane-sub">
                  Local-only transcription via <strong>whisper.cpp</strong>. Pick a model below and
                  download it once — Sauce Bunny will use it to generate an .srt for the marked section
                  of your next clip. Audio is extracted with yt-dlp + ffmpeg; nothing leaves your
                  machine.
                </p>

                <div className="cp-pane-section">
                  <div className="cp-pane-section-label">Whisper model</div>
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
                      const isRecommended = m.id === RECOMMENDED_MODEL;
                      return (
                        <div key={m.id} className={"cp-model-row" + (isSelected ? " selected" : "")}>
                          <div className="cp-model-info-wrap">
                            <div className="cp-model-head">
                              <IconSparkles size={13} stroke="var(--fg-4)" />
                              <span className="name">{m.name}</span>
                              <span className="size">{formatMB(m.size_bytes)}</span>
                              {isRecommended && <span className="badge recommended">Recommended</span>}
                              {m.downloaded && <span className="badge installed">Installed</span>}
                              {isSelected && m.downloaded && <span className="badge selected">Default</span>}
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
                            {m.downloaded && !isSelected && (
                              <button className="btn btn-ghost" onClick={() => chooseModel(m.id)}>
                                Use as default
                              </button>
                            )}
                            {m.downloaded && (
                              <button
                                className="btn btn-ghost"
                                onClick={() => deleteModel(m.id)}
                                title="Remove this model file from disk"
                              >
                                Delete
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
                </div>

                <div className="cp-pane-section">
                  <div className="cp-pane-section-label">Transcript library</div>
                  <p style={{ fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-3)", lineHeight: 1.6, margin: "0 0 10px" }}>
                    All generated transcripts (Whisper output + downloaded YouTube
                    captions) land here, sub-organized by month. Decoupled from your
                    clip-export folder — transcripts are byproducts you want to find
                    later, exports are deliverables you point at a specific place.
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
                </div>

                <div className="cp-pane-section">
                  <div className="cp-pane-section-label">Speaker diarization</div>
                  <p style={{ fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-3)", lineHeight: 1.6, margin: "0 0 10px" }}>
                    When <em>Detect speakers</em> is on in the sidebar, Sauce Bunny also runs the
                    FluidAudio Swift sidecar after Whisper and stitches speaker labels into the SRT
                    (<code>SPEAKER_00</code>, <code>SPEAKER_01</code>, etc., renameable in the
                    transcript viewer). First run downloads a few hundred MB of Core ML models —
                    pre-warm here so the first real transcript doesn't pause.
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
                        <span style={{ fontSize: 11, color: "var(--color-accent-green)" }}>
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
                </div>

                <div className="cp-pane-section">
                  <div className="cp-pane-section-label">How it works</div>
                  <p style={{ fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-3)", lineHeight: 1.6, margin: 0 }}>
                    Click <em>Generate transcript</em> on the source card. yt-dlp grabs the audio for
                    your in→out range only (not the whole video), pipes it through ffmpeg, and
                    whisper-cli writes <code>&lt;filename&gt;.srt</code> next to where your clip would
                    save. Larger models = better accuracy, longer transcribe time.
                  </p>
                </div>
              </section>
            )}

            {tab === "shortcuts" && (
              <section>
                <h3 className="cp-pane-title">Keyboard shortcuts</h3>
                <p className="cp-pane-sub">
                  Source-monitor controls modelled on Premiere / Resolve. Editing the URL or a timecode
                  field temporarily releases these shortcuts. For the full list of every action
                  (including ones without a default hotkey), see the Commands tab or hit{" "}
                  <kbd>⌘</kbd><kbd>K</kbd>.
                </p>
                <div className="cp-shortcuts-grid">
                  {SHORTCUTS.map((cat) => (
                    <div className="cp-shortcut-cat" key={cat.category}>
                      <div className="cp-shortcut-cat-title">{cat.category}</div>
                      {cat.items.map((s, i) => (
                        <div className="cp-shortcut-row" key={i}>
                          <span className="lbl">{s.label}</span>
                          <span className="keys">
                            {s.keys.map((k, j) => (
                              <kbd key={j} className={k.length > 1 ? "sym" : ""}>{k}</kbd>
                            ))}
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {tab === "commands" && (
              <section>
                <h3 className="cp-pane-title">Commands</h3>
                <p className="cp-pane-sub">
                  Every action Sauce Bunny exposes, grouped by domain. Open the palette anywhere
                  with <kbd>⌘</kbd><kbd>K</kbd> to run any of these with fuzzy search.
                  This list is generated from the same registry the palette uses — it can't
                  drift out of sync with what actually runs.
                </p>
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
              </section>
            )}

            {tab === "about" && (
              <section>
                <div className="cp-about-hero">
                  <div className="mark">sb</div>
                  <div>
                    <div className="cp-about-name">
                      Sauce Bunny <span className="ver">v0.1.0</span>
                    </div>
                    <div className="cp-about-tag">
                      Local-first video section clipper. Tauri 2 + bundled yt-dlp + ffmpeg + whisper.cpp.
                    </div>
                  </div>
                </div>

                <div className="cp-about-grid">
                  <div className="cp-about-row"><span className="k">Build</span><span className="v">dev</span></div>
                  <div className="cp-about-row"><span className="k">Engine</span><span className="v">Tauri 2 + Wry</span></div>
                  <div className="cp-about-row"><span className="k">UI</span><span className="v">React 18 + Vite 6</span></div>
                  <div className="cp-about-row"><span className="k">Sidecars</span><span className="v">yt-dlp · ffmpeg · whisper-cli</span></div>
                  <div className="cp-about-row">
                    <span className="k">Transcripts</span>
                    <span className="v">yt-dlp captions · whisper.cpp</span>
                  </div>
                  <div className="cp-about-row"><span className="k">License</span><span className="v">personal use</span></div>
                  <div className="cp-about-row"><span className="k">Data</span><span className="v">no cloud · no accounts</span></div>
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

                <p style={{ marginTop: 18, fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-4)", lineHeight: 1.6 }}>
                  Use it on content you have the rights to clip. Bundled binaries are tested releases of yt-dlp,
                  ffmpeg, and whisper.cpp, all run locally only. No telemetry. Network calls are limited to
                  the YouTube source you fetch, the thumbnail URL when you save or copy a poster image, and
                  HuggingFace when you download a Whisper model.
                </p>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Settings row that surfaces total cache size + a one-click purge.
 * Cache = `saucebunny-*` files in `app_cache_dir()` — playback prep copies,
 * thumbnails, whisper wavs, audio raw downloads. Files NOT under that
 * prefix (e.g. whisper-models/) are never touched.
 */
function CacheControls() {
  // CacheStats now comes from the canonical Rust definition (r49 +
  // r50). The inline-anonymous-type pattern was a workaround from
  // before the bindings existed.
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [cachePath, setCachePath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      setStats({ file_count: 0, bytes_total: 0, path: "" });
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const onClear = async () => {
    if (!stats || stats.file_count === 0) return;
    if (!confirm(`Delete ${stats.file_count} cached file${stats.file_count === 1 ? "" : "s"} (${formatBytes(stats.bytes_total)})? This won't affect your exported clips.`)) return;
    setBusy(true);
    try {
      await invoke<number>("clear_all_cache");
    } catch (err) {
      console.warn("clear_all_cache failed", err);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const sizeLabel = stats ? formatBytes(stats.bytes_total) : "—";
  const countLabel = stats ? `${stats.file_count} file${stats.file_count === 1 ? "" : "s"}` : "checking…";

  return (
    <div className="cp-pane-row">
      <div className="k">
        Cache
        <span className="desc">Playback-prep copies, thumbnails, and audio buffers Sauce Bunny writes while working. Safe to clear any time — does not delete your exported clips.</span>
      </div>
      <div className="v" style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-3)" }}>
          {countLabel} · {sizeLabel}
        </span>
        {cachePath && (
          // Cache path visibility (r39 — user asked for "set a cache
          // folder in settings"). Setting a custom path is r40 work
          // (needs Rust to honour the override on every cache write);
          // for now we surface the OS default + a Reveal so users can
          // SEE where files land.
          <span
            style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-5)", maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            title={cachePath}
          >
            {cachePath}
          </span>
        )}
        <div style={{ display: "flex", gap: 6 }}>
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
            onClick={onClear}
            disabled={busy || !stats || stats.file_count === 0}
          >
            {busy ? "Clearing…" : "Clear cache"}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
