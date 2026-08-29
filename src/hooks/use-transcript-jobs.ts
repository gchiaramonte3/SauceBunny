import { useCallback, type Dispatch, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ClientLog, ExportOpts, Metadata, SourceKind, WhisperModel } from "../types";
import type { ActiveTranscript } from "../lib/transcript-owner";
import type { Defaults } from "../components/SettingsModal";
import type { ToastKind } from "../components/CanvasToast";
import { formatError } from "../lib/error-format";
import { framesToTc } from "../lib/timecode";
import { sanitizeFilename } from "../lib/filename";
import { newJobId } from "../lib/job-id";
import { TRANSCRIPT_EXTENSIONS } from "../lib/import-extensions";
import { extractAudioAsWav16k } from "../lib/mediabunny-audio";
import {
  recordTranscript,
  removeEntry as removeTranscriptEntry,
  getHistory as getTranscriptHistory,
} from "../lib/transcript-history";

/** WebCodecs fast-extract limits. Moved with the seam: App.tsx declared them and
 *  nothing outside these handlers ever read them. */
const WEBCODECS_EXTRACT_MAX_SEC = 20 * 60;
const WEBCODECS_EXTRACT_TIMEOUT_MS = 120_000;

/** Enumerated by tsc from the moved block, not written from memory. Each type
 *  comes from the declaration the value still has in App.tsx. */
export type TranscriptJobsProps = {
  // Source identity + geometry
  metadata: Metadata | null;
  metadataRef: { current: Metadata | null };
  metadataLoading: boolean;
  sourceKind: SourceKind;
  localFilePath: string | null;
  localFilePathRef: { current: string | null };
  activeSourceUrlRef: { current: string | null };
  clipSourceKeyRef: { current: string | null };
  fps: number;
  durationFrames: number;
  inFrames: number | null;
  outFrames: number | null;
  exportOpts: ExportOpts;

  // Settings the pipeline reads
  defaults: Defaults;
  selectedModel: WhisperModel | undefined;
  cookiesBrowserOrNone: () => string | undefined;

  // Transcript state this seam owns the writing of
  activeTranscript: ActiveTranscript | null;
  activeTranscriptRef: { current: ActiveTranscript | null };
  setActiveTranscript: Dispatch<SetStateAction<ActiveTranscript | null>>;
  transcriptState: "idle" | "running" | "done" | "error";
  setTranscriptState: Dispatch<SetStateAction<"idle" | "running" | "done" | "error">>;
  setTranscriptError: Dispatch<SetStateAction<string | null>>;
  setTranscriptPhase: Dispatch<SetStateAction<string | null>>;
  setTranscriptProgress: Dispatch<SetStateAction<number>>;
  setTranscriptResolution: Dispatch<SetStateAction<"success" | "error" | null>>;
  setTranscriptJobId: Dispatch<SetStateAction<string | null>>;
  setTranscriptArrivedTick: Dispatch<SetStateAction<number>>;
  transcriptAbortRef: { current: AbortController | null };
  jobStartedRef: { current: number };
  stageClockRef: { current: { phase: string | null; at: number } };

  // Shell affordances
  appendLog: (tag: ClientLog["tag"], source: string, message: string) => void;
  pushNotification: (kind: ToastKind, title: string, body: string, path?: string) => void;
  openSourceView: () => void;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  /** The union is App's own; written out rather than guessed - the first
   *  attempt invented two tabs that do not exist and missed one that does. */
  setSettingsInitialTab: Dispatch<SetStateAction<"general" | "transcription" | "ai-summary" | "commands" | "about">>;
};


/**
 * Transcript job orchestration: generate, re-diarize, fix caption timing,
 * import from disk, clear.
 *
 * Lifted from App.tsx verbatim (r157). One cohesive subsystem with a single
 * consumer, following use-co-review / use-web-playback: the handlers move
 * together with the helper they share, and nothing about their bodies changed —
 * the same useCallback dependency arrays, in the same order.
 *
 * `ensureEngineModelReady` stays PRIVATE here. It had no callers outside the
 * seam, which is the tell that it was always an implementation detail of
 * generate/re-diarize rather than part of App's surface.
 */
export function useTranscriptJobs(p: TranscriptJobsProps) {
  // Destructured so the moved block below is byte-identical to what it was in
  // App.tsx - same locals, same names, same dependency arrays.
  const {
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
  } = p;

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

  /**
   * Is the active engine's model on disk? Bounces to Settings and returns
   * false when it is not; the caller just stops.
   *
   * One copy. This block was written out twice, verbatim, with the second
   * carrying a comment saying it "mirrors handleGenerateTranscript so
   * re-timing works with whichever engine is active" - which is exactly the
   * arrangement where the two drift and only one of them learns about the
   * next engine. The comment was right about the danger; it just could not
   * enforce anything.
   */
  const ensureEngineModelReady = useCallback(async (): Promise<boolean> => {
    if (defaults.transcriptionEngine === "parakeet") {
      const ready = await invoke<boolean>("parakeet_model_downloaded").catch(() => false);
      if (!ready) {
        setTranscriptState("error");
        setTranscriptError("The Parakeet model isn't downloaded yet. Opening Settings → Transcription.");
        setSettingsInitialTab("transcription");
        setSettingsOpen(true);
        return false;
      }
      return true;
    }
    if (!selectedModel?.downloaded) {
      setTranscriptState("error");
      setTranscriptError(`Whisper model "${defaults.whisperModel}" is not downloaded. Opening Settings → Transcription.`);
      setSettingsInitialTab("transcription");
      setSettingsOpen(true);
      return false;
    }
    return true;
  }, [defaults.transcriptionEngine, defaults.whisperModel, selectedModel?.downloaded, setSettingsInitialTab, setSettingsOpen, setTranscriptError, setTranscriptState]);

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
    if (!(await ensureEngineModelReady())) return;
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
      // Fresh abort scope for this run. The mediabunny audio extraction below
      // runs entirely in the browser before any cancelable backend job exists,
      // so Stop pivots on this controller to interrupt it (and to skip the
      // backend invoke if the user bailed mid-extraction).
      //
      // Armed and given its id without an await in between, so there is no
      // instant where the run exists and Stop has nothing to cancel with.
      // This used to be an await (see lib/job-id), and a Stop landing inside
      // it aborted the PREVIOUS run's controller while this one carried on
      // transcribing over a screen that already said "cancelled".
      const abort = new AbortController();
      transcriptAbortRef.current = abort;
      const id = newJobId();
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
          // RAW body, keyed by job id. This used to be
          // `Array.from(new Uint8Array(...))` feeding a `wav_bytes` field:
          // the extraction cap is 20 minutes of 16 kHz mono, so up to ~38 MB
          // was walked byte by byte into a JS array and then decimal-printed
          // into a ~130 MB JSON string, on the webview's main thread, with
          // the window frozen throughout. Rust lands the buffer on disk and
          // transcribe_prepared_wav reads the path.
          const bytes = new Uint8Array(await wavBlob.arrayBuffer());
          await invoke<string>("stage_prepared_wav", bytes, {
            headers: { "x-job-id": id },
          });
          // Checked AGAIN, because the staging above is still an await, and a
          // Stop landing in it would otherwise pass the check above and spawn
          // the job anyway - the same shape as the batch-transcribe cancel,
          // where the file finished and reported success after the user
          // pressed Stop. The staged WAV is left for the startup cache sweep.
          if (abort.signal.aborted) {
            transcriptAbortRef.current = null;
            return;
          }
          await invoke<string>("transcribe_prepared_wav", {
            args: {
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
              speed: defaults.transcriptionSpeed,
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
            speed: defaults.transcriptionSpeed,
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
  }, [ensureEngineModelReady, transcriptState, metadata, metadataLoading, exportOpts, fps, selectedModel, defaults.whisperModel,
      defaults.transcriptionEngine, defaults.useWebCodecsDecoder,
      defaults.detectSpeakers, defaults.expectedSpeakers, defaults.transcriptionLanguage,
      defaults.transcriptionSpeed,
      appendLog, resolveTranscriptOutDir, localFilePath, sourceKind,
      durationFrames, inFrames, outFrames, cookiesBrowserOrNone, jobStartedRef, setTranscriptError, setTranscriptJobId, setTranscriptPhase, setTranscriptProgress, setTranscriptResolution, setTranscriptState, stageClockRef, transcriptAbortRef]);

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
      // Armed, then given its id, with no await between - same reason as the
      // main transcription path above.
      const abort = new AbortController();
      transcriptAbortRef.current = abort;
      const id = newJobId();
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
  }, [activeTranscript, metadata, sourceKind, localFilePath, defaults.expectedSpeakers, appendLog, setTranscriptError, setTranscriptJobId, setTranscriptPhase, setTranscriptProgress, setTranscriptResolution, setTranscriptState, transcriptAbortRef]);

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
    if (!(await ensureEngineModelReady())) return;
    setTranscriptState("running");
    setTranscriptResolution(null); // clear any prior flash before a new run
    setTranscriptError(null);
    setTranscriptProgress(0);
    setTranscriptPhase(null);
    const engineLabel = engine === "parakeet" ? "Parakeet" : "Whisper";
    const txChannel = engine === "parakeet" ? "parakeet" : "whisper";
    appendLog("info", txChannel, `Re-transcribing for accurate caption timing with ${engineLabel} (reusing the cached audio)…`);
    try {
      // Armed, then given its id, with no await between - same reason as the
      // main transcription path above.
      const abort = new AbortController();
      transcriptAbortRef.current = abort;
      const id = newJobId();
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
  }, [ensureEngineModelReady, metadata, metadataLoading, exportOpts.folder, exportOpts.filename, resolveTranscriptOutDir,
      durationFrames, fps, defaults.whisperModel, defaults.transcriptionEngine, defaults.detectSpeakers,
      defaults.expectedSpeakers, defaults.transcriptionLanguage, appendLog, cookiesBrowserOrNone, setTranscriptError, setTranscriptJobId, setTranscriptPhase, setTranscriptProgress, setTranscriptResolution, setTranscriptState, transcriptAbortRef]);

  const handleOpenTranscriptionSettings = useCallback(() => {
    setSettingsInitialTab("transcription");
    setSettingsOpen(true);
  }, [setSettingsInitialTab, setSettingsOpen]);


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
  }, [activeTranscriptRef, setActiveTranscript]);

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
  }, [appendLog, pushNotification, openSourceView, activeSourceUrlRef, clipSourceKeyRef, localFilePathRef, metadataRef, setActiveTranscript, setTranscriptArrivedTick]);

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

  return {
    resolveTranscriptOutDir,
    handleGenerateTranscript,
    handleRediarize,
    handleFixCaptionTiming,
    handleOpenTranscriptionSettings,
    handleClearTranscript,
    loadTranscriptPath,
    handleImportTranscript,
  };
}
