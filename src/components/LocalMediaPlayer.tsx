import {
  forwardRef, memo, useEffect, useImperativeHandle, useRef, useState,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { IconFilm } from "./Icons";
import type { PlayerHandle } from "./player-handle";

type Props = {
  path: string;
  filename?: string;
  /** True if the file actually has a video stream (vs. audio-only). */
  hasVideo: boolean;
  initialVolume: number; // 0..1
  onTimeUpdate?: (seconds: number) => void;
  onPlayStateChange?: (playing: boolean) => void;
  onReady?: (duration: number) => void;
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
  { path, filename, hasVideo, initialVolume, onTimeUpdate, onPlayStateChange, onReady, onError, onSurfaceClick, onDiag },
  ref,
) {
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const readyRef = useRef(false);
  const playingRef = useRef(false);
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
  // Scrub hardening: while the playhead is being dragged we pause the element
  // so continuous playback can't fight the seek, then resume once seeks settle.
  // (The streaming player has had this since r66; the local <video> never did,
  // which is why local scrubbing stuttered/stalled on WKWebView.)
  const scrubbingRef = useRef(false);
  const wasPlayingRef = useRef(false);
  const settleTimerRef = useRef(0);
  const retriedLoadRef = useRef(false);
  const [isPlaying, setIsPlaying] = useState(false);

  useImperativeHandle(ref, () => ({
    play: () => {
      const el = mediaRef.current;
      if (!el) return;
      // Explicit play cancels any pending scrub-resume so it can't double-fire.
      scrubbingRef.current = false;
      if (settleTimerRef.current) { window.clearTimeout(settleTimerRef.current); settleTimerRef.current = 0; }
      el.play().catch((err) => {
        // NotAllowedError → autoplay blocked (need user gesture)
        // NotSupportedError → codec/source issue
        onError?.(`Playback failed: ${err?.name ?? "Error"}: ${err?.message ?? String(err)}`);
      });
    },
    pause: () => {
      // Explicit pause cancels the scrub-resume so we don't restart playback.
      scrubbingRef.current = false;
      wasPlayingRef.current = false;
      if (settleTimerRef.current) { window.clearTimeout(settleTimerRef.current); settleTimerRef.current = 0; }
      const el = mediaRef.current;
      const alreadyPaused = !el || el.paused;
      el?.pause();
      // If the element was already paused (e.g. the scrub path paused it mid-
      // drag), no native 'pause' event fires, so onPause won't run and App would
      // stay isPlaying=true. Notify directly to keep the play-state honest.
      if (alreadyPaused) {
        playingRef.current = false;
        setIsPlaying(false);
        onPlayStateChange?.(false);
      }
    },
    seekTo: (s) => {
      const el = mediaRef.current;
      if (!el) return;
      const target = Math.max(0, s);
      // First seek of a drag opens a scrub window: pause so playback can't
      // race the playhead. Each subsequent seek just resets the settle timer;
      // we resume (only if we were playing) once seeks stop arriving. The
      // paused <video> still repaints the frame at each currentTime, so the
      // drag previews frame-by-frame instead of fighting the decoder.
      if (!scrubbingRef.current) {
        scrubbingRef.current = true;
        wasPlayingRef.current = !el.paused;
        if (!el.paused) { try { el.pause(); } catch { /* ignore */ } }
      }
      el.currentTime = target;
      onDiagRef.current?.("info",
        `seek → ${target.toFixed(1)}s (file duration ${(el.duration || 0).toFixed(1)}s, landed ${el.currentTime.toFixed(1)}s)`);
      if (settleTimerRef.current) window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = window.setTimeout(() => {
        settleTimerRef.current = 0;
        scrubbingRef.current = false;
        if (wasPlayingRef.current) mediaRef.current?.play().catch(() => { /* ignore */ });
      }, 200);
    },
    getCurrentTime: () => mediaRef.current?.currentTime ?? 0,
    getDuration: () => mediaRef.current?.duration ?? 0,
    isReady: () => readyRef.current,
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
  }), []);

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
    const reportTime = () => onTimeUpdateRef.current?.(el.currentTime);
    const tick = () => { rafId = 0; if (!playingRef.current) return; reportTime(); rafId = requestAnimationFrame(tick); };
    const startTick = () => { if (!rafId) rafId = requestAnimationFrame(tick); };
    // While scrubbing we pause/resume the element internally — don't surface
    // those transitions to App, or the transport play/pause icon would flicker.
    const onPlay  = () => { playingRef.current = true;  setIsPlaying(true);  if (!scrubbingRef.current) onPlayStateChange?.(true); startTick(); };
    const onPause = () => {
      playingRef.current = false; setIsPlaying(false);
      if (!scrubbingRef.current) onPlayStateChange?.(false);
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    };
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
    el.addEventListener("pause", onPause);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("error", onErr);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      if (shuttleRafRef.current) { cancelAnimationFrame(shuttleRafRef.current); shuttleRafRef.current = 0; }
      if (settleTimerRef.current) { window.clearTimeout(settleTimerRef.current); settleTimerRef.current = 0; }
      shuttleRateRef.current = 0;
      // Mid-shuttle source swap: give the element back its pre-shuttle audio.
      if (preShuttleMutedRef.current != null) { el.muted = preShuttleMutedRef.current; preShuttleMutedRef.current = null; }
      el.playbackRate = userRateRef.current; // clear any shuttle override, keep the user rate
      // New source → reset scrub bookkeeping + the one-shot duration retry.
      scrubbingRef.current = false;
      wasPlayingRef.current = false;
      retriedLoadRef.current = false;
      el.removeEventListener("loadedmetadata", onLoaded);
      el.removeEventListener("play",  onPlay);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Two source modes:
  //   • http(s) URL → hand straight to <video src>. Covers both
  //     well-behaved CDNs (Vimeo/TikTok played directly) AND the
  //     localhost media proxy (http://127.0.0.1:<port>/v1/… from r58,
  //     used for YouTube and any Referer-gated CDN). WebKit's media
  //     engine streams both through its native Range/206 path.
  //   • Anything else → local file path → asset:// via convertFileSrc.
  const src = /^https?:\/\//i.test(path) ? path : convertFileSrc(path);

  return (
    <div className="cp-local-media" onClick={onSurfaceClick}>
      {hasVideo ? (
        <video
          ref={(el) => { mediaRef.current = el; }}
          src={src}
          /* `auto` actually pulls bytes so the first frame renders without
             waiting for a user gesture — black canvas was the symptom of
             "metadata only loaded". */
          preload="auto"
          playsInline
          muted={false}
          className="cp-local-video"
        />
      ) : (
        <>
          {/* The audio element is the actual sound source — invisible. */}
          <audio
            ref={(el) => { mediaRef.current = el; }}
            src={src}
            preload="auto"
          />
          {/* Visible card so the user can tell something is loaded and playing. */}
          <div className="cp-audio-card">
            <div className={"cp-audio-icon" + (isPlaying ? " playing" : "")}>
              <IconFilm size={32} stroke="rgba(255,255,255,0.6)" />
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
