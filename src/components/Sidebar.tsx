import { useEffect, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { CollapsibleSection } from "./CollapsibleSection";
import {
  IconFilm, IconCaptions, IconReveal,
  IconDownload, IconSparkles, IconPlus,
} from "./Icons";
import type { AppStatus, ExportOpts, FormatId, Metadata, RecentClip } from "../types";
import { isValidTc, normalizeTc, tcToFrames } from "../lib/timecode";
import { formatRelative, formatUploadDate, formatViewCount } from "../lib/upload-date";
import { sanitizeFilename } from "../lib/filename";
import { formatError } from "../lib/error-format";
import { hostnameOf } from "../lib/validation";
import { decodeHtmlEntities } from "../lib/text";

type Props = {
  status: AppStatus;
  metadata: Metadata | null;
  exportOpts: ExportOpts;
  setExportOpts: (next: ExportOpts) => void;
  recents: RecentClip[];
  onExport: () => void;
  onReveal: () => void;
  onPickRecent: (r: RecentClip) => void;
  /** Purges the recent-exports list. The actual files are NOT deleted. */
  onClearRecents: () => void;
  onAddToQueue: () => void;
  queueCount: number;
  queueRunning: boolean;
  onExportQueue: () => void;
  onDownloadCaptions: () => void;
  captionsState: "idle" | "running" | "done" | "error";
  captionsError: string | null;
  /** Whisper transcript */
  onGenerateTranscript: () => void;
  transcriptState: "idle" | "running" | "done" | "error";
  transcriptError: string | null;
  transcriptProgress: number;
  whisperModelReady: boolean;
  whisperModelLabel: string | null;
  onOpenTranscriptionSettings: () => void;
  /**
   * Stage of the in-flight transcript pipeline ("whisper" /
   * "diarize-prepare" / "diarize-process" / "diarize-merge"), or null
   * when nothing is running. Used to label the progress bar so it
   * doesn't pin at 100% with cryptic text after Whisper finishes.
   */
  transcriptPhase: string | null;
  /**
   * Speaker-diarization opt-in. When true the next Whisper run also
   * invokes the saucebunny-diarize Swift sidecar and stitches speaker
   * labels into the SRT. Persisted via Defaults so the choice sticks
   * across sessions.
   */
  detectSpeakers: boolean;
  setDetectSpeakers: (v: boolean) => void;
  /**
   * Speaker-count hint. 0 = auto (let the model estimate). Sidebar
   * exposes Auto / 2 / 3 / 4 / 5 / 6+ as a small dropdown. Telling
   * the diarizer the exact count skips the (error-prone) clustering-
   * estimate stage entirely, which is the single largest quality
   * lever in modern speaker-diarization.
   */
  expectedSpeakers: number;
  setExpectedSpeakers: (n: number) => void;
  /**
   * True once the user (or the diarizer itself) has confirmed the
   * FluidAudio Core ML models are cached locally. Lets the toggle
   * show "✓ Models cached" instead of warning about the first-run
   * download.
   */
  diarizerReady: boolean;
  onLog: (tag: "info" | "ok" | "err", source: string, message: string) => void;
  fps: number;
  durationTc: string;
  /**
   * True while metadata is still a stub (yt-dlp hasn't returned width/
   * height/fps yet). Disables Export — frame-accurate cuts depend on the
   * real fps, and the format selector needs the real source height.
   */
  metadataLoading?: boolean;
};

const FORMATS: { id: FormatId; label: string }[] = [
  { id: "4k",    label: "4K" },
  { id: "1080",  label: "1080p" },
  { id: "720",   label: "720p" },
  { id: "audio", label: "Audio" },
];

/**
 * Turn a transcript-phase + percent into a button label that's
 * accurate at every stage of the pipeline. We don't try to fake a
 * percent during diarize (FluidAudio doesn't surface one) — the
 * compact phase tracker below the button shows where we are.
 */
function phaseLabel(phase: string | null, percent: number): string {
  switch (phase) {
    case "diarize-prepare": return "Loading speaker models…";
    case "diarize-process": return "Detecting speakers…";
    case "diarize-merge":   return "Merging speaker labels…";
    case "whisper":
    default:
      return `Transcribing… ${Math.round(percent)}%`;
  }
}

function formatLine(opts: ExportOpts): string {
  if (opts.format === "audio") return "MP3 320 kbps";
  const sizeHint =
    opts.format === "4k" ? "≈ 4K · MP4" :
    opts.format === "720" ? "≈ 720p · MP4" :
    "≈ 1080p · MP4";
  return sizeHint + (opts.reencode ? " · re-encode" : " · lossless cut");
}

function extFromUrl(url: string): string {
  const m = url.match(/\.(jpe?g|png|webp|gif)(\?|$)/i);
  return (m?.[1] ?? "jpg").toLowerCase().replace("jpeg", "jpg");
}

export function Sidebar(props: Props) {
  const {
    status, metadata, exportOpts, setExportOpts,
    recents, onExport, onReveal, onPickRecent, onClearRecents,
    onAddToQueue, queueCount, queueRunning, onExportQueue,
    onDownloadCaptions, captionsState, captionsError,
    onGenerateTranscript, transcriptState, transcriptError, transcriptProgress,
    transcriptPhase,
    whisperModelReady, whisperModelLabel, onOpenTranscriptionSettings,
    detectSpeakers, setDetectSpeakers, diarizerReady,
    expectedSpeakers, setExpectedSpeakers,
    onLog,
    fps, durationTc,
    metadataLoading,
  } = props;

  const [openMap, setOpenMap] = useState<Record<string, boolean>>(() => {
    try {
      const stored = localStorage.getItem("cp-sidebar-sections");
      if (stored) return JSON.parse(stored);
    } catch { /* ignore */ }
    return { source: true, export: true, recent: true };
  });
  useEffect(() => {
    try { localStorage.setItem("cp-sidebar-sections", JSON.stringify(openMap)); } catch { /* ignore */ }
  }, [openMap]);

  const toggle = (id: string) => setOpenMap((p) => ({ ...p, [id]: p[id] === false }));

  const exporting = status === "exporting";
  const success = status === "success";
  const hasSource = status === "loaded" || status === "exporting" || status === "success";

  // Empty TC string = no mark. Otherwise must parse.
  const inFrames  = exportOpts.inTc  === "" ? null : tcToFrames(exportOpts.inTc,  fps);
  const outFrames = exportOpts.outTc === "" ? null : tcToFrames(exportOpts.outTc, fps);
  const hasMarks = inFrames != null && outFrames != null;
  const selFrames = hasMarks ? Math.max(0, (outFrames as number) - (inFrames as number)) : null;
  const selectionTc = selFrames != null ? (() => {
    const r = Math.max(1, Math.round(fps));
    const total = Math.floor(selFrames / r);
    const hh = Math.floor(total / 3600);
    const mm = Math.floor((total % 3600) / 60);
    const ss = total % 60;
    const ff = selFrames % r;
    return `${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}:${String(ss).padStart(2,"0")}:${String(ff).padStart(2,"0")}`;
  })() : "Full clip";

  // Valid means either empty (no mark) or parses as a TC.
  // All resolution pills are *ceilings* fed to yt-dlp's `bv*[height<=N]+ba`
  // selector — a 360p source with "1080p" picked still downloads at 360p
  // because that's what's available. So we always show every pill.

  const inValid  = exportOpts.inTc  === "" || isValidTc(exportOpts.inTc,  fps);
  const outValid = exportOpts.outTc === "" || isValidTc(exportOpts.outTc, fps);
  const filenameValid = sanitizeFilename(exportOpts.filename).length > 0;
  // Export is allowed when: source loaded, folder + filename set, marks are
  // either both unset (= full clip) or both valid with out > in.
  const marksOk = hasMarks ? (selFrames ?? 0) > 0 : (inFrames == null && outFrames == null);
  const canExport =
    hasSource && !exporting && !success &&
    inValid && outValid && marksOk &&
    !!exportOpts.folder && filenameValid &&
    // Block export until yt-dlp has returned the *real* metadata. The stub
    // has no fps/width/height — exporting against fallback values would
    // mis-align frame-accurate cuts and pick the wrong format selector.
    !metadataLoading;

  async function chooseFolder() {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") {
      setExportOpts({ ...exportOpts, folder: picked });
    }
  }

  // ─── Thumbnail save (Copy removed — see app notes) ──────────────────
  async function downloadThumbnail() {
    if (!metadata?.thumbnail) return;
    const ext = extFromUrl(metadata.thumbnail);
    const base = sanitizeFilename(metadata.title || "thumbnail");
    try {
      const dest = await saveDialog({
        defaultPath: `${base}.${ext}`,
        filters: [{ name: "Image", extensions: ["jpg", "jpeg", "png", "webp"] }],
      });
      if (!dest) return;
      await invoke("save_thumbnail", { args: { url: metadata.thumbnail, dest } });
      onLog("ok", "thumbnail", `Saved → ${dest}`);
      invoke("reveal_in_finder", { path: dest }).catch(() => { /* ignore */ });
    } catch (err) {
      onLog("err", "thumbnail", `Save failed: ${formatError(err)}`);
    }
  }

  return (
    <aside className="cp-sidebar">
      {!hasSource && (
        <div className="cp-section">
          <div className="cp-section-label">Source</div>
          <div className="cp-thumb cp-thumb-empty">
            <div className="cp-thumb-empty-stack">
              <IconFilm size={22} stroke="rgba(255,255,255,0.18)" />
              <span style={{ fontFamily: "var(--font-ui)", fontSize: 10, color: "var(--fg-5)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
                {status === "fetching" ? "Resolving…" : status === "error" ? "Resolve failed" : "No source loaded"}
              </span>
            </div>
          </div>
          <div className="cp-meta">
            <h2 style={{ color: "var(--fg-4)" }}>Waiting for source…</h2>
            <div className="cp-meta-row">
              <span style={{ color: "var(--fg-5)" }}>Paste a URL above to begin</span>
            </div>
          </div>
        </div>
      )}

      {hasSource && metadata && (() => {
        // Per-import host label — used to be hard-coded "youtube". Now
        // it reflects the actual source (vimeo.com, tiktok.com, etc.)
        // for non-YouTube web sources. Local files keep their kind label.
        const isLocalSource = metadata.webpage_url.startsWith("file://");
        const sourceLabel = isLocalSource ? "local file" : hostnameOf(metadata.webpage_url);
        // All four format pills are now valid for both source types —
        // local-file MP3 export went live once @mediabunny/mp3-encoder
        // was registered. (Re-encode toggle is still source-conditional
        // below; it only applies to the yt-dlp+ffmpeg path.)
        const availableFormats = FORMATS;
        return (
        <>
          <CollapsibleSection
            id="source"
            label="Source"
            meta={sourceLabel}
            summary={`${sourceLabel} · ${durationTc}`}
            open={openMap.source !== false}
            onToggle={() => toggle("source")}
          >
            <div className="cp-thumb">
              {metadata.thumbnail && <img src={metadata.thumbnail} alt="" referrerPolicy="no-referrer" />}
              <div className="cp-thumb-actions br">
                <button
                  type="button"
                  onClick={downloadThumbnail}
                  disabled={!metadata.thumbnail}
                  title="Save thumbnail…"
                >
                  <IconDownload size={13} />
                </button>
              </div>
            </div>
            <div className="cp-meta">
              {/* Decoded once — yt-dlp's LinkedIn/Reddit/etc. extractors
                  often return titles with raw HTML entities like `&#39;`.
                  Native `title` attribute gives macOS's free tooltip on
                  hover so the user can read the full string when the
                  visible text is clamped. */}
              <h2 className="cp-source-title" title={decodeHtmlEntities(metadata.title)}>
                {decodeHtmlEntities(metadata.title)}
              </h2>
              <div className="cp-meta-row">
                {metadata.uploader && <span>{metadata.uploader}</span>}
                {formatUploadDate(metadata.upload_date) && (
                  <>
                    <span className="sep" />
                    <span>{formatUploadDate(metadata.upload_date)}</span>
                  </>
                )}
                {formatViewCount(metadata.view_count) && (
                  <>
                    <span className="sep" />
                    <span>{formatViewCount(metadata.view_count)}</span>
                  </>
                )}
              </div>
            </div>
            <div className="cp-kv">
              <div className="k">Resolution</div>
              <div className="v">
                {metadata.width && metadata.height
                  ? `${metadata.width} × ${metadata.height}`
                  : "—"}
              </div>
              <div className="k">Framerate</div>
              <div className="v mono">
                {metadata.fps ? `${metadata.fps.toFixed(metadata.fps % 1 === 0 ? 0 : 3)} fps` : "—"}
              </div>
              <div className="k">Duration</div>
              <div className="v mono">{durationTc}</div>
              <div className="k">Streams</div>
              <div className="v mono">
                {metadata.has_subs ? "video + audio + subs" : "video + audio"}
              </div>
            </div>

            <div className="cp-source-actions">
              <button
                type="button"
                className="btn btn-ghost cp-source-action"
                onClick={onDownloadCaptions}
                disabled={captionsState === "running"}
              >
                <IconCaptions size={13} />
                {captionsState === "running" ? "Downloading transcript…"
                 : captionsState === "done"  ? "Transcript saved · download again"
                 : captionsState === "error" ? "Retry transcript"
                 : "Download transcript"}
              </button>

              {whisperModelReady ? (
                <>
                  {/* Speaker-detection opt-in. The toggle is intentionally
                      a quiet checkbox row (not a flashy switch) — the user
                      ticks it once for the session and forgets. Disabled
                      while a transcript is in flight so a mid-run change
                      can't desync the next event payload. */}
                  <label
                    className="cp-toggle-row"
                    title={diarizerReady
                      ? "Run FluidAudio speaker diarization after Whisper. Models cached locally — only adds 10–60s of compute."
                      : "Run FluidAudio speaker diarization after Whisper. First run downloads a few hundred MB; pre-warm via Settings → Transcription."}
                  >
                    <input
                      type="checkbox"
                      checked={detectSpeakers}
                      onChange={(e) => setDetectSpeakers(e.target.checked)}
                      disabled={transcriptState === "running"}
                    />
                    <span className="lbl">
                      Detect speakers <span className="beta">beta</span>
                      {diarizerReady && detectSpeakers && (
                        <span className="cp-hint-ok" title="Models cached locally — no first-run download">✓ cached</span>
                      )}
                    </span>
                  </label>
                  {detectSpeakers && (
                    /* Speaker-count hint — only meaningful when
                       diarization is actually going to run. Auto lets
                       pyannote estimate; specific counts skip the
                       estimation step and dramatically improve quality
                       (especially the "absorbed-at-the-edge" failure
                       mode where a short turn at the end of a clip
                       gets merged with the prior speaker). */
                    <label
                      className="cp-toggle-row"
                      style={{ marginLeft: 20 }}
                      title="Tell the diarizer how many distinct voices are in the audio. Pyannote's clustering stage is the weak link — a known count is the single biggest quality improver."
                    >
                      <span className="lbl" style={{ color: "var(--fg-3)" }}>
                        Expected speakers
                      </span>
                      <select
                        className="cp-mini-select"
                        value={expectedSpeakers}
                        onChange={(e) => setExpectedSpeakers(parseInt(e.target.value, 10) || 0)}
                        disabled={transcriptState === "running"}
                      >
                        <option value={0}>Auto</option>
                        <option value={2}>2</option>
                        <option value={3}>3</option>
                        <option value={4}>4</option>
                        <option value={5}>5</option>
                        <option value={6}>6+</option>
                      </select>
                    </label>
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost cp-source-action"
                    onClick={onGenerateTranscript}
                    disabled={transcriptState === "running"}
                    title={`Local Whisper transcription · model: ${whisperModelLabel ?? "?"}`}
                  >
                    <IconSparkles size={13} />
                    {transcriptState === "running"
                      ? phaseLabel(transcriptPhase, transcriptProgress)
                      : transcriptState === "done"  ? "Generate transcript · run again"
                      : transcriptState === "error" ? "Generate transcript · retry"
                      : detectSpeakers ? "Generate transcript + speakers"
                      : "Generate transcript"}
                  </button>
                  {transcriptState === "running" && transcriptPhase && transcriptPhase !== "whisper" && (
                    /* Mini phase tracker so the user sees we're past
                       Whisper even though the percent bar is pinned. */
                    <div className="cp-phase-track" aria-label={`Pipeline stage: ${transcriptPhase}`}>
                      <span className={"step done"}>Whisper</span>
                      <span className="sep">→</span>
                      <span className={"step " + (transcriptPhase === "diarize-merge" ? "done" : "active")}>Diarize</span>
                      <span className="sep">→</span>
                      <span className={"step " + (transcriptPhase === "diarize-merge" ? "active" : "")}>Merge</span>
                    </div>
                  )}
                </>
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost cp-source-action"
                  onClick={onOpenTranscriptionSettings}
                  title="Open Settings → Transcription to download a model"
                >
                  <IconSparkles size={13} />
                  Set up Whisper transcription…
                </button>
              )}

              {captionsState === "error" && captionsError && (
                <div className="cp-source-hint err">Captions: {captionsError}</div>
              )}
              {transcriptState === "error" && transcriptError && (
                <div className="cp-source-hint err">Whisper: {transcriptError}</div>
              )}
              {/* Transcripts now route to ~/Documents/Sauce Bunny/Transcripts/
                  (auto-created), separate from the per-session clip-export
                  folder, so we no longer block on that being set. The hint
                  above used to read "Choose an output folder…" — that copy
                  applied when transcripts shared the export folder. */}
            </div>
          </CollapsibleSection>

          <CollapsibleSection
            id="export"
            label="Export"
            meta={exportOpts.format === "audio" ? "MP3" : exportOpts.format.toUpperCase() + " · MP4"}
            summary={`${selectionTc} selection`}
            open={openMap.export !== false}
            onToggle={() => toggle("export")}
          >
            <div className="cp-field-row">
              <div className="cp-field">
                <label>Mark in</label>
                <input
                  type="text"
                  inputMode="numeric"
                  className={"cp-input cp-input-tc" + (inValid ? "" : " invalid")}
                  value={exportOpts.inTc}
                  placeholder="—"
                  /* Hard filter — strip anything that isn't a digit or colon
                     so the field can't accept arbitrary text like "dfsdf". */
                  onChange={(e) => {
                    const cleaned = e.target.value.replace(/[^0-9:]/g, "");
                    setExportOpts({ ...exportOpts, inTc: cleaned });
                  }}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v === "") return;
                    const norm = normalizeTc(v, fps);
                    if (norm !== e.target.value) setExportOpts({ ...exportOpts, inTc: norm });
                  }}
                  spellCheck={false}
                />
              </div>
              <div className="cp-field">
                <label>Mark out</label>
                <input
                  type="text"
                  inputMode="numeric"
                  className={"cp-input cp-input-tc" + (outValid ? "" : " invalid")}
                  value={exportOpts.outTc}
                  placeholder="—"
                  onChange={(e) => {
                    const cleaned = e.target.value.replace(/[^0-9:]/g, "");
                    setExportOpts({ ...exportOpts, outTc: cleaned });
                  }}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v === "") return;
                    const norm = normalizeTc(v, fps);
                    if (norm !== e.target.value) setExportOpts({ ...exportOpts, outTc: norm });
                  }}
                  spellCheck={false}
                />
              </div>
            </div>

            <div className="cp-field" style={{ marginTop: -4, marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ color: "var(--fg-4)", textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 10, fontWeight: 600, fontFamily: "var(--font-ui)" }}>
                  Selection
                </span>
                <span style={{ fontFamily: "var(--font-mono)", color: "var(--fg-1)", fontVariantNumeric: "tabular-nums", fontWeight: 500, fontSize: 11 }}>
                  {selectionTc}
                </span>
              </div>
            </div>

            <div className="cp-field">
              <label>Filename</label>
              <input
                type="text"
                className="cp-input"
                value={exportOpts.filename}
                onChange={(e) => setExportOpts({ ...exportOpts, filename: e.target.value })}
                style={{ fontFamily: "var(--font-ui)" }}
                /* Spell-check ON — filenames are usually prose ("interview
                   with marc", "demo final cut") and a misspelled file is
                   hard to find on disk later. `lang="en"` is required for
                   WKWebView to actually render the underline. (r43) */
                spellCheck
                lang="en"
                autoCorrect="off" /* don't silently rewrite the filename */
              />
              {/* "Saves as" preview row was removed (r39) — the filename
                  input + format pill already telegraph the same info. */}
            </div>

            <div className="cp-field">
              <label>Output folder</label>
              <div className="cp-folder">
                <span className={"path" + (exportOpts.folder ? "" : " empty")}>
                  {exportOpts.folder ?? "Choose a folder…"}
                </span>
                <button onClick={chooseFolder}>Browse</button>
              </div>
            </div>

            <div className="cp-field" style={{ marginBottom: 10 }}>
              <label>Format / quality</label>
              {/* Use the source-aware availableFormats list (filtered
                  above) — drops Audio for local files so the user
                  doesn't click into a "coming soon" dead end. */}
              <div className="cp-segmented" style={{ gridTemplateColumns: `repeat(${availableFormats.length}, 1fr)` }}>
                {availableFormats.map((f) => (
                  <button
                    key={f.id}
                    className={exportOpts.format === f.id ? "active" : ""}
                    onClick={() => setExportOpts({ ...exportOpts, format: f.id })}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              {metadata.height != null && exportOpts.format !== "audio" && (() => {
                const cap =
                  exportOpts.format === "4k"   ? 2160 :
                  exportOpts.format === "1080" ? 1080 :
                  exportOpts.format === "720"  ?  720 : 0;
                if (cap > 0 && metadata.height < cap) {
                  return (
                    <div className="cp-fullclip-hint" style={{ marginTop: 6 }}>
                      Source is {metadata.width}×{metadata.height} — you'll get the source resolution (no upscale).
                    </div>
                  );
                }
                return null;
              })()}
            </div>

            {/* Re-encode toggle is only meaningful for the yt-dlp+ffmpeg
                export pipeline (YouTube/web sources). The local-file
                mediabunny path always stream-copies (lossless cut) and
                doesn't honour this flag, so we hide it for local sources
                rather than letting the user toggle a no-op. */}
            {!isLocalSource && (
              <div className="cp-toggle">
                <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <IconFilm size={13} stroke="var(--fg-3)" />
                  Re-encode (frame-accurate)
                </span>
                <button
                  type="button"
                  className={"cp-toggle-switch" + (exportOpts.reencode ? " on" : "")}
                  onClick={() => setExportOpts({ ...exportOpts, reencode: !exportOpts.reencode })}
                />
              </div>
            )}

            <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
              {success ? (
                <button className="btn btn-primary" style={{ flex: 1 }} onClick={onReveal}>
                  <IconReveal size={13} />
                  Reveal in Finder
                </button>
              ) : queueCount > 0 ? (
                // Queue is the source of truth when it has items.
                <button
                  className="btn btn-primary"
                  style={{ flex: 1, height: 36, fontSize: 13 }}
                  onClick={onExportQueue}
                  disabled={queueRunning || !exportOpts.folder}
                >
                  {queueRunning ? "Exporting…" : `Export ${queueCount} ${queueCount === 1 ? "clip" : "clips"}`}
                </button>
              ) : (
                <button
                  className="btn btn-primary"
                  style={{ flex: 1, height: 36, fontSize: 13 }}
                  onClick={onExport}
                  disabled={!canExport}
                  title={metadataLoading ? "Waiting for yt-dlp to resolve stream metadata…" : undefined}
                >
                  {exporting
                    ? "Exporting…"
                    : metadataLoading
                    ? "Resolving metadata…"
                    : hasMarks
                    ? "Export clip"
                    : `Download entire ${exportOpts.format === "audio" ? "MP3" : "clip"}`}
                </button>
              )}
              {!success && hasMarks && (
                <button
                  className="btn btn-ghost cp-add-queue"
                  onClick={onAddToQueue}
                  disabled={queueRunning || !selFrames || selFrames <= 0}
                  title="Add this selection to the queue (⌘⇧A)"
                  style={{ flexShrink: 0 }}
                >
                  <IconPlus size={13} />
                </button>
              )}
            </div>
            {!success && !exporting && (
              <div style={{
                marginTop: 8,
                fontFamily: "var(--font-ui)", fontSize: 10, color: "var(--fg-5)",
                textAlign: "center", letterSpacing: "0.04em",
              }}>
                {formatLine(exportOpts)}
              </div>
            )}
          </CollapsibleSection>
        </>
        );
      })()}

      {recents.length > 0 && (
        <CollapsibleSection
          id="recent"
          label="Recent"
          meta={`${recents.length} ${recents.length === 1 ? "clip" : "clips"}`}
          open={openMap.recent !== false}
          onToggle={() => toggle("recent")}
        >
          {/* Clear-all row sits above the list — small, ghost button so it
              doesn't visually compete with the recent items themselves.
              Note: only the history list is purged, the exported files
              on disk stay where they are. */}
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
            <button
              type="button"
              className="btn btn-ghost btn-compact"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`Clear ${recents.length} recent ${recents.length === 1 ? "entry" : "entries"}? Exported files stay on disk.`)) {
                  onClearRecents();
                }
              }}
              title="Clear recent history (files on disk are kept)"
            >
              Clear
            </button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {recents.map((r) => (
              <div className="cp-recent" key={r.id} onClick={() => onPickRecent(r)} title={r.path}>
                <div className="thumb">
                  {r.thumbnail && <img src={r.thumbnail} alt="" referrerPolicy="no-referrer" />}
                </div>
                <div className="body">
                  <div className="title" title={decodeHtmlEntities(r.title)}>{decodeHtmlEntities(r.title)}</div>
                  <div className="meta">
                    <span className="tc">{r.dur}</span>
                    <span className="sep" />
                    <span>{formatRelative(r.when)}</span>
                  </div>
                </div>
                <button
                  className="btn-icon"
                  style={{ width: 22, height: 22, border: "none" }}
                  title="Reveal in Finder"
                  onClick={(e) => { e.stopPropagation(); invoke("reveal_in_finder", { path: r.path }).catch(() => {}); }}
                >
                  <IconReveal size={12} />
                </button>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}
    </aside>
  );
}
