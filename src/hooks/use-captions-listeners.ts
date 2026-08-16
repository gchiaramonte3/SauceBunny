import { useEffect, type Dispatch, type SetStateAction, type MutableRefObject } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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

  useEffect(() => {
      const unlistens: UnlistenFn[] = [];
      let mounted = true;
      (async () => {
        const onCaptionsLog = (e: { payload: LogEvent }) => {
          if (!mounted || e.payload.job_id !== captionsJobIdRef.current) return;
          appendLog(asLogTag(e.payload.tag), "captions", e.payload.line);
        };
        const d = await listen<LogEvent>("captions-log", onCaptionsLog);
        const onCaptionsDone = (e: { payload: DoneEvent }) => {
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
        };
        const f = await listen<DoneEvent>("captions-done", onCaptionsDone);
        unlistens.push(d, f);
        // A cleanup that fires DURING the awaits above finds an empty array
        // and unregisters nothing — under StrictMode that leaked every
        // listener on each dev boot. The handlers are inert either way (each
        // starts with a `mounted` check) but stayed registered forever.
        if (!mounted) {
          unlistens.forEach((u) => u());
          unlistens.length = 0;
        }
      })();
      return () => {
        mounted = false;
        unlistens.forEach((u) => u());
      };
      // Every dep here is stable (empty deps of its own), so this runs once
      // for the app's lifetime and never re-subscribes.
        // Eight stable references, so this subscribes once and never
    // re-subscribes.
  }, [appendLog, setCaptionsState, setCaptionsError, setActiveTranscript,
      setTranscriptArrivedTick, captionsJobIdRef, clipSourceKeyRef, metadataRef]);
}
