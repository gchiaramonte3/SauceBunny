import { type Dispatch, type SetStateAction, type MutableRefObject } from "react";
import { useTauriListeners } from "./use-tauri-listeners";
import type { DoneEvent } from "../bindings/DoneEvent";
import type { LogEvent } from "../bindings/LogEvent";
import type { ProgressEvent } from "../bindings/ProgressEvent";
import type { ClientLog, Metadata } from "../types";
import type { ActiveTranscript } from "../lib/transcript-owner";
import type { ToastKind } from "../components/CanvasToast";
import { recordTranscript } from "../lib/transcript-history";
import { humanizeSpawnError } from "../lib/error-format";
import { fmtElapsed, stageLabel } from "../lib/elapsed";
import { asLogTag } from "../types";

/**
 * The five Tauri listeners the whisper + diarizer pipeline reports through.
 *
 * Lifted out of App.tsx whole, and the body is byte-identical to what was
 * there — the move is meant to be provably behaviour-neutral, so nothing was
 * "tidied" on the way.
 *
 * WHY THIS ONE. `use-diarizer-prepare.ts` says captions "looks similar and is
 * not [extractable]: its done-listener writes transcript state the Whisper
 * pipeline owns". That is still true of captions, and it is NOT true of this,
 * which is the Whisper pipeline itself — the owner rather than a borrower. Its
 * seventeen inputs look like a lot and are all STABLE references: six memoised
 * callbacks, seven `setState` functions React guarantees never change, and six
 * refs. A hook whose whole argument list is stable cannot re-subscribe, which
 * is what the original comment ("this runs once for the app's lifetime")
 * asserted and nothing enforced.
 *
 * What it buys beyond 135 lines out of a 6,900-line file: `transcript-done`
 * has three branches — success, the "Cancelled" special case, and a real
 * failure — and the middle one exists because a bare exit-code message from a
 * crashed whisper must NOT be absorbed as a user cancel. That distinction was
 * untestable while it lived inside App; now a synthetic event can prove it.
 */

/** The one phase payload the backend emits; declared inline in App before. */
type TranscriptPhasePayload = { job_id: string; phase: string };

export type UseTranscriptListenersDeps = {
  /** Stable callbacks, all `useCallback` with their own empty-ish deps. */
  appendLog: (tag: ClientLog["tag"], source: string, message: string) => void;
  refreshWhisperModels: () => void;
  notify: (title: string, body: string) => void;
  pushNotification: (kind: ToastKind, title: string, body: string, path?: string) => void;
  logRunTotals: () => void;
  /** Setters — stable by React's guarantee, so they cannot force a re-subscribe.
   *  Typed with App's own narrow unions rather than `string`: the first draft
   *  widened them and tsc refused, which is the check working. A hook that
   *  accepts a wider type than its caller owns is how a narrowed union quietly
   *  loses a member (see command-coverage-contract for the last time). */
  setTranscriptState: Dispatch<SetStateAction<"idle" | "running" | "done" | "error">>;
  setTranscriptResolution: Dispatch<SetStateAction<"success" | "error" | null>>;
  setTranscriptError: Dispatch<SetStateAction<string | null>>;
  setTranscriptProgress: Dispatch<SetStateAction<number>>;
  setTranscriptPhase: Dispatch<SetStateAction<string | null>>;
  setActiveTranscript: Dispatch<SetStateAction<ActiveTranscript | null>>;
  setTranscriptArrivedTick: Dispatch<SetStateAction<number>>;

  /** Latest-value refs the long-lived handlers read. */
  transcriptJobIdRef: MutableRefObject<string | null>;
  txChannelRef: MutableRefObject<string>;
  clipSourceKeyRef: MutableRefObject<string | null>;
  localFilePathRef: MutableRefObject<string | null>;
  metadataRef: MutableRefObject<Metadata | null>;
  stageClockRef: MutableRefObject<{ phase: string | null; at: number }>;
};

export function useTranscriptListeners(d: UseTranscriptListenersDeps): void {
  const {
    appendLog, refreshWhisperModels, notify, pushNotification, logRunTotals,
    setTranscriptState, setTranscriptResolution, setTranscriptError,
    setTranscriptProgress, setTranscriptPhase, setActiveTranscript, setTranscriptArrivedTick,
    transcriptJobIdRef, txChannelRef, clipSourceKeyRef, localFilePathRef,
    metadataRef, stageClockRef,
  } = d;

  useTauriListeners((on) => {
      const onTranscriptLog = (payload: LogEvent) => {
          if (payload.job_id !== transcriptJobIdRef.current) return;
        appendLog(asLogTag(payload.tag), txChannelRef.current, payload.line);
      };
      on<LogEvent>("transcript-log", onTranscriptLog);
      const onTranscriptDone = (payload: DoneEvent) => {
          if (payload.job_id !== transcriptJobIdRef.current) return;
        if (payload.success && payload.path) {
          setTranscriptState("done");
          setTranscriptResolution("success"); // GenerateButton → check flash
          setTranscriptError(null);
          setTranscriptProgress(100);
          setTranscriptPhase(null);
          const filename = payload.path.split("/").pop() ?? "Transcript ready.";
          logRunTotals();
          appendLog("ok", txChannelRef.current, `Transcript saved → ${payload.path}`);
          // Load into the Transcript tab (same pulse-and-switch behavior
          // as the captions path above).
          setActiveTranscript({ path: payload.path, origin: "whisper", sourceKey: clipSourceKeyRef.current });
          setTranscriptArrivedTick((n) => n + 1);
          // Append to history (per-source) so the Transcript-tab popover
          // surfaces it and a re-import auto-loads it.
          try {
            const meta = metadataRef.current;
            recordTranscript({
              srtPath: payload.path,
              sourcePath: localFilePathRef.current,
              sourceUrl: meta?.webpage_url ?? null,
              title: meta?.title || (payload.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "transcript"),
              origin: "whisper",
            });
          } catch { /* quota */ }
          // Native OS notification keeps the filename for cross-window
          // context, but the in-app popover is intentionally one-line —
          // the new Transcript tab + pulse already shows the user where
          // the result landed, so the body text was redundant chrome.
          notify("Transcript ready", filename);
          pushNotification("success", "Transcript ready", "", payload.path);
          // Diarization is non-fatal: on success the backend still puts a note
          // in `error` if speaker detection was skipped. Surface it so a user
          // who asked for speakers isn't left wondering why there are none —
          // previously this only appeared in the pipeline log.
          if (payload.error) {
            appendLog("warn", txChannelRef.current, payload.error);
            pushNotification("info", "Speakers not detected", payload.error);
          }
        } else if (payload.error === "Cancelled") {
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
          const msg = humanizeSpawnError(payload.error ?? "Transcription failed");
          logRunTotals();
          setTranscriptError(msg);
          appendLog("err", txChannelRef.current, msg);
          notify("Transcript failed", msg);
          pushNotification("error", "Transcript failed", msg);
        }
      };
      on<DoneEvent>("transcript-done", onTranscriptDone);
      const onModelDownloadDone = (payload: DoneEvent) => {
        if (payload.success) {
          refreshWhisperModels();
          const filename = payload.path?.split("/").pop() ?? "Downloaded.";
          notify("Whisper model ready", filename);
          pushNotification("success", "Whisper model ready", filename, payload.path ?? undefined);
        } else if (payload.error) {
          pushNotification("error", "Model download failed", payload.error);
        }
      };
      on<DoneEvent>("model-download-done", onModelDownloadDone);
      const onTranscriptProgress = (payload: ProgressEvent) => {
          if (payload.job_id !== transcriptJobIdRef.current) return;
        setTranscriptProgress(payload.percent);
      };
      on<ProgressEvent>("transcript-progress", onTranscriptProgress);
      // Transcript stage marker — drives the Sidebar phase indicator.
      // Backend emits this at well-known transitions; the frontend
      // doesn't need to scrape pipeline log strings.
      const onTranscriptPhase = (payload: TranscriptPhasePayload) => {
          if (payload.job_id !== transcriptJobIdRef.current) return;
        // Close out the previous stage in the pipeline log. Every long
        // pipeline reports its phases through this one event, so timing them
        // here covers whisper, parakeet and each diarize step at once - and
        // gives a number the user can read off and paste back when something
        // is slower than it should be.
        const stage = stageClockRef.current;
        if (stage.phase && stage.phase !== payload.phase) {
          appendLog("info", txChannelRef.current,
            `${stageLabel(stage.phase)} finished in ${fmtElapsed(Date.now() - stage.at)}.`);
        }
        if (stage.phase !== payload.phase) {
          stageClockRef.current = { phase: payload.phase, at: Date.now() };
          // Each stage owns its own 0-100 meter (extract %, then whisper %), so
          // reset on the transition — otherwise the pill would flash the prior
          // stage's trailing value (e.g. "Whisper 99%") until the next tick.
          setTranscriptProgress(0);
        }
        setTranscriptPhase(payload.phase);
      };
      on<TranscriptPhasePayload>("transcript-phase", onTranscriptPhase);
    // Every dep here is stable (empty deps of its own), so this runs once
    // for the app's lifetime and never re-subscribes.
  }, [
    appendLog, refreshWhisperModels, notify, pushNotification, logRunTotals,
    setTranscriptState, setTranscriptResolution, setTranscriptError,
    setTranscriptProgress, setTranscriptPhase, setActiveTranscript, setTranscriptArrivedTick,
    transcriptJobIdRef, txChannelRef, clipSourceKeyRef, localFilePathRef,
    metadataRef, stageClockRef,
    ]);
    }
