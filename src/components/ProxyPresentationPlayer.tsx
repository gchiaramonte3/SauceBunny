import { forwardRef, memo, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ResolvedPresentationSource } from "../bindings/ResolvedPresentationSource";
import type { PlayerHandle } from "./player-handle";
import { LocalMediaPlayer } from "./LocalMediaPlayer";
import { MediaBunnyPlayer } from "./MediaBunnyPlayer";
import { MSEStreamPlayer } from "./MSEStreamPlayer";
import { createPresentationPlayback, type PresentationMount } from "../lib/presentation-playback";

type Props = {
  proxyPath: string;
  presentation: ResolvedPresentationSource | null;
  filename?: string;
  initialVolume: number;
  onSourceExpired?: () => void;
  scrubAudio: boolean;
  knownDuration?: number;
  fps?: number;
  onTimeUpdate?: (seconds: number) => void;
  onPlayStateChange?: (playing: boolean) => void;
  onRepresentationChange?: (representation: "proxy" | "presentation") => void;
  onReady?: (duration: number) => void;
  onError?: (message: string) => void;
  onDiag?: (tag: string, message: string) => void;
  onAudioDiag?: (tag: string, message: string) => void;
  onSurfaceClick?: () => void;
};

const PlaybackStage = forwardRef<PlayerHandle, Props>(function PlaybackStage(props, ref) {
  const { proxyPath, presentation, filename, initialVolume, scrubAudio, knownDuration, onAudioDiag, onSurfaceClick } = props;
  const latest = useRef(props);
  latest.current = props;
  const proxyRef = useRef<PlayerHandle | null>(null);
  const highRef = useRef<PlayerHandle | null>(null);
  const [mount, setMount] = useState<PresentationMount | null>(null);
  const [showProxy, setShowProxy] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [controller] = useState(() => createPresentationPlayback({
    proxy: () => proxyRef.current,
    high: () => highRef.current,
    fps: () => latest.current.fps ?? 30,
    mount: setMount,
    representation: (value) => {
      setShowProxy(value === "proxy");
      latest.current.onRepresentationChange?.(value);
    },
    time: (seconds) => latest.current.onTimeUpdate?.(seconds),
    playing: (value) => { setPlaying(value); latest.current.onPlayStateChange?.(value); },
    diag: (tag, message) => latest.current.onDiag?.(tag, message),
    error: (message) => latest.current.onError?.(message),
  }));
  useEffect(() => { controller.activate(); return () => controller.dispose(); }, [controller]);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => controller.tick(), 16);
    return () => window.clearInterval(timer);
  }, [controller, playing]);
  useEffect(() => { controller.updateSource(presentation); }, [controller, presentation]);
  useEffect(() => { controller.setVolume(initialVolume); }, [controller, initialVolume]);

  useImperativeHandle(ref, () => ({
    play: controller.play,
    pause: controller.pause,
    seekTo: controller.seekTo,
    beginScrub: controller.beginScrub,
    scrubTo: controller.scrubTo,
    endScrub: controller.endScrub,
    getCurrentTime: controller.position,
    getDuration: () => proxyRef.current?.getDuration() ?? knownDuration ?? 0,
    isReady: () => proxyRef.current?.isReady() ?? false,
    isPlaying: controller.isPlaying,
    setVolume: controller.setVolume,
    getVolume: () => controller.current()?.getVolume() ?? initialVolume,
    setMuted: controller.setMuted,
    isMuted: controller.isMuted,
    setShuttle: controller.setShuttle,
    setPlaybackRate: controller.setRate,
    supportsPlaybackRate: !showProxy,
    getFrameBlob: (seconds, opts) => proxyRef.current?.getFrameBlob?.(seconds, opts) ?? Promise.resolve(null),
    getPosterDataUrl: () => controller.current()?.getPosterDataUrl?.() ?? Promise.resolve(null),
    getCaptureElement: () => controller.current()?.getCaptureElement?.() ?? null,
  }), [controller, showProxy, initialVolume, knownDuration]);

  const highEvents = mount ? {
    onTimeUpdate: (seconds: number) => controller.reportTime("presentation", seconds, mount.epoch),
    onPlayStateChange: (playing: boolean) => controller.reportPlaying("presentation", playing, mount.epoch),
    onReady: () => controller.ready(mount.epoch),
    onReadinessChange: () => controller.inspect(mount.epoch),
    onError: (message: string) => {
      if (!controller.acceptsEpoch(mount.epoch)) return;
      controller.error(mount.epoch, message);
      if (message.includes("[expired_url]")) latest.current.onSourceExpired?.();
    },
    onStall: () => controller.waiting(mount.epoch),
  } : {};
  return (
    <div className="cp-proxy-presentation">
      <div className="cp-playback-layer cp-playback-presentation"
        style={{ opacity: showProxy ? 0 : 1, pointerEvents: showProxy ? "none" : "auto" }} aria-hidden={showProxy}>
        {mount && (mount.source.kind === "split" ? (
          <MSEStreamPlayer key={mount.epoch} ref={highRef}
            path={mount.source.videoUrl} filename={filename} hasVideo
            audioStreamUrl={mount.source.audioUrl}
            videoCodec={mount.source.videoCodec ?? undefined} audioCodec={mount.source.audioCodec ?? undefined}
            knownDuration={knownDuration} startAtSeconds={mount.target} disableScrubPreview
            initialVolume={initialVolume} initiallyMuted sourceGeneration={mount.epoch} {...highEvents}
            onDiag={props.onDiag} onSurfaceClick={onSurfaceClick} />
        ) : (
          <LocalMediaPlayer key={mount.epoch} ref={highRef}
            path={mount.source.kind === "hls" ? mount.source.manifestUrl : mount.source.videoUrl}
            filename={filename} hasVideo initialVolume={initialVolume} initiallyMuted preload="metadata" requireAudio={!!mount.source.audioCodec}
            {...highEvents} onDiag={props.onDiag} onSurfaceClick={onSurfaceClick} />
        ))}
      </div>
      <div className="cp-playback-layer cp-playback-proxy"
        style={{ opacity: showProxy ? 1 : 0, pointerEvents: showProxy ? "auto" : "none" }} aria-hidden={!showProxy}>
        <MediaBunnyPlayer ref={proxyRef} path={proxyPath} filename={filename} hasVideo
          initialVolume={initialVolume} scrubAudio={scrubAudio}
          onTimeUpdate={(seconds) => controller.reportTime("proxy", seconds)}
          onPlayStateChange={(playing) => controller.reportPlaying("proxy", playing)}
          onReady={(duration) => { props.onReady?.(duration); controller.proxyReady(); }}
          onError={props.onError} onSurfaceClick={onSurfaceClick} onDiag={onAudioDiag} />
      </div>
    </div>
  );
});

/** A new represented file disposes all old preparation and transport promises. */
export const ProxyPresentationPlayer = memo(forwardRef<PlayerHandle, Props>(function ProxyPresentationPlayer(props, ref) {
  return <PlaybackStage key={props.proxyPath} {...props} ref={ref} />;
}));
