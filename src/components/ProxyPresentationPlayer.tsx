import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ResolvedPresentationSource } from "../bindings/ResolvedPresentationSource";
import type { PlayerHandle, SeekResult } from "./player-handle";
import { LocalMediaPlayer } from "./LocalMediaPlayer";
import { MediaBunnyPlayer } from "./MediaBunnyPlayer";
import { MSEStreamPlayer } from "./MSEStreamPlayer";

type Props = {
  proxyPath: string;
  presentation: ResolvedPresentationSource | null;
  filename?: string;
  initialVolume: number;
  scrubAudio: boolean;
  knownDuration?: number;
  onTimeUpdate?: (seconds: number) => void;
  onPlayStateChange?: (playing: boolean) => void;
  onRepresentationChange?: (representation: "proxy" | "presentation") => void;
  onReady?: (duration: number) => void;
  onError?: (message: string) => void;
  onDiag?: (tag: string, message: string) => void;
  onAudioDiag?: (tag: string, message: string) => void;
  onSurfaceClick?: () => void;
};

const unavailable = (target: number, presented: number): SeekResult => ({
  requestedSeconds: target,
  presentedSeconds: presented,
  status: "unavailable",
});

/**
 * One mounted playback stage with two explicit representations:
 *
 * - the completed local MediaBunny copy owns every active-drag frame;
 * - the expiring native/MSE source owns A/V once a landing is confirmed.
 *
 * The proxy canvas stays painted above presentation during a landing, so a
 * source swap or slow CDN seek can never replace the last useful frame with
 * black. Split A/V reaches MSE/ffmpeg only from `endScrub`/`seekTo`, once.
 */
export const ProxyPresentationPlayer = memo(forwardRef<PlayerHandle, Props>(function ProxyPresentationPlayer(
  {
    proxyPath, presentation, filename, initialVolume, scrubAudio, knownDuration,
    onTimeUpdate, onPlayStateChange, onReady, onError, onDiag, onAudioDiag,
    onSurfaceClick, onRepresentationChange,
  },
  ref,
) {
  const proxyRef = useRef<PlayerHandle | null>(null);
  const presentationRef = useRef<PlayerHandle | null>(null);
  const proxyReadyRef = useRef(false);
  const presentationReadyRef = useRef(false);
  const presentationFailedRef = useRef(false);
  const showProxyRef = useRef(true);
  const scrubbingRef = useRef(false);
  const landingRef = useRef(false);
  const resumeAfterScrubRef = useRef(false);
  const playingRef = useRef(false);
  const generationRef = useRef(0);
  const [showProxy, setShowProxyState] = useState(true);
  const [presentationReady, setPresentationReady] = useState(false);

  const representationChangedRef = useRef(onRepresentationChange);
  representationChangedRef.current = onRepresentationChange;
  const setShowProxy = useCallback((value: boolean) => {
    showProxyRef.current = value;
    setShowProxyState(value);
    representationChangedRef.current?.(value ? "proxy" : "presentation");
  }, []);
  const publishPlaying = useCallback((value: boolean) => {
    if (playingRef.current === value) return;
    playingRef.current = value;
    onPlayStateChange?.(value);
  }, [onPlayStateChange]);

  const handoffToPresentation = useCallback(async (seconds: number, resume: boolean): Promise<SeekResult> => {
    const high = presentationRef.current;
    const generation = generationRef.current;
    if (!high?.isReady() || presentationFailedRef.current) {
      return unavailable(seconds, proxyRef.current?.getCurrentTime() ?? seconds);
    }
    const result = await high.seekTo(seconds);
    if (generation !== generationRef.current) return { ...result, status: "superseded" };
    if (result.status === "presented") {
      setShowProxy(false);
      onTimeUpdate?.(result.presentedSeconds);
      if (resume) {
        await high.play();
        publishPlaying(true);
      }
    }
    return result;
  }, [onTimeUpdate, publishPlaying, setShowProxy]);

  const handlePresentationReady = () => {
    presentationReadyRef.current = true;
    setPresentationReady(true);
    if (scrubbingRef.current || landingRef.current) return;
    const proxy = proxyRef.current;
    const at = proxy?.getCurrentTime() ?? 0;
    const resume = playingRef.current || !!proxy?.isPlaying();
    proxy?.pause();
    landingRef.current = true;
    void handoffToPresentation(at, resume).finally(() => { landingRef.current = false; });
  };

  const handlePresentationError = (message: string) => {
    presentationFailedRef.current = true;
    presentationReadyRef.current = false;
    setPresentationReady(false);
    onDiag?.("warn", `presentation fallback: ${message}`);
    const high = presentationRef.current;
    const at = high?.getCurrentTime() ?? proxyRef.current?.getCurrentTime() ?? 0;
    const resume = playingRef.current || !!high?.isPlaying();
    high?.pause();
    setShowProxy(true);
    void proxyRef.current?.seekTo(at).then((result) => {
      if (result.status === "presented") onTimeUpdate?.(result.presentedSeconds);
      if (resume) void proxyRef.current?.play();
    });
  };

  useEffect(() => {
    generationRef.current += 1;
    presentationReadyRef.current = false;
    presentationFailedRef.current = false;
    setPresentationReady(false);
    setShowProxy(true);
  }, [presentation, setShowProxy]);

  useImperativeHandle(ref, () => ({
    play: () => {
      const high = presentationRef.current;
      if (!showProxyRef.current && high?.isReady()) {
        void high.play();
        return;
      }
      if (presentationReadyRef.current && !presentationFailedRef.current) {
        const at = proxyRef.current?.getCurrentTime() ?? 0;
        landingRef.current = true;
        void handoffToPresentation(at, true).finally(() => { landingRef.current = false; });
      } else {
        void proxyRef.current?.play();
      }
    },
    pause: () => {
      resumeAfterScrubRef.current = false;
      proxyRef.current?.pause();
      presentationRef.current?.pause();
      publishPlaying(false);
    },
    seekTo: async (seconds) => {
      const target = Math.max(0, seconds);
      const generation = ++generationRef.current;
      landingRef.current = true;
      setShowProxy(true);
      presentationRef.current?.pause();
      const proxyResult = proxyRef.current?.isReady()
        ? await proxyRef.current.seekTo(target)
        : unavailable(target, proxyRef.current?.getCurrentTime() ?? 0);
      if (generation !== generationRef.current) return { ...proxyResult, status: "superseded" };
      if (!presentationReadyRef.current || presentationFailedRef.current) {
        landingRef.current = false;
        if (proxyResult.status === "presented") onTimeUpdate?.(proxyResult.presentedSeconds);
        return proxyResult;
      }
      const result = await handoffToPresentation(target, playingRef.current);
      if (generation === generationRef.current) landingRef.current = false;
      return result;
    },
    beginScrub: () => {
      if (scrubbingRef.current) return;
      scrubbingRef.current = true;
      landingRef.current = false;
      generationRef.current += 1;
      resumeAfterScrubRef.current = playingRef.current
        || !!presentationRef.current?.isPlaying()
        || !!proxyRef.current?.isPlaying();
      presentationRef.current?.pause();
      proxyRef.current?.beginScrub();
      setShowProxy(true);
    },
    scrubTo: (seconds) => {
      if (!scrubbingRef.current) proxyRef.current?.beginScrub();
      scrubbingRef.current = true;
      proxyRef.current?.scrubTo(Math.max(0, seconds));
    },
    endScrub: async (seconds) => {
      const target = Math.max(0, seconds);
      const resume = resumeAfterScrubRef.current;
      resumeAfterScrubRef.current = false;
      scrubbingRef.current = false;
      landingRef.current = true;
      const generation = ++generationRef.current;
      const proxyResult = proxyRef.current?.isReady()
        ? await proxyRef.current.endScrub(target)
        : unavailable(target, proxyRef.current?.getCurrentTime() ?? 0);
      if (generation !== generationRef.current) return { ...proxyResult, status: "superseded" };
      if (!presentationReadyRef.current || presentationFailedRef.current) {
        landingRef.current = false;
        if (resume && !proxyRef.current?.isPlaying()) void proxyRef.current?.play();
        if (proxyResult.status === "presented") onTimeUpdate?.(proxyResult.presentedSeconds);
        return proxyResult;
      }
      const result = await handoffToPresentation(target, resume);
      if (generation === generationRef.current) landingRef.current = false;
      return result;
    },
    getCurrentTime: () => showProxyRef.current
      ? proxyRef.current?.getCurrentTime() ?? 0
      : presentationRef.current?.getCurrentTime() ?? 0,
    getDuration: () => proxyRef.current?.getDuration() ?? knownDuration ?? 0,
    isReady: () => proxyReadyRef.current,
    isPlaying: () => playingRef.current,
    setVolume: (value) => {
      proxyRef.current?.setVolume(value);
      presentationRef.current?.setVolume(value);
    },
    getVolume: () => (showProxyRef.current ? proxyRef.current : presentationRef.current)?.getVolume() ?? initialVolume,
    setMuted: (value) => {
      proxyRef.current?.setMuted(value);
      presentationRef.current?.setMuted(value);
    },
    isMuted: () => (showProxyRef.current ? proxyRef.current : presentationRef.current)?.isMuted() ?? false,
    setShuttle: (rate) => (showProxyRef.current ? proxyRef.current : presentationRef.current)?.setShuttle(rate),
    setPlaybackRate: (rate) => {
      proxyRef.current?.setPlaybackRate(rate);
      presentationRef.current?.setPlaybackRate(rate);
    },
    supportsPlaybackRate: presentationReady,
    getFrameBlob: (seconds, opts) => proxyRef.current?.getFrameBlob?.(seconds, opts) ?? Promise.resolve(null),
    getPosterDataUrl: () => (showProxyRef.current ? proxyRef.current : presentationRef.current)?.getPosterDataUrl?.()
      ?? Promise.resolve(null),
    getCaptureElement: () => (showProxyRef.current ? proxyRef.current : presentationRef.current)?.getCaptureElement?.() ?? null,
  }), [initialVolume, knownDuration, presentationReady, handoffToPresentation, onTimeUpdate, publishPlaying, setShowProxy]);

  const proxyLayerStyle = { opacity: showProxy ? 1 : 0, pointerEvents: showProxy ? "auto" : "none" } as const;
  const presentationLayerStyle = { opacity: showProxy ? 0 : 1, pointerEvents: showProxy ? "none" : "auto" } as const;
  return (
    <div className="cp-proxy-presentation">
      <div className="cp-playback-layer cp-playback-presentation" style={presentationLayerStyle} aria-hidden={showProxy}>
        {presentation && (presentation.kind === "split" ? (
          <MSEStreamPlayer
            ref={presentationRef}
            path={presentation.videoUrl}
            filename={filename}
            hasVideo
            audioStreamUrl={presentation.audioUrl}
            videoCodec={presentation.videoCodec ?? undefined}
            audioCodec={presentation.audioCodec ?? undefined}
            knownDuration={knownDuration}
            initialVolume={initialVolume}
            onTimeUpdate={(seconds) => { if (!showProxyRef.current && !landingRef.current) onTimeUpdate?.(seconds); }}
            onPlayStateChange={(playing) => { if (!showProxyRef.current && !scrubbingRef.current) publishPlaying(playing); }}
            onReady={handlePresentationReady}
            onError={handlePresentationError}
            onDiag={onDiag}
            onSurfaceClick={onSurfaceClick}
          />
        ) : (
          <LocalMediaPlayer
            ref={presentationRef}
            path={presentation.kind === "hls" ? presentation.manifestUrl : presentation.videoUrl}
            filename={filename}
            hasVideo
            initialVolume={initialVolume}
            onTimeUpdate={(seconds) => { if (!showProxyRef.current && !landingRef.current) onTimeUpdate?.(seconds); }}
            onPlayStateChange={(playing) => { if (!showProxyRef.current && !scrubbingRef.current) publishPlaying(playing); }}
            onReady={handlePresentationReady}
            onError={handlePresentationError}
            onDiag={onDiag}
            onSurfaceClick={onSurfaceClick}
          />
        ))}
      </div>
      <div className="cp-playback-layer cp-playback-proxy" style={proxyLayerStyle} aria-hidden={!showProxy}>
        <MediaBunnyPlayer
          ref={proxyRef}
          path={proxyPath}
          filename={filename}
          hasVideo
          initialVolume={initialVolume}
          scrubAudio={scrubAudio}
          onTimeUpdate={(seconds) => {
            if (showProxyRef.current && !scrubbingRef.current && !landingRef.current) onTimeUpdate?.(seconds);
          }}
          onPlayStateChange={(playing) => {
            if (showProxyRef.current && !scrubbingRef.current && !landingRef.current) publishPlaying(playing);
          }}
          onReady={(duration) => {
            proxyReadyRef.current = true;
            onReady?.(duration);
          }}
          onError={onError}
          onSurfaceClick={onSurfaceClick}
          onDiag={onAudioDiag}
        />
      </div>
    </div>
  );
}));
