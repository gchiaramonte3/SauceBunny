import { type CSSProperties, useEffect, useId, useMemo, useState, useSyncExternalStore } from "react";
import { WEB_POSTERS_CHANGED_EVENT, webPosterFor } from "../lib/web-poster-store";
import { inertWhen } from "../lib/inert";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { CollapsibleSection } from "./CollapsibleSection";
import { GenerateButton } from "./GenerateButton";
import { StatefulButton } from "./StatefulButton";
import {
  IconChevronRight,
  IconFilm, IconCaptions, IconReveal,
  IconDownload, IconSparkles, IconPlus,
} from "./Icons";
import { ReviewStatusChip } from "./ReviewStatusChip";
import type { AppStatus, ExportOpts, FormatId, Metadata, RecentClip } from "../types";
import type { StatefulPhase } from "../lib/stateful-phase";
import { framesToTc, isValidTc, normalizeTc, tcToFrames } from "../lib/timecode";
import { formatUploadDate, formatViewCount } from "../lib/upload-date";
import { formatTimeAgo } from "../lib/transcript-history";
import { middleEllipsize, sanitizeFilename } from "../lib/filename";
import { formatError } from "../lib/error-format";
import { hostnameOf } from "../lib/validation";
import { decodeHtmlEntities } from "../lib/text";

type Props = {
  /** False → collapsed to zero width (toolbar's sidebar toggle). */
  open?: boolean;
  /** Arms App's filename dirty flag: a user-typed name survives source
   *  switches; a seeded name reseeds from the next source. */
  onFilenameEdit?: () => void;
  /** Current source's approval verdict (null = no explicit verdict). */
  reviewStatus: { state: "pending" | "approved" | "changes"; reviewer: string } | null;
  status: AppStatus;
  metadata: Metadata | null;
  exportOpts: ExportOpts;
  setExportOpts: (next: ExportOpts) => void;
  recents: RecentClip[];
  onExport: () => void;
  /** Animated Export-button phase (loading → success/error flash). */
  exportPhase: StatefulPhase;
  /** Returns the Export button to idle after its success/error flash. */
  onExportResolved: () => void;
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
  /** Transient run outcome for the GenerateButton flash (check/cross). */
  transcriptResolution: "success" | "error" | null;
  /** Clears the flash after it plays. */
  onTranscriptResolved: () => void;
  transcriptError: string | null;
  transcriptProgress: number;
  whisperModelReady: boolean;
  whisperModelLabel: string | null;
  onOpenTranscriptionSettings: () => void;
  /** Opens Settings → General (the export-folder nudge deep-link). */
  onOpenGeneralSettings: () => void;
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
function phaseLabel(phase: string | null, percent: number, diarizerReady = true): string {
  switch (phase) {
    case "download":        return `Downloading audio… ${Math.round(percent)}%`;
    case "extract":         return percent > 0 ? `Preparing audio… ${Math.round(percent)}%` : "Preparing audio…";
    // "Loading" is honest for a cached read and badly misleading for the
    // first run, which fetches a few hundred megabytes and can sit here for
    // minutes with no percent behind it - FluidAudio surfaces none. The app
    // already knows which case it is in, so it says so rather than leaving
    // someone watching an apparently-stuck bar decide the app has hung.
    case "diarize-prepare":
      return diarizerReady
        ? "Loading speaker models…"
        : "Downloading speaker models, a few hundred MB, one time…";
    case "diarize-process": return "Detecting speakers…";
    case "diarize-merge":   return "Merging speaker labels…";
    // Parakeet's transcribe() is one shot — no percent — so we label by phase
    // instead of showing a frozen 0%.
    case "parakeet-load":   return "Loading Parakeet model…";
    case "parakeet":        return "Transcribing with Parakeet…";
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
    status, metadata, exportOpts, setExportOpts, onFilenameEdit, reviewStatus,
    recents, onExport, exportPhase, onExportResolved, onReveal, onPickRecent, onClearRecents,
    onAddToQueue, queueCount, queueRunning, onExportQueue,
    onDownloadCaptions, captionsState, captionsError,
    onGenerateTranscript, transcriptState, transcriptResolution, onTranscriptResolved,
    transcriptError, transcriptProgress,
    transcriptPhase,
    whisperModelReady, whisperModelLabel, onOpenTranscriptionSettings,
    onOpenGeneralSettings,
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
  // framesToTc, from the module this file already imports. The eight lines
  // that stood here reimplemented it exactly - same clamp, same order, same
  // padding - which is how the two drift the day one of them learns about
  // drop-frame.
  const selectionTc = selFrames != null ? framesToTc(selFrames, fps) : "Full clip";

  // Valid means either empty (no mark) or parses as a TC.
  // All resolution pills are *ceilings* fed to yt-dlp's `bv*[height<=N]+ba`
  // selector — a 360p source with "1080p" picked still downloads at 360p
  // because that's what's available. So we always show every pill.

  const inValid  = exportOpts.inTc  === "" || isValidTc(exportOpts.inTc,  fps);
  const outValid = exportOpts.outTc === "" || isValidTc(exportOpts.outTc, fps);
  // Shared row internals for lead + nested recent rows (one place to
  // change the meta line or the reveal action — review fix: they were
  // copy-pasted, and the reveal button carried inline styles).
  const recentMeta = (r: RecentClip) => (
    <div className="meta">
      <span className="tc">{r.dur}</span>
      <span className="sep" />
      <span>{formatTimeAgo(r.when)}</span>
    </div>
  );
  /**
   * A recent row is now a real action - it loads the clip - so it has to be
   * reachable and announced as one. It cannot BE a <button> because it
   * contains two (expand, reveal), so this is the standard equivalent.
   */
  const recentRowProps = (r: RecentClip) => ({
    role: "button" as const,
    tabIndex: 0,
    title: r.path,
    onClick: () => onPickRecent(r),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      // Only when the row ITSELF has focus - Enter on the nested expand or
      // reveal button must do that button's job, not load the clip.
      if (e.target !== e.currentTarget) return;
      e.preventDefault();
      onPickRecent(r);
    },
  });

  const recentReveal = (path: string) => (
    <button
      className="btn-icon cp-recent-reveal"
      title="Reveal in Finder"
      aria-label="Reveal in Finder"
      onClick={(e) => { e.stopPropagation(); invoke("reveal_in_finder", { path }).catch(() => {}); }}
    >
      <IconReveal size={12} />
    </button>
  );

  // Recent exports grouped by SOURCE IDENTITY (webpage URL / local path),
  // newest of each group leading, groups ordered by their newest member.
  // Titles are display-only: two different sources with the same title must
  // NOT merge (review fix); legacy entries without `source` fall back to it.
  const groupKey = (r: RecentClip) => r.source ?? r.title;
  const groupedRecents = useMemo(() => {
    const bySource = new Map<string, { lead: RecentClip; rest: RecentClip[] }>();
    const groups: { lead: RecentClip; rest: RecentClip[] }[] = [];
    for (const r of recents) {
      const g = bySource.get(groupKey(r));
      if (g) g.rest.push(r);
      else {
        const fresh = { lead: r, rest: [] as RecentClip[] };
        bySource.set(groupKey(r), fresh);
        groups.push(fresh);
      }
    }
    return groups;
  }, [recents]);
  /**
   * Re-render when a web source's poster is captured.
   *
   * The capture happens seconds after the source loads (App polls the player
   * until a non-black frame is up), so without this the card that was empty at
   * fetch time would STAY empty until something else happened to re-render it.
   */
  const posterTick = useSyncExternalStore(
    (cb) => {
      window.addEventListener(WEB_POSTERS_CHANGED_EVENT, cb);
      return () => window.removeEventListener(WEB_POSTERS_CHANGED_EVENT, cb);
    },
    () => localStorage.getItem("saucebunny.webPosters") ?? "",
  );

  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (title: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title); else next.add(title);
      return next;
    });

  const filenameValid = sanitizeFilename(exportOpts.filename).length > 0;
  // Export is allowed when: source loaded, folder + filename set, marks are
  // either both unset (= full clip) or both valid with out > in.
  // ONE mark is a legal selection, and this used to refuse it.
  //
  // `hasMarks` needs BOTH, so with only an in-point set — the state you are in
  // between pressing [ and ] — this fell to the else branch, which demands both
  // be null, and returned false. canExport went false and the Export button
  // greyed out with nothing said. The export path never had that limitation:
  // handleExport computes startSec and endSec independently, and
  // mediabunny-export builds `trim` from whichever bound exists, so "in to the
  // end" and "start to out" both work and were simply unreachable.
  //
  // The real rule is only about the two-sided case: an out that is not after
  // its in is not a clip.
  const marksOk = hasMarks ? (selFrames ?? 0) > 0 : true;
  // Mark in/out carried a VISIBLE <label> that was a sibling with no htmlFor,
  // so the association was purely visual: `label[for]` matched nothing and the
  // input was not inside the label either. A screen reader read both as a bare
  // "edit text". Found by running the form-label sweep against a loaded source
  // — the sweep itself is old, but it had only ever walked the opening screen,
  // where these fields do not exist.
  const inTcId = useId();
  const outTcId = useId();

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
    <aside
      className={"cp-sidebar" + (props.open === false ? " closed" : "")}
      // aria-hidden HIDES it from a screen reader; inert makes it genuinely
      // unreachable. Closing animates to width: 0, not display: none, so
      // without this Tab still walked every control in here — announced by
      // nothing, because aria-hidden had already silenced them.
      aria-hidden={props.open === false}
      {...inertWhen(props.open === false)}
      aria-label="Source and export"
    >
      {!hasSource && (
        <div className="cp-section">
          <div className="cp-section-label">Source</div>
          <div className="cp-thumb cp-thumb-empty">
            <div className="cp-thumb-empty-stack">
              {/* 32, not 24: IconFilm's geometry sits on a 1.5-unit grid, and
                  32 is the size where every stroke lands on whole device
                  pixels (1.5 x 32/24 = 2px) - at 24 the glyph read soft. */}
              <IconFilm size={32} stroke="rgba(255,255,255,0.32)" />
              <span className="cp-thumb-empty-label">
                {status === "fetching" ? "Resolving…" : status === "error" ? "Resolve failed" : "No source loaded"}
              </span>
            </div>
          </div>
          <div className="cp-meta">
            <h2 className="cp-meta-empty-title">Waiting for source…</h2>
            <div className="cp-meta-row">
              <span className="cp-meta-empty-hint">Paste a URL above to begin</span>
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
        // The site's poster wins; a frame captured off the player is the
        // fallback. posterTick is read so the memo of this render is tied to
        // the store changing.
        void posterTick;
        const posterUrl = metadata.thumbnail || webPosterFor(metadata.webpage_url);
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
              {/* The site's own poster if yt-dlp found one, otherwise a frame
                  grabbed off the loaded player. The capture already existed for
                  the transcript and library rows; this card was the one place
                  still rendering an empty grey box for a source whose site
                  publishes no thumbnail. */}
              {posterUrl && <img src={posterUrl} alt="" referrerPolicy="no-referrer" />}
              <div className="cp-thumb-actions br">
                <button
                  type="button"
                  onClick={downloadThumbnail}
                  // A captured frame is a data: URL that save_thumbnail cannot
                  // fetch, so Save stays tied to a real remote thumbnail.
                  disabled={!metadata.thumbnail}
                  title="Save thumbnail…"
                  aria-label="Save thumbnail"
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
                {reviewStatus && reviewStatus.state !== "pending" && (
                  <ReviewStatusChip state={reviewStatus.state} reviewer={reviewStatus.reviewer || undefined} compact />
                )}
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
              <div className="k">Frame rate</div>
              <div className="v mono">
                {metadata.fps ? `${metadata.fps.toFixed(metadata.fps % 1 === 0 ? 0 : 3)} fps` : "—"}
              </div>
              <div className="k">Duration</div>
              <div className="v mono">{durationTc}</div>
              <div className="k">Streams</div>
              <div className="v mono">
                {/* WHAT THE FILE ACTUALLY HAS. This read "video + audio" for
                    everything, hardcoded - so a silent ProRes master said it
                    had audio, and the only way to find out otherwise was to
                    start a transcript and watch it fail on a raw ffmpeg
                    message. The probe has always reported this: acodec is null
                    when there is no audio stream (media.rs `has_audio:
                    acodec.is_some()`); this row simply never asked. */}
                {[
                  metadata.vcodec ? "video" : null,
                  metadata.acodec ? "audio" : null,
                  metadata.has_subs ? "subs" : null,
                ].filter(Boolean).join(" + ") || "—"}
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
                      ? "Run FluidAudio speaker diarization after Whisper. Models cached locally; adds 10 to 60 seconds of compute."
                      : "Run FluidAudio speaker diarization after Whisper. First run downloads a few hundred MB; pre-warm via Settings → Transcription."}
                  >
                    <input
                      type="checkbox"
                      checked={detectSpeakers}
                      onChange={(e) => setDetectSpeakers(e.target.checked)}
                      disabled={transcriptState === "running"}
                    />
                    <span className="lbl">
                      Detect speakers
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
                      title="Tell the diarizer how many distinct voices are in the audio. A known count is the single biggest quality improver."
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
                  <GenerateButton
                    className="cp-source-action"
                    loading={transcriptState === "running"}
                    progress={transcriptProgress}
                    resolution={transcriptResolution}
                    onResolved={onTranscriptResolved}
                    onClick={onGenerateTranscript}
                    disabled={transcriptState === "running"}
                    title={`Local Whisper transcription · model: ${whisperModelLabel ?? "?"}`}
                    idleLabel={
                      transcriptState === "done"  ? "Generate transcript · run again"
                      : transcriptState === "error" ? "Generate transcript · retry"
                      : detectSpeakers ? "Generate transcript + speakers"
                      : "Generate transcript"
                    }
                    loadingLabel={phaseLabel(transcriptPhase, transcriptProgress, diarizerReady)}
                  />
                  {transcriptState === "running" && transcriptPhase?.startsWith("diarize") && (
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
                /* NOT "Whisper:". The transcript pipeline has more than one
                   engine and the label was hardcoded to the wrong one - a
                   Parakeet run that failed reported itself as a Whisper
                   failure, which sends anyone debugging it to the wrong
                   settings pane. The row does not know which engine ran, so
                   it names the thing that failed instead of guessing. */
                <div className="cp-source-hint err">Transcript: {transcriptError}</div>
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
                <label htmlFor={inTcId}>Mark in</label>
                <input
                  id={inTcId}
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
                <label htmlFor={outTcId}>Mark out</label>
                <input
                  id={outTcId}
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
                onChange={(e) => { onFilenameEdit?.(); setExportOpts({ ...exportOpts, filename: e.target.value }); }}
                style={{ fontFamily: "var(--font-ui)" }}
                /* Spell-check ON — filenames are usually prose ("interview
                   with marc", "demo final cut") and a misspelled file is
                   hard to find on disk later. `lang="en"` is required for
                   WKWebView to actually render the underline. (r43) */
                spellCheck
                lang="en"
                autoCorrect="off" /* don't silently rewrite the filename */
                title={exportOpts.filename}
              />
              {/* Live preview of the ACTUAL final name: the TS mirror of the
                  byte-budget pipeline (sanitize + 180-byte cut). Typing is
                  never blocked; this line is how truncation shows itself.
                  Disk-level uniquing (-2, -3) happens in Rust at export. */}
              {filenameValid && (
                <div
                  className="cp-save-preview"
                  title={`${sanitizeFilename(exportOpts.filename)}.${exportOpts.format === "audio" ? "mp3" : "mp4"}`}
                >
                  Saves as {middleEllipsize(sanitizeFilename(exportOpts.filename))}.{exportOpts.format === "audio" ? "mp3" : "mp4"}
                </div>
              )}
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
              <div className="cp-segmented" style={{ ["--seg-count"]: availableFormats.length, ["--seg-active"]: Math.max(0, availableFormats.findIndex((f) => f.id === exportOpts.format)) } as CSSProperties}>
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
                      Source is {metadata.width}×{metadata.height}. Exports at source resolution, no upscale.
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
                role="switch"
                aria-checked={exportOpts.reencode}
                aria-label="Re-encode exports"
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
                  className="btn btn-primary cp-export-cta"
                  style={{ flex: 1, height: 36, fontSize: 13 }}
                  onClick={onExportQueue}
                  /* status gate: a running SINGLE export owns the shared
                     local-export cancel token, so the queue must wait. That
                     wait used to be invisible: `exporting` also suppresses the
                     folder nudge below, and this branch replaces the single
                     export's own button, so the whole screen went quiet and a
                     fully-labelled "Export 3 clips" did nothing when clicked.
                     The label carries the reason, the way it already does for
                     queueRunning; the title is the longer version. */
                  disabled={queueRunning || !exportOpts.folder || exporting}
                  title={exporting ? "A single clip export is running. The queue starts when it finishes." : undefined}
                >
                  {queueRunning
                    ? "Exporting…"
                    : exporting
                    ? "Waiting for the current export"
                    : `Export ${queueCount} ${queueCount === 1 ? "clip" : "clips"}`}
                </button>
              ) : (
                <StatefulButton
                  className="btn btn-primary cp-export-cta cp-sbtn-export"
                  phase={exportPhase}
                  onClick={onExport}
                  onResolved={onExportResolved}
                  disabled={!canExport}
                  loadingLabel="Exporting…"
                  title={metadataLoading ? "Waiting for yt-dlp to resolve stream metadata…" : undefined}
                  idleContent={
                    metadataLoading
                      ? "Resolving metadata…"
                      : hasMarks
                      ? "Export clip"
                      : `Download entire ${exportOpts.format === "audio" ? "MP3" : "clip"}`
                  }
                />
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
            {/* Why-is-Export-disabled nudge: a missing folder used to just gray
                the button out silently. One line + a deep-link into Settings →
                General (the Choose button above also works for this session). */}
            {!success && !exporting && !exportOpts.folder && (
              <div className="cp-folder-nudge">
                No output folder set. Choose one above, or{" "}
                <button type="button" className="cp-folder-nudge-link" onClick={onOpenGeneralSettings}>
                  set a default in Settings
                </button>
              </div>
            )}
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
            {/* Grouped by source: the newest export leads; the chevron
                reveals older exports from the same source. Storage stays
                flat — grouping is purely presentational. */}
            {groupedRecents.map((g) => (
              <div className="cp-recent-group" key={g.lead.id}>
                <div className="cp-recent" {...recentRowProps(g.lead)}>
                  <div className="thumb">
                    {g.lead.thumbnail && (
                      <img
                        src={g.lead.thumbnail}
                        alt=""
                        referrerPolicy="no-referrer"
                        // Recents persisted before posters became cache files
                        // can carry a dead blob: URL (they die with the page);
                        // break to the empty thumb square, not a broken-image
                        // glyph.
                        onError={(e) => e.currentTarget.classList.add("cp-thumb-dead")}
                      />
                    )}
                  </div>
                  <div className="body">
                    <div className="title" title={decodeHtmlEntities(g.lead.title)}>{decodeHtmlEntities(g.lead.title)}</div>
                    {recentMeta(g.lead)}
                  </div>
                  {g.rest.length > 0 && (
                    <button
                      className={"btn-icon cp-recent-chev" + (openGroups.has(groupKey(g.lead)) ? " open" : "")}
                      title={openGroups.has(groupKey(g.lead)) ? "Hide older exports" : `${g.rest.length} more from this source`}
                      aria-label={openGroups.has(groupKey(g.lead)) ? "Hide older exports" : `Show ${g.rest.length} older exports`}
                      aria-expanded={openGroups.has(groupKey(g.lead))}
                      onClick={(e) => { e.stopPropagation(); toggleGroup(groupKey(g.lead)); }}
                    >
                      <IconChevronRight size={12} />
                    </button>
                  )}
                  {recentReveal(g.lead.path)}
                </div>
                {openGroups.has(groupKey(g.lead)) && g.rest.map((r) => (
                  <div className="cp-recent nested" key={r.id} {...recentRowProps(r)}>
                    <div className="body">{recentMeta(r)}</div>
                    {recentReveal(r.path)}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}
    </aside>
  );
}
