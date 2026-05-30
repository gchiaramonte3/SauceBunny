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
};

/**
 * Wraps a native <video> or <audio> element with `controls={false}` so the
 * app's transport bar is the single source of truth for playback. Exposes
 * the same imperative handle as YouTubePlayer.
 */
export const LocalMediaPlayer = memo(forwardRef<PlayerHandle, Props>(function LocalMediaPlayer(
  { path, filename, hasVideo, initialVolume, onTimeUpdate, onPlayStateChange, onReady, onError, onSurfaceClick },
  ref,
) {
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const readyRef = useRef(false);
  const playingRef = useRef(false);
  // Shuttle (J-K-L): forward = native playbackRate; reverse = backward
  // currentTime scan (the whole local file is buffered, so it's smooth).
  const shuttleRateRef = useRef(0);
  const shuttleTimerRef = useRef(0);
  const [isPlaying, setIsPlaying] = useState(false);

  useImperativeHandle(ref, () => ({
    play: () => {
      const el = mediaRef.current;
      if (!el) return;
      el.play().catch((err) => {
        // NotAllowedError → autoplay blocked (need user gesture)
        // NotSupportedError → codec/source issue
        onError?.(`Playback failed: ${err?.name ?? "Error"} — ${err?.message ?? String(err)}`);
      });
    },
    pause: () => { mediaRef.current?.pause(); },
    seekTo: (s) => { if (mediaRef.current) mediaRef.current.currentTime = Math.max(0, s); },
    getCurrentTime: () => mediaRef.current?.currentTime ?? 0,
    getDuration: () => mediaRef.current?.duration ?? 0,
    isReady: () => readyRef.current,
    isPlaying: () => playingRef.current,
    setVolume: (v) => { if (mediaRef.current) mediaRef.current.volume = Math.max(0, Math.min(1, v)); },
    getVolume: () => mediaRef.current?.volume ?? 1,
    setMuted: (m) => { if (mediaRef.current) mediaRef.current.muted = m; },
    isMuted: () => mediaRef.current?.muted ?? false,
    setShuttle: (rate) => {
      const m = mediaRef.current;
      if (!m) return;
      if (shuttleTimerRef.current) { window.clearInterval(shuttleTimerRef.current); shuttleTimerRef.current = 0; }
      shuttleRateRef.current = rate;
      if (rate === 0) { m.playbackRate = 1; return; }
      if (rate > 0) {
        m.playbackRate = rate;
        m.play().catch(() => { /* ignore */ });
        return;
      }
      // Reverse: <video> can't play backward; scan currentTime backward. The
      // whole local file is buffered, so this is smooth across the clip.
      m.playbackRate = 1;
      try { m.pause(); } catch { /* ignore */ }
      setIsPlaying(true);
      const stepMs = 60;
      shuttleTimerRef.current = window.setInterval(() => {
        const mm = mediaRef.current;
        if (!mm) return;
        const next = mm.currentTime + rate * (stepMs / 1000); // rate<0 → backward
        if (next <= 0) {
          try { mm.currentTime = 0; } catch { /* ignore */ }
          window.clearInterval(shuttleTimerRef.current); shuttleTimerRef.current = 0;
          shuttleRateRef.current = 0;
          setIsPlaying(false);
          return;
        }
        try { mm.currentTime = next; } catch { /* ignore */ }
        onTimeUpdate?.(next);
      }, stepMs);
    },
  }), []);

  useEffect(() => {
    const el = mediaRef.current;
    if (!el) return;
    el.volume = Math.max(0, Math.min(1, initialVolume));
    const onLoaded = () => {
      readyRef.current = true;
      onReady?.(el.duration);
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
    const reportTime = () => onTimeUpdate?.(el.currentTime);
    const tick = () => { rafId = 0; if (!playingRef.current) return; reportTime(); rafId = requestAnimationFrame(tick); };
    const startTick = () => { if (!rafId) rafId = requestAnimationFrame(tick); };
    const onPlay  = () => { playingRef.current = true;  setIsPlaying(true);  onPlayStateChange?.(true); startTick(); };
    const onPause = () => {
      playingRef.current = false; setIsPlaying(false); onPlayStateChange?.(false);
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
      onError?.(`${label}: ${map[code] ?? "unknown"}${me?.message ? ` — ${me.message}` : ""} · src=${el.currentSrc || "(none)"}`);
    };
    el.addEventListener("loadedmetadata", onLoaded);
    el.addEventListener("play",  onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("error", onErr);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      if (shuttleTimerRef.current) { window.clearInterval(shuttleTimerRef.current); shuttleTimerRef.current = 0; }
      shuttleRateRef.current = 0;
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
              <IconFilm size={28} stroke="rgba(255,255,255,0.5)" />
              {isPlaying && (
                <div className="cp-eq">
                  <span /><span /><span /><span />
                </div>
              )}
            </div>
            <div className="cp-audio-name">{filename ?? "Local audio"}</div>
            <div className="cp-audio-hint">
              {isPlaying ? "Now playing — use the transport below to scrub." : "Press play to start. Volume is in the transport bar."}
            </div>
          </div>
        </>
      )}
    </div>
  );
}));
