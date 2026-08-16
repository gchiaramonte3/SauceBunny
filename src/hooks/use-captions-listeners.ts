import { type Dispatch, type SetStateAction, type MutableRefObject } from "react";
import { useTauriListeners } from "./use-tauri-listeners";
import type { DoneEvent } from "../bindings/DoneEvent";
import type { LogEvent } from "../bindings/LogEvent";
import type { ClientLog, Metadata } from "../types";
import { asLogTag } from "../types";
import type { ActiveTranscript } from "../lib/transcript-owner";
import { recordTranscript } from "../lib/transcript-history";
import { humanizeSpawnError } from "../lib/error-format";

/**
 * yt-dlp's caption fetch — the OTHER way a transcript arrives.
 *
 * App.tsx and docs/ARCHITECTURE.md both said this one could not be lifted:
 * `captions-done` writes `setActiveTranscript` and `setTranscriptArrivedTick`,
 * "which the Whisper pipeline also owns", and a hook reaching back into App to
 * set them "would be a worse seam than the status quo".
 *
 * That was true when the Whisper pipeline was still inline. It is not any
 * more: use-transcript-listeners.ts takes the same two setters as arguments,
 * and so do the clip-export and playback-prep hooks. Neither pipeline owns
 * that state — App does, and both are handed it. The objection described a
 * seam that has since become the house pattern, so it no longer separates
 * captions from the three already extracted.
 *
 * What the old note got RIGHT is that the cohesive unit is transcript
 * ARRIVAL rather than captions. Two hooks writing the same two setters is
 * exactly that unit expressed as symmetry: whichever pipeline finishes hands
 * App the same pair, and the Transcript tab does not care which one it was.
 */

export type UseCaptionsListenersDeps = {
  appendLog: (tag: ClientLog["tag"], source: string, message: string) => void;
  setCaptionsState: Dispatch<SetStateAction<"idle" | "running" | "done" | "error">>;
  setCaptionsError: Dispatch<SetStateAction<string | null>>;
  /** Shared with the Whisper pipeline on purpose — see the note above. */
  setActiveTranscript: Dispatch<SetStateAction<ActiveTranscript | null>>;
  setTranscriptArrivedTick: Dispatch<SetStateAction<number>>;
  captionsJobIdRef: MutableRefObject<string | null>;
  clipSourceKeyRef: MutableRefObject<string | null>;
  metadataRef: MutableRefObject<Metadata | null>;
};

export function useCaptionsListeners(d: UseCaptionsListenersDeps): void {
  const {
    appendLog, setCaptionsState, setCaptionsError, setActiveTranscript,
    setTranscriptArrivedTick, captionsJobIdRef, clipSourceKeyRef, metadataRef,
  } = d;

  useTauriListeners((on) => {
      const onCaptionsLog = (payload: LogEvent) => {
          if (payload.job_id !== captionsJobIdRef.current) return;
        appendLog(asLogTag(payload.tag), "captions", payload.line);
      };
      on<LogEvent>("captions-log", onCaptionsLog);
      const onCaptionsDone = (payload: DoneEvent) => {
          if (payload.job_id !== captionsJobIdRef.current) return;
        if (payload.success && payload.path) {
          setCaptionsState("done");
          setCaptionsError(null);
          appendLog("ok", "captions", `Transcript saved → ${payload.path}`);
          // Load into the Transcript tab. Bumping arrivedTick triggers
          // the drawer to pulse / auto-switch tabs so the user sees the
          // result of the action they just took without having to hunt.
          setActiveTranscript({ path: payload.path, origin: "captions", sourceKey: clipSourceKeyRef.current });
          setTranscriptArrivedTick((n) => n + 1);
          // Append to history so the Transcript-tab popover lists it
          // and a future import of the same URL auto-loads it.
          try {
            const meta = metadataRef.current;
            recordTranscript({
              srtPath: payload.path,
              sourceUrl: meta?.webpage_url ?? null,
              sourcePath: null,
              title: meta?.title || (payload.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "transcript"),
              origin: "captions",
            });
          } catch { /* localStorage quota — non-fatal */ }
          // (No Finder reveal — the transcript loads into the panel; popping
          // Finder on every download was intrusive, especially on the auto
          // fetch from the CC toggle.)
        } else {
          setCaptionsState("error");
          const msg = humanizeSpawnError(payload.error ?? "Caption download failed");
          setCaptionsError(msg);
          appendLog("err", "captions", msg);
        }
      };
      on<DoneEvent>("captions-done", onCaptionsDone);
    // Every dep here is stable (empty deps of its own), so this runs once
    // for the app's lifetime and never re-subscribes.
      // Eight stable references, so this subscribes once and never
    // re-subscribes.
  }, [appendLog, setCaptionsState, setCaptionsError, setActiveTranscript,
    setTranscriptArrivedTick, captionsJobIdRef, clipSourceKeyRef, metadataRef]);
    }
