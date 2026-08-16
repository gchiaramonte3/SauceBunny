import { useEffect, type Dispatch, type SetStateAction, type MutableRefObject } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DoneEvent } from "../bindings/DoneEvent";
import type { LogEvent } from "../bindings/LogEvent";
import type { ProgressEvent } from "../bindings/ProgressEvent";
import type { ClientLog } from "../types";
import { asLogTag } from "../types";

/**
 * ffmpeg's transcode-for-playback, plus llama-server's stderr.
 *
 * Two unrelated-looking channels in one hook because they share a shape: both
 * are long-lived subscriptions that only append to the pipeline log, and
 * neither owns any UI state beyond a progress number. Splitting them would be
 * two files with four lines of difference.
 *
 * `llm-log` is the one without a job-id filter, deliberately: the other three
 * are per-run channels, while llama-server is a single long-lived process that
 * always reports as "llm-server". Adding a filter there would silence it — and
 * it was already silent once, emitted by Rust with nothing listening, for as
 * long as the AI Summary feature had shipped.
 *
 * Lifted out of App.tsx with the body captured verbatim rather than retyped.
 */

export type UsePlaybackPrepListenersDeps = {
  appendLog: (tag: ClientLog["tag"], source: string, message: string) => void;
  setPlaybackPrepProgress: Dispatch<SetStateAction<number>>;
  playbackPrepJobIdRef: MutableRefObject<string | null>;
  /** The in-flight prep's promise, so the caller can await a transcode. A
   *  resolve/reject PAIR rather than a single callback — the caller awaits a
   *  path and a failed transcode has to throw, not return an empty string. */
  playbackPrepResolverRef: MutableRefObject<
    | { resolve: (path: string) => void; reject: (err: unknown) => void }
    | null
  >;
};

export function usePlaybackPrepListeners(d: UsePlaybackPrepListenersDeps): void {
  const { appendLog, setPlaybackPrepProgress, playbackPrepJobIdRef, playbackPrepResolverRef } = d;

  useEffect(() => {
    const unlistens: UnlistenFn[] = [];
    let mounted = true;
    (async () => {
      const onPlaybackPrepProgress = (e: { payload: ProgressEvent }) => {
        if (!mounted || e.payload.job_id !== playbackPrepJobIdRef.current) return;
        setPlaybackPrepProgress(e.payload.percent);
      };
      const k = await listen<ProgressEvent>("playback-prep-progress", onPlaybackPrepProgress);
      const onPlaybackPrepDone = (e: { payload: DoneEvent }) => {
        if (!mounted || e.payload.job_id !== playbackPrepJobIdRef.current) return;
        const resolver = playbackPrepResolverRef.current;
        playbackPrepResolverRef.current = null;
        if (e.payload.success && e.payload.path) {
          resolver?.resolve(e.payload.path);
        } else {
          resolver?.reject(e.payload.error ?? "Playback prep failed");
        }
      };
      const l = await listen<DoneEvent>("playback-prep-done", onPlaybackPrepDone);
      // Playback prep ffmpeg log lines — surface in the pipeline panel so
      // the user can see what's happening (codec choice, errors, etc).
      const onPlaybackPrepLog = (e: { payload: LogEvent }) => {
        if (!mounted || e.payload.job_id !== playbackPrepJobIdRef.current) return;
        appendLog(asLogTag(e.payload.tag), "playback-prep", e.payload.line);
      };
      const m = await listen<LogEvent>("playback-prep-log", onPlaybackPrepLog);
      // llama-server's stderr — model load progress and the reason a start
      // failed. Rust has emitted this since the AI Summary feature landed,
      // with a comment saying it drains to the Pipeline log; the listener was
      // never written, so every line went nowhere. That made a slow first
      // summary (a multi-GB model loading) indistinguishable from a hung one,
      // and a server that refused to start silent about why.
      //
      // No job-id filter: unlike the per-run channels above, this one is the
      // long-lived server and always reports job_id "llm-server".
      const onLlmLog = (e: { payload: LogEvent }) => {
        if (!mounted) return;
        appendLog(asLogTag(e.payload.tag), "llm", e.payload.line);
      };
      const n = await listen<LogEvent>("llm-log", onLlmLog);
      unlistens.push(k, l, m, n);
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
      // Four stable references, so this subscribes once and never
      // re-subscribes — what App's comment asserted, now enforced by the array.
    }, [appendLog, setPlaybackPrepProgress, playbackPrepJobIdRef, playbackPrepResolverRef]);
  }
