import {
  forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState,
} from "react";
import { assetUrl } from "../lib/asset-url";
import { BunnyMark } from "./BunnyMark";
import type { PlayerHandle, SeekResult } from "./player-handle";
import { confirmDecodedFrame } from "../lib/confirm-decoded-frame";
import { contiguousBufferAhead, contiguousRange, observeDecodedFrame, observedRequiredAudio, type DecodedObservation } from "../lib/presentation-readiness";

type Props = {
  path: string;
  filename?: string;
  /** True if the file actually has a video stream (vs. audio-only). */
  hasVideo: boolean;
  initialVolume: number; // 0..1
  /** Close the audio output from the first render, before readiness callbacks. */
  initiallyMuted?: boolean;
  requireAudio?: boolean;
  onTimeUpdate?: (seconds: number) => void;
  onPlayStateChange?: (playing: boolean) => void;
  onReady?: (duration: number) => void;
  onReadinessChange?: () => void;
  onStall?: () => void;
  /** Only standby web presentation overrides this; local-file loading stays unchanged. */
  preload?: "auto" | "metadata";
  /** Surface any HTML5 media error (decode, network, src missing, etc). */
  onError?: (message: string) => void;
  onSurfaceClick?: () => void;
  /** Seek/duration diagnostics → the Pipeline log (channel "seek"). */
  onDiag?: (tag: string, message: string) => void;
};

/**
 * Wraps a native <video> or <audio> element with `controls={false}` so the
 * app's transport bar is the single source of truth for playback. Exposes
 * the same imperative handle as YouTubePlayer.
 */
export const LocalMediaPlayer = memo(forwardRef<PlayerHandle, Props>(function LocalMediaPlayer(
  { path, filename, hasVideo, initialVolume, initiallyMuted = false, requireAudio = false, onTimeUpdate, onPlayStateChange, onReady, onReadinessChange, onStall, preload = "auto", onError, onSurfaceClick, onDiag },
  ref,
) {
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const readyRef = useRef(false);
  const playingRef = useRef(false);
  const confirmedFrameRef = useRef<number | null>(null);
  const decodedObservationRef = useRef<DecodedObservation | null>(null);
  const readinessChangedRef = useRef(onReadinessChange);
  readinessChangedRef.current = onReadinessChange;
  const stallRef = useRef(onStall);
  stallRef.current = onStall;
  /**
   * Resume-after-idle forensics, LOCAL half.
   *
   * "Rest the app twenty minutes, come back, scrub, and it holds a long time
   * on the frame it was parked on." The streaming player already reports this
   * (MSEStreamPlayer's pausedAt/aheadAtPause), but that only covers web
   * sources and the local path has entirely different suspects: a WebKit
   * <video> whose decoder went cold, a dropped read cache, or App Nap
   * throttling the loop. Guessing between three causes that look identical
   * from the outside is how you optimise the wrong one, so measure instead.
   *
   * `readyState` is the discriminator. 4 (HAVE_ENOUGH_DATA) surviving the idle
   * means the element kept its buffer and the delay is elsewhere; a drop to
   * 0-2 means WebKit tore the decode pipeline down and the first seek after
   * resume is paying to rebuild it.
   */
  const pausedAtRef = useRef(0);
  /** One idle report per idle, not one per seek event inside a scrub. */
  const reportedIdleRef = useRef(false);
  const readyAtPauseRef = useRef(-1);
  const onDiagRef = useRef<Props["onDiag"]>(undefined);
  useEffect(() => { onDiagRef.current = onDiag; }, [onDiag]);
  // Latest-callback ref: the media effects below run on [path] only, so they
  // would close over the mount-time onTimeUpdate. App's callback converts
  // seconds to frames with the CURRENT fps; a mount-time capture uses the
  // pre-metadata fallback and republishes the playhead at the wrong ratio
  // (visible as post-seek backward slides). Matters here since the warm-boot
  // cached-copy fast path plays WEB sources whose fps hydrates late.
  const onTimeUpdateRef = useRef<Props["onTimeUpdate"]>(undefined);
  useEffect(() => { onTimeUpdateRef.current = onTimeUpdate; }, [onTimeUpdate]);
  // Shuttle (J-K-L): forward = native playbackRate (capped 8×); reverse = a
  // wall-clock rAF scan walking currentTime backward (the whole local file is
  // buffered, so it's smooth). Audio is muted while |rate| > 2 — the
  // pre-shuttle muted state is stashed so exit restores what the user had.
  const shuttleRateRef = useRef(0);
  const shuttleRafRef = useRef(0);
  const preShuttleMutedRef = useRef<boolean | null>(null);
  // User's persistent playback speed (Transport speed picker). The shuttle
  // temporarily owns `playbackRate`; every shuttle exit restores THIS value.
  const userRateRef = useRef(1);
  // Scrub hardening: the timeline explicitly opens/closes this gesture. The
  // player never guesses from a quiet period between seek calls.
  const scrubbingRef = useRef(false);
  const wasPlayingRef = useRef(false);
  const seekGenerationRef = useRef(0);
  const retriedLoadRef = useRef(false);
  const [isPlaying, setIsPlaying] = useState(false);

  /**
   * The imperative handle is built ONCE (deps `[]`) so `playerRef.current`
   * never changes identity under App — but that means it closes over the props
   * from the FIRST render, and `onMediaError` is an inline arrow in App,
   * rebuilt every render over live state (localFilePath, metadata,
   * playbackPrepBusy). A play() rejection therefore reported the failure
   * against render-1's world, where those are all still null.
   *
   * Reading the two callbacks through refs keeps both properties: the handle
   * stays stable, and the call always reaches the current prop.
   */
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onPlayStateChangeRef = useRef(onPlayStateChange);
  onPlayStateChangeRef.current = onPlayStateChange;

  const clampTarget = useCallback((seconds: number) => {
    const el = mediaRef.current;
    const duration = el?.duration;
    return Math.max(0, duration && isFinite(duration) ? Math.min(duration, seconds) : seconds);
  }, []);

  /** Resolve from a decoded-frame callback where available. `seeked` is the
   * compatibility fallback; the bounded timeout reports unavailable rather
   * than allowing a co-review command to remain pending forever. */
  const seekExact = useCallback((seconds: number): Promise<SeekResult> => {
    const el = mediaRef.current;
    const target = clampTarget(seconds);
    const generation = ++seekGenerationRef.current;
    confirmedFrameRef.current = null;
    if (!el) return Promise.resolve({ requestedSeconds: target, presentedSeconds: target, status: "unavailable" });
    onTimeUpdateRef.current?.(target);
    try { el.currentTime = target; }
    catch { return Promise.resolve({ requestedSeconds: target, presentedSeconds: el.currentTime || 0, status: "unavailable" }); }

    return new Promise<SeekResult>((resolve) => {
      let finished = false;
      let cancelFrame: (() => void) | undefined;
      const finish = (status: SeekResult["status"], presented = el.currentTime || target) => {
        if (finished) return;
        finished = true;
        window.clearTimeout(timeout);
        el.removeEventListener("seeked", onSeeked);
        cancelFrame?.();
        if (status === "presented") {
          confirmedFrameRef.current = presented;
          readinessChangedRef.current?.();
        }
        resolve({ requestedSeconds: target, presentedSeconds: presented, status });
      };
      const onSeeked = () => {
        if (generation !== seekGenerationRef.current) { finish("superseded"); return; }
        cancelFrame?.();
        cancelFrame = confirmDecodedFrame(el,
          () => generation === seekGenerationRef.current && mediaRef.current === el
            && Math.abs(el.currentTime - target) < 0.25,
          (at) => finish("presented", at));
      };
      const timeout = window.setTimeout(() => finish(
        generation === seekGenerationRef.current ? "unavailable" : "superseded",
      ), 2500);
      el.addEventListener("seeked", onSeeked, { once: true });
      // jsdom and a few already-landed WebKit paths do not emit seeked for a
      // zero-distance request. A decoded current frame is already confirmed.
      if (!el.seeking && Math.abs(el.currentTime - target) < 0.001 && el.readyState >= 2) {
        queueMicrotask(onSeeked);
      }
    });
  }, [clampTarget]);

  const beginScrub = useCallback(() => {
    if (scrubbingRef.current) return;
    const el = mediaRef.current;
    scrubbingRef.current = true;
    wasPlayingRef.current = !!el && !el.paused;
    if (el && !el.paused) { try { el.pause(); } catch { /* ignore */ } }
  }, []);

  const scrubTo = useCallback((seconds: number) => {
    const el = mediaRef.current;
    if (!el) return;
    if (!scrubbingRef.current) beginScrub();
    const target = clampTarget(seconds);
    onTimeUpdateRef.current?.(target);
    const fast = (el as HTMLMediaElement & { fastSeek?: (t: number) => void }).fastSeek;
    try { fast ? fast.call(el, target) : (el.currentTime = target); }
    catch { try { el.currentTime = target; } catch { /* ignore */ } }
  }, [beginScrub, clampTarget]);

  const endScrub = useCallback(async (seconds: number): Promise<SeekResult> => {
    const resume = wasPlayingRef.current;
    wasPlayingRef.current = false;
    const result = await seekExact(seconds);
    scrubbingRef.current = false;
    if (resume && result.status !== "superseded") {
      mediaRef.current?.play().catch(() => { /* gesture may have been cancelled */ });
    } else if (!resume) {
      playingRef.current = false;
      setIsPlaying(false);
      onPlayStateChangeRef.current?.(false);
    }
    return result;
  }, [seekExact]);

  // Standby promotion needs decoded frames, not HTML timeupdate clock ticks.
  useEffect(() => {
    const el = mediaRef.current as HTMLVideoElement | null;
    if (!hasVideo || !el?.requestVideoFrameCallback) return;
    let id = 0;
    const frame = (now: number, metadata: VideoFrameCallbackMetadata) => {
      id = 0;
      if (!el.seeking) {
        confirmedFrameRef.current = metadata.mediaTime;
        decodedObservationRef.current = observeDecodedFrame(decodedObservationRef.current, seekGenerationRef.current, metadata.mediaTime, now);
        readinessChangedRef.current?.();
      }
      if (!el.paused) id = el.requestVideoFrameCallback(frame);
    };
    const start = () => { if (!id) id = el.requestVideoFrameCallback(frame); };
    el.addEventListener("playing", start);
    start();
    return () => { el.removeEventListener("playing", start); if (id) el.cancelVideoFrameCallback(id); };
  }, [path, hasVideo]);

  useImperativeHandle(ref, () => ({
    // The element a live session captures to show a peer what the
    // presenter is watching. See lib/viewer-capture.ts.
    getCaptureElement: () => mediaRef.current,
    play: () => {
      const el = mediaRef.current;
      if (!el) return;
      // Explicit play supersedes any active scrub landing.
      scrubbingRef.current = false;
      wasPlayingRef.current = false;
      el.play().catch((err) => {
        // AbortError → benign: a pause()/src change interrupted the pending
        // play() per spec (scrub gestures do this constantly). Reporting it
        // as fatal tore down working players — swallow it.
        // NotAllowedError → autoplay blocked (need user gesture)
        // NotSupportedError → codec/source issue
        if ((err as DOMException)?.name === "AbortError") return;
        onErrorRef.current?.(`Playback failed: ${err?.name ?? "Error"}: ${err?.message ?? String(err)}`);
      });
    },
    pause: () => {
      // Explicit pause cancels the scrub-resume so we don't restart playback.
      scrubbingRef.current = false;
      wasPlayingRef.current = false;
      seekGenerationRef.current++;
      const el = mediaRef.current;
      const alreadyPaused = !el || el.paused;
      el?.pause();
      // If the element was already paused (e.g. the scrub path paused it mid-
      // drag), no native 'pause' event fires, so onPause won't run and App would
      // stay isPlaying=true. Notify directly to keep the play-state honest.
      if (alreadyPaused) {
        playingRef.current = false;
        setIsPlaying(false);
        onPlayStateChangeRef.current?.(false);
      }
    },
    seekTo: seekExact,
    beginScrub,
    scrubTo,
    endScrub,
    getCurrentTime: () => mediaRef.current?.currentTime ?? 0,
    getDuration: () => mediaRef.current?.duration ?? 0,
    isReady: () => readyRef.current,
    getPlaybackReadiness: () => {
      const el = mediaRef.current;
      const observed = decodedObservationRef.current;
      const range = el ? contiguousRange(el.buffered, el.currentTime) : undefined;
      return {
        generation: seekGenerationRef.current,
        confirmedSeconds: confirmedFrameRef.current,
        bufferedAheadSeconds: el ? contiguousBufferAhead(el.buffered, el.currentTime) : 0,
        durationSeconds: el?.duration ?? 0,
        seeking: !el || el.seeking,
        failed: !!el?.error,
        hasFutureData: !!el && el.readyState >= 3,
        hasRequiredTracks: observedRequiredAudio(el, requireAudio),
        sampledAtMs: observed?.generation === seekGenerationRef.current ? observed.sampledAtMs : undefined,
        advancingFrames: !el?.paused && observed?.generation === seekGenerationRef.current ? observed.advancingFrames : 0,
        bufferedStartSeconds: range?.[0], bufferedEndSeconds: range?.[1],
      };
    },
    isPlaying: () => playingRef.current,
    setVolume: (v) => { if (mediaRef.current) mediaRef.current.volume = Math.max(0, Math.min(1, v)); },
    getVolume: () => mediaRef.current?.volume ?? 1,
    setMuted: (m) => { if (mediaRef.current) mediaRef.current.muted = m; },
    isMuted: () => mediaRef.current?.muted ?? false,
    supportsPlaybackRate: true,
    setPlaybackRate: (rate) => {
      // Defensive clamp to WebKit's safe range; the app's list is 0.5–2×.
      const r = Math.max(0.25, Math.min(4, rate));
      userRateRef.current = r;
      const m = mediaRef.current;
      if (!m) return;
      // defaultPlaybackRate survives load() — the path-swap effect below calls
      // el.load(), whose reset lands on the default, so the rate sticks.
      m.defaultPlaybackRate = r;
      // A live shuttle owns playbackRate until it exits (setShuttle(0) restores).
      if (shuttleRateRef.current === 0) m.playbackRate = r;
    },
    setShuttle: (rate) => {
      const m = mediaRef.current;
      if (!m) return;
      if (shuttleRafRef.current) { cancelAnimationFrame(shuttleRafRef.current); shuttleRafRef.current = 0; }
      // Entering shuttle from rest → remember the user's muted state once;
      // rate adjustments mid-shuttle keep the original value for restore.
      if (rate !== 0 && shuttleRateRef.current === 0) preShuttleMutedRef.current = m.muted;
      shuttleRateRef.current = rate;
      if (rate === 0) {
        // Back to the user's chosen speed, not a hardcoded 1× — the shuttle is
        // a transient override on top of the persistent rate.
        m.playbackRate = userRateRef.current;
        if (preShuttleMutedRef.current != null) { m.muted = preShuttleMutedRef.current; preShuttleMutedRef.current = null; }
        // Exit is a HARD STOP: K after an 8× shuttle must freeze, not glide on
        // at 1× ("slow motion"). The L-ladder's landing-on-+1 path explicitly
        // calls play() after this, so real playback still resumes there.
        try { m.pause(); } catch { /* ignore */ }
        return;
      }
      // Chipmunk audio above 2× is noise — mute there, audible at ≤2×.
      m.muted = Math.abs(rate) > 2 ? true : (preShuttleMutedRef.current ?? m.muted);
      if (rate > 0) {
        m.playbackRate = Math.min(8, rate); // defensive cap — the App ladder tops out here
        m.play().catch(() => { /* ignore */ });
        return;
      }
      // Reverse: <video> can't play backward; walk currentTime backward on a
      // wall-clock rAF so the scan speed is |rate|× real time regardless of
      // frame cadence. The whole local file is buffered, so it's smooth.
      m.playbackRate = 1;
      try { m.pause(); } catch { /* ignore */ }
      let last = performance.now();
      const tick = (now: number) => {
        shuttleRafRef.current = 0;
        const mm = mediaRef.current;
        const r = shuttleRateRef.current;
        if (!mm || r >= 0) return; // shuttle cancelled / direction changed
        const dt = (now - last) / 1000;
        last = now;
        const next = mm.currentTime + r * dt; // r<0 → backward
        if (next <= 0) {
          // Hit the head — exit the shuttle, settle paused at 0.
          try { mm.currentTime = 0; } catch { /* ignore */ }
          onTimeUpdateRef.current?.(0);
          shuttleRateRef.current = 0;
          mm.playbackRate = userRateRef.current; // self-exit restores the user rate too
          if (preShuttleMutedRef.current != null) { mm.muted = preShuttleMutedRef.current; preShuttleMutedRef.current = null; }
          setIsPlaying(false);
          return;
        }
        try { mm.currentTime = next; } catch { /* ignore */ }
        onTimeUpdateRef.current?.(next);
        shuttleRafRef.current = requestAnimationFrame(tick);
      };
      shuttleRafRef.current = requestAnimationFrame(tick);
    },
  }), [beginScrub, endScrub, scrubTo, seekExact, requireAudio]);

  useEffect(() => {
    const el = mediaRef.current;
    if (!el) return;
    el.volume = Math.max(0, Math.min(1, initialVolume));
    const onLoaded = () => {
      // Duration didn't parse (transient header read over asset://). Retry the
      // resource load once before accepting it; otherwise the timeline reads 0
      // and scrubbing is dead (seekFromX bails when durationFrames<=0).
      if ((!el.duration || !isFinite(el.duration)) && !retriedLoadRef.current) {
        retriedLoadRef.current = true;
        onDiagRef.current?.("warn", "duration unread; retrying native load once");
        try { el.load(); } catch { /* ignore */ }
        return;
      }
      readyRef.current = true;
      onReady?.(el.duration);
      onDiagRef.current?.("ok", `native player loaded · file duration ${(el.duration || 0).toFixed(1)}s`);
      // Nudge currentTime so the browser actually renders a frame instead
      // of leaving the canvas black until the user hits play.
      if (hasVideo && el.currentTime === 0) {
        try { el.currentTime = 0.001; } catch { /* ignore */ }
      }
    };
    // Drive the playhead from requestAnimationFrame while playing instead of the
    // <video>'s ~4Hz 'timeupdate' event, so it advances frame-by-frame rather
    // than skipping ~4 frames per tick. App floors to a frame number and React
    // bails when it's unchanged, so this only re-renders on a real frame change.
    let rafId = 0;
    const reportTime = () => {
      onTimeUpdateRef.current?.(el.currentTime);
    };
    const tick = () => { rafId = 0; if (!playingRef.current) return; reportTime(); rafId = requestAnimationFrame(tick); };
    const startTick = () => { if (!rafId) rafId = requestAnimationFrame(tick); };
    // While scrubbing we pause/resume the element internally — don't surface
    // those transitions to App, or the transport play/pause icon would flicker.
    const onPlay  = () => {
      playingRef.current = true;  setIsPlaying(true);
      if (!scrubbingRef.current) onPlayStateChange?.(true);
      startTick();
      // Only a real idle. Ordinary play/pause would drown the log.
      reportIdleResume("resume");
      pausedAtRef.current = 0;
    };
    const onPause = () => {
      pausedAtRef.current = Date.now();
      reportedIdleRef.current = false;
      readyAtPauseRef.current = el.readyState;
      playingRef.current = false; setIsPlaying(false);
      if (!scrubbingRef.current) onPlayStateChange?.(false);
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    };
    /**
     * The idle report, on the gesture that was actually reported.
     *
     * This used to fire only from onPlay, which measured the wrong thing: the
     * complaint is "I scrub twenty minutes later and it holds on the parked
     * frame", and a scrub does not start with a play. Firing it from the first
     * SEEK after an idle measures what the user feels.
     */
    const reportIdleResume = (gesture: string) => {
      const idleMs = pausedAtRef.current ? Date.now() - pausedAtRef.current : 0;
      if (idleMs <= 10_000 || reportedIdleRef.current) return;
      reportedIdleRef.current = true; // once per idle, not once per seek event
      const before = readyAtPauseRef.current;
      const after = el.readyState;
      const verdict = after >= 3
        ? "decoder warm (stall is elsewhere)"
        : before >= 3
          ? "DECODER TORN DOWN while idle. First seek rebuilds it"
          : "decoder was already cold at pause";
      onDiagRef.current?.(
        after >= 3 ? "info" : "warn",
        `${gesture} after ${Math.round(idleMs / 1000)}s idle: readyState ${before} → ${after}`
        + ` · buffered ${el.buffered.length} range(s) · ${verdict}`,
      );
    };
    const onSeeking = () => reportIdleResume("seek");
    const onTime  = () => reportTime(); // backstop while paused / on seek landing
    const onErr   = () => {
      const me = el.error;
      const map: Record<number, string> = {
        1: "MEDIA_ERR_ABORTED",
        2: "MEDIA_ERR_NETWORK",
        3: "MEDIA_ERR_DECODE",
        4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
      };
      const code = me?.code ?? 0;
      const label = hasVideo ? "Video error" : "Audio error";
      onError?.(`${label}: ${map[code] ?? "unknown"}${me?.message ? ` (${me.message})` : ""} · src=${el.currentSrc || "(none)"}`);
    };
    el.addEventListener("loadedmetadata", onLoaded);
    el.addEventListener("play",  onPlay);
    el.addEventListener("seeking", onSeeking);
    el.addEventListener("pause", onPause);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("error", onErr);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      if (shuttleRafRef.current) { cancelAnimationFrame(shuttleRafRef.current); shuttleRafRef.current = 0; }
      shuttleRateRef.current = 0;
      // Mid-shuttle source swap: give the element back its pre-shuttle audio.
      if (preShuttleMutedRef.current != null) { el.muted = preShuttleMutedRef.current; preShuttleMutedRef.current = null; }
      el.playbackRate = userRateRef.current; // clear any shuttle override, keep the user rate
      // New source → reset scrub bookkeeping + the one-shot duration retry.
      // Invalidate the latest command, not the generation at effect mount.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      seekGenerationRef.current++;
      scrubbingRef.current = false;
      confirmedFrameRef.current = null;
      readyRef.current = false;
      wasPlayingRef.current = false;
      retriedLoadRef.current = false;
      el.removeEventListener("loadedmetadata", onLoaded);
      el.removeEventListener("play",  onPlay);
      el.removeEventListener("seeking", onSeeking);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("error", onErr);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Pause-only on path change — when the playback prep finishes and we
  // swap from the original path to the prepared one, React updates
  // <video src> first, THEN runs this cleanup. If we strip the src here
  // we'd wipe React's just-applied URL and leave the element blank. So
  // we only pause, letting React's src swap take effect naturally.
  useEffect(() => {
    return () => {
      try { mediaRef.current?.pause(); } catch { /* ignore */ }
    };
  }, [path]);

  // Force a fresh WebKit load on path change. Safari has a longstanding
  // quirk: when an http(s) src fails (e.g. CORS-blocked / 403 cross-
  // origin), the <video> element holds onto that failed state even after
  // React updates the `src` attribute to a working URL. The new src never
  // gets fetched, scrubbing might work (because the element knows the
  // duration from a partial header read), but play() silently no-ops or
  // stalls. Calling .load() resets the resource selection algorithm and
  // re-fetches against whatever src is currently on the element.
  // See: https://html.spec.whatwg.org/multipage/media.html#dom-media-load
  useEffect(() => {
    const el = mediaRef.current;
    if (!el) return;
    // The new source isn't playable until it re-fires `loadeddata`, so report
    // not-ready meanwhile — otherwise callers (e.g. co-review transport sync)
    // act on the OLD source's stale ready state and seek the wrong video.
    readyRef.current = false;
    try { el.load(); } catch { /* ignore — happens on torn-down element */ }
  }, [path]);

  /**
   * Pay the decoder rebuild while the user is away, not on their first scrub.
   *
   * THE MEASUREMENT DRIVES THIS. If the diagnostic above reports "DECODER TORN
   * DOWN while idle", the cost the user feels is WebKit re-establishing the
   * decode pipeline, and that cost is paid by whatever gesture happens first —
   * which is the scrub they are watching. Doing it on window focus moves the
   * same work to a moment nobody is waiting on.
   *
   * A ZERO-DISTANCE SEEK, not .load(). load() resets the resource selection
   * algorithm and takes currentTime back to zero, which would throw away the
   * frame the user parked on — the exact thing they are trying to scrub away
   * from. Re-assigning currentTime to itself asks WebKit for a seek to where
   * we already are: the pipeline rebuilds, the position does not move.
   *
   * Guarded on being PAUSED and actually cold. Warming a warm decoder is a
   * pointless seek, and doing this mid-playback would stutter the thing it is
   * meant to help.
   */
  useEffect(() => {
    const warm = () => {
      const el = mediaRef.current;
      if (!el || !el.paused || el.readyState >= 3) return;
      if (!pausedAtRef.current || Date.now() - pausedAtRef.current < 10_000) return;
      try {
        const t = el.currentTime;
        el.currentTime = t;
        onDiagRef.current?.("info", `warmed the decoder on focus at ${t.toFixed(1)}s`);
      } catch { /* torn-down element */ }
    };
    // Both signals, because they catch different absences. `focus` fires when
    // the user was in ANOTHER app and came back. It does NOT fire for a window
    // that was merely covered or minimised and then revealed - that is
    // visibilitychange, and it is the case where the app was never defocused so
    // nothing else would ever warm it. The guard above makes the overlap free:
    // a warm decoder, a playing element, or a short idle all return early, so
    // arriving by both routes at once still costs one zero-distance seek.
    const onVisible = () => { if (!document.hidden) warm(); };
    window.addEventListener("focus", warm);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", warm);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // True-unmount cleanup — prevents an "imported MP3 keeps playing in
  // the background after the user pastes a YouTube URL" bug. Empty deps
  // means this fires only when the component actually leaves the tree,
  // not on every src swap.
  useEffect(() => {
    return () => {
      const el = mediaRef.current;
      if (!el) return;
      try {
        el.pause();
        el.removeAttribute("src");
        el.load();
      } catch { /* ignore */ }
      readyRef.current = false;
      playingRef.current = false;
    };
  }, []);

  // Two source modes:
  //   • http(s) URL → hand straight to <video src>. Covers both
  //     well-behaved CDNs (Vimeo/TikTok played directly) AND the
  //     localhost media proxy (http://127.0.0.1:<port>/v1/… from r58,
  //     used for YouTube and any Referer-gated CDN). WebKit's media
  //     engine streams both through its native Range/206 path.
  //   • Anything else → local file path → asset:// via assetUrl.
  // The path is either an $APPCACHE playback/download copy (static scope)
  // or a source probe_local_file granted per file. See lib/asset-url.ts.
  const src = /^https?:\/\//i.test(path) ? path : assetUrl(path);

  return (
    <div className="cp-local-media" onClick={onSurfaceClick}>
      {hasVideo ? (
        <video
          ref={(el) => { mediaRef.current = el; }}
          src={src}
          /* `auto` actually pulls bytes so the first frame renders without
             waiting for a user gesture — black canvas was the symptom of
             "metadata only loaded". */
          preload={preload}
          onProgress={() => readinessChangedRef.current?.()}
          onCanPlay={() => readinessChangedRef.current?.()}
          onWaiting={() => stallRef.current?.()}
          playsInline
          muted={initiallyMuted}
          className="cp-local-video"
        />
      ) : (
        <>
          {/* The audio element is the actual sound source — invisible. */}
          <audio
            ref={(el) => { mediaRef.current = el; }}
            src={src}
            preload={preload}
            muted={initiallyMuted}
          />
          {/* Visible card so the user can tell something is loaded and playing. */}
          <div className="cp-audio-card">
            <div className={"cp-audio-icon" + (isPlaying ? " playing" : "")}>
              <BunnyMark size={52} />
              {isPlaying && (
                <div className="cp-eq">
                  <span /><span /><span /><span />
                </div>
              )}
            </div>
            <div className="cp-audio-name">{filename ?? "Local audio"}</div>
            <div className="cp-audio-hint">
              {isPlaying ? "Now playing. Scrub with the transport below." : "Press play to start. Volume is in the transport bar."}
            </div>
          </div>
        </>
      )}
    </div>
  );
}));
