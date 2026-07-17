import {
  forwardRef, memo, useEffect, useImperativeHandle, useRef, useState,
} from "react";
import {
  Input, ALL_FORMATS,
  CanvasSink, AudioBufferSink,
  type InputVideoTrack, type InputAudioTrack, type WrappedCanvas,
} from "mediabunny";
import { mediabunnySource } from "../lib/mediabunny-source";
import { createScrubPump, type ScrubPump } from "../lib/scrub-pump";
import { IconFilm } from "./Icons";
import type { PlayerHandle } from "./player-handle";

/**
 * Alternative to LocalMediaPlayer that decodes the original file via
 * WebCodecs (through mediabunny) instead of relying on WKWebView's
 * <video> element. Pros: no ffmpeg pre-encode, plays any container/codec
 * the browser's WebCodecs supports (VP9, AV1, HEVC, …), frame-accurate
 * scrubbing. Cons: we own the playback clock, A/V sync, and seek logic.
 *
 * Architecture:
 *   • mediabunny's `Input` opens the file via UrlSource (range-fetch).
 *   • `CanvasSink` pre-decodes video frames into ready-to-draw canvases.
 *   • `AudioBufferSink` pre-decodes audio into Web Audio `AudioBuffer`s.
 *   • AudioContext.currentTime is the master playback clock — every audio
 *     chunk is scheduled at an exact context time, and the video render
 *     loop chases that clock by drawing the canvas whose timestamp is
 *     closest to (clock - epoch).
 *   • A generation counter (genRef) invalidates in-flight iterators on
 *     pause/seek so they bail without racing with the next start.
 */
type Props = {
  path: string;
  filename?: string;
  hasVideo: boolean;
  initialVolume: number; // 0..1
  onTimeUpdate?: (seconds: number) => void;
  onPlayStateChange?: (playing: boolean) => void;
  onReady?: (duration: number) => void;
  onError?: (message: string) => void;
  onSurfaceClick?: () => void;
};

export const MediaBunnyPlayer = memo(forwardRef<PlayerHandle, Props>(function MediaBunnyPlayer(
  { path, filename, hasVideo, initialVolume, onTimeUpdate, onPlayStateChange, onReady, onError, onSurfaceClick },
  ref,
) {
  // ─── Refs (mutable across renders without triggering re-render) ──────
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const inputRef = useRef<Input | null>(null);
  const videoTrackRef = useRef<InputVideoTrack | null>(null);
  const audioTrackRef = useRef<InputAudioTrack | null>(null);
  const videoSinkRef = useRef<CanvasSink | null>(null);
  const audioSinkRef = useRef<AudioBufferSink | null>(null);
  const durationRef = useRef<number>(0);
  const readyRef = useRef(false);
  const playingRef = useRef(false);
  const mutedRef = useRef(false);
  const volumeRef = useRef(initialVolume);

  /**
   * Master-clock anchor. While playing:
   *   media-time(now) = startMediaTime + (audioCtx.currentTime - startContextTime)
   * On pause we freeze startMediaTime to the current media-time and clear
   * startContextTime; on play (or seek-while-playing) we re-anchor both.
   */
  const startMediaTimeRef = useRef(0);
  const startContextTimeRef = useRef(0);
  // Shuttle (J-K-L): a separate, video-only loop that walks media-time at
  // `shuttleRate` and decodes each frame via the CanvasSink. Because it owns
  // its own clock + decodes any frame, MediaBunny does TRUE smooth forward AND
  // reverse — the normal audio/video loops are stopped while it runs.
  const shuttleRateRef = useRef(0);
  const shuttleRafRef = useRef(0);
  const shuttleTimeRef = useRef(0);
  const shuttleWasPlayingRef = useRef(false);
  const shuttleBusyRef = useRef(false);
  const lastShuttleWallRef = useRef(0);

  /**
   * Bumped on every pause/seek/teardown. In-flight async iterators read
   * their captured generation and break if it no longer matches — kills
   * the "previous decode loop schedules audio for a stale timeline" race.
   */
  const genRef = useRef(0);
  /** Audio source nodes currently scheduled — cancelled on stop/seek. */
  const scheduledRef = useRef<AudioBufferSourceNode[]>([]);
  /** Most recent drawn frame — kept so React renders stay idempotent. */
  const lastDrawnRef = useRef<HTMLCanvasElement | OffscreenCanvas | null>(null);
  /**
   * Latest-wins scrub decoder (paused-seek path). A fast drag calls seekTo
   * many times/sec; rather than spawn one getCanvas per call (decodes pile up,
   * the shown frame lags the cursor), this pump keeps only the NEWEST target
   * and decodes one at a time, dropping intermediate targets superseded while
   * a decode was in flight. Created lazily below.
   */
  const scrubPumpRef = useRef<ScrubPump | null>(null);

  // Driving a setState for the visible play/pause UI on audio-only mode.
  const [isPlaying, setIsPlaying] = useState(false);

  // ─── Helpers ────────────────────────────────────────────────────────
  const currentMediaTime = () => {
    if (!playingRef.current) return startMediaTimeRef.current;
    const ctx = audioCtxRef.current;
    if (!ctx) return startMediaTimeRef.current;
    return startMediaTimeRef.current + (ctx.currentTime - startContextTimeRef.current);
  };

  const drawCanvas = (src: HTMLCanvasElement | OffscreenCanvas) => {
    const dst = canvasRef.current;
    if (!dst) return;
    const w = src.width;
    const h = src.height;
    // Match intrinsic resolution so the source pixels aren't bilinearly
    // resampled — CSS handles the display scale via objectFit:contain.
    if (dst.width !== w || dst.height !== h) {
      dst.width = w;
      dst.height = h;
    }
    const ctx = dst.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(src, 0, 0, w, h);
    lastDrawnRef.current = src;
  };

  // Latest-wins scrub pump, created once. Its drain closes over refs only
  // (genRef/videoSinkRef and the ref-reading drawCanvas), so a first-render
  // closure stays correct across re-renders. The generation gate makes a
  // play()/seek-while-playing/teardown supersede an in-flight scrub frame:
  // the frame is still decoded but not painted, so it can't fight the
  // playback loop — yet the pump keeps draining any newer scrub target.
  if (!scrubPumpRef.current) {
    scrubPumpRef.current = createScrubPump(async (target: number) => {
      const gen = genRef.current;
      const sink = videoSinkRef.current;
      if (!sink) return;
      let wrapped: WrappedCanvas | null = null;
      try { wrapped = await sink.getCanvas(target); }
      catch { return; }
      if (gen === genRef.current && wrapped) drawCanvas(wrapped.canvas);
    });
  }

  /** Cancel all in-flight work without changing playing state. */
  const cancelInFlight = () => {
    genRef.current++;
    // Drop any pending scrub target too; the in-flight decode (if any) is
    // gated by the gen bump above and won't paint.
    scrubPumpRef.current?.cancel();
    for (const node of scheduledRef.current) {
      try { node.stop(); } catch { /* already stopped */ }
      try { node.disconnect(); } catch { /* ignore */ }
    }
    scheduledRef.current = [];
  };

  const stopPlayback = () => {
    if (playingRef.current) {
      startMediaTimeRef.current = currentMediaTime();
    }
    playingRef.current = false;
    setIsPlaying(false);
    onPlayStateChange?.(false);
    cancelInFlight();
  };

  // Shuttle render loop (J-K-L). Advances `shuttleTime` by `shuttleRate × dt`
  // each frame and draws the decoded frame at that time — forward OR reverse,
  // since getCanvas decodes any frame. Video-only (no audio during shuttle,
  // like a tape machine). A busy guard prevents decode backlog on slow frames.
  const startShuttleLoop = () => {
    if (shuttleRafRef.current) return;
    const step = () => {
      shuttleRafRef.current = 0;
      const rate = shuttleRateRef.current;
      if (rate === 0) return;
      if (shuttleBusyRef.current) { shuttleRafRef.current = requestAnimationFrame(step); return; }
      const now = performance.now();
      const dt = Math.min(0.1, Math.max(0, (now - lastShuttleWallRef.current) / 1000));
      lastShuttleWallRef.current = now;
      let t = shuttleTimeRef.current + rate * dt;
      let atBound = false;
      if (t <= 0) { t = 0; atBound = true; }
      else if (t >= durationRef.current) { t = durationRef.current; atBound = true; }
      shuttleTimeRef.current = t;
      onTimeUpdateRef.current?.(t);
      shuttleBusyRef.current = true;
      const sink = videoSinkRef.current;
      if (sink) {
        sink.getCanvas(t)
          .then((wrapped) => { if (wrapped && shuttleRateRef.current !== 0) drawCanvas(wrapped.canvas); })
          .catch(() => { /* ignore */ })
          .finally(() => { shuttleBusyRef.current = false; });
      } else {
        shuttleBusyRef.current = false;
      }
      if (atBound) {
        // Hit start/end — stop the shuttle, settle paused at the boundary.
        shuttleRateRef.current = 0;
        startMediaTimeRef.current = t;
        setIsPlaying(false);
        onPlayStateChange?.(false);
        return;
      }
      shuttleRafRef.current = requestAnimationFrame(step);
    };
    shuttleRafRef.current = requestAnimationFrame(step);
  };

  // Render-loop drainer for the canvas sink. Walks the async iterator,
  // sleeping until each frame's scheduled wall-clock time arrives.
  const runVideoLoop = async (fromTime: number, gen: number) => {
    const sink = videoSinkRef.current;
    const ctx = audioCtxRef.current;
    if (!sink || !ctx) return;
    try {
      for await (const wrapped of sink.canvases(fromTime, durationRef.current)) {
        if (gen !== genRef.current) return;
        const targetCtxTime = startContextTimeRef.current + (wrapped.timestamp - startMediaTimeRef.current);
        const waitMs = (targetCtxTime - ctx.currentTime) * 1000;
        if (waitMs > 0) {
          await new Promise<void>((r) => setTimeout(r, waitMs));
          if (gen !== genRef.current) return;
        }
        drawCanvas(wrapped.canvas);
      }
      // Reached end of stream — bounce back to paused at end timestamp.
      if (gen === genRef.current) {
        startMediaTimeRef.current = durationRef.current;
        playingRef.current = false;
        setIsPlaying(false);
        onPlayStateChange?.(false);
      }
    } catch (err) {
      if (gen === genRef.current) {
        onError?.(`Video decode failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  // Audio scheduler — every chunk is queued at its exact context-time so
  // WebAudio handles sample-level scheduling. No glitches, no resampling.
  const runAudioLoop = async (fromTime: number, gen: number) => {
    const sink = audioSinkRef.current;
    const ctx = audioCtxRef.current;
    const gain = gainRef.current;
    if (!sink || !ctx || !gain) return;
    try {
      for await (const wrapped of sink.buffers(fromTime, durationRef.current)) {
        if (gen !== genRef.current) return;
        const source = ctx.createBufferSource();
        source.buffer = wrapped.buffer;
        source.connect(gain);
        const targetCtxTime = startContextTimeRef.current + (wrapped.timestamp - startMediaTimeRef.current);
        if (targetCtxTime <= ctx.currentTime) {
          // We're behind — start immediately and offset into the chunk so
          // we don't double-play already-past samples.
          const offset = Math.max(0, ctx.currentTime - targetCtxTime);
          if (offset < wrapped.buffer.duration) source.start(0, offset);
        } else {
          source.start(targetCtxTime);
        }
        scheduledRef.current.push(source);
        source.onended = () => {
          const idx = scheduledRef.current.indexOf(source);
          if (idx >= 0) scheduledRef.current.splice(idx, 1);
        };
        // Backpressure: if we've scheduled more than ~3 seconds ahead of
        // the current clock, wait before pulling the next chunk so we
        // don't decode the whole file into memory upfront.
        const ahead = targetCtxTime + wrapped.buffer.duration - ctx.currentTime;
        if (ahead > 3.0) {
          await new Promise<void>((r) => setTimeout(r, (ahead - 2.0) * 1000));
          if (gen !== genRef.current) return;
        }
      }
    } catch (err) {
      if (gen === genRef.current) {
        onError?.(`Audio decode failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  // Periodic time-update tick for the parent's playhead — independent of
  // the decode loops so the UI updates smoothly even between frame draws.
  // Read onTimeUpdate via a ref so the interval (set once on mount with
  // [] deps) always calls the LATEST callback; without this the parent's
  // freshly-created inline handler would never be invoked, the playhead
  // would freeze the moment App.tsx re-rendered.
  const onTimeUpdateRef = useRef(onTimeUpdate);
  useEffect(() => { onTimeUpdateRef.current = onTimeUpdate; }, [onTimeUpdate]);
  useEffect(() => {
    const t = window.setInterval(() => {
      if (playingRef.current) onTimeUpdateRef.current?.(currentMediaTime());
    }, 100);
    return () => {
      window.clearInterval(t);
      if (shuttleRafRef.current) { cancelAnimationFrame(shuttleRafRef.current); shuttleRafRef.current = 0; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Public handle ──────────────────────────────────────────────────
  useImperativeHandle(ref, () => ({
    play: () => {
      if (!readyRef.current) return;
      const ctx = audioCtxRef.current;
      if (!ctx) return;
      // Resume the AudioContext if a previous user-gesture-less load left
      // it suspended (Safari is strict about this).
      if (ctx.state === "suspended") ctx.resume().catch(() => { /* ignore */ });
      cancelInFlight();
      const gen = ++genRef.current;
      // Re-anchor the master clock to "now starts playing from this time"
      startContextTimeRef.current = ctx.currentTime;
      // startMediaTime stays whatever it was — the resume point.
      playingRef.current = true;
      setIsPlaying(true);
      onPlayStateChange?.(true);
      runAudioLoop(startMediaTimeRef.current, gen);
      runVideoLoop(startMediaTimeRef.current, gen);
    },
    pause: () => stopPlayback(),
    seekTo: (s: number) => {
      const clamped = Math.max(0, Math.min(durationRef.current, s));
      const wasPlaying = playingRef.current;
      cancelInFlight();
      startMediaTimeRef.current = clamped;
      onTimeUpdate?.(clamped);
      if (wasPlaying) {
        const ctx = audioCtxRef.current;
        if (!ctx) return;
        if (ctx.state === "suspended") ctx.resume().catch(() => { /* ignore */ });
        const gen = ++genRef.current;
        startContextTimeRef.current = ctx.currentTime;
        runAudioLoop(clamped, gen);
        runVideoLoop(clamped, gen);
      } else {
        // Paused seek / scrub. Coalesce into the single-flight pump: record
        // the latest target and let it chase the cursor, dropping intermediate
        // targets a fast drag produced while a decode was in flight, instead
        // of spawning (and later discarding) one decode per seekTo. getCanvas
        // is already frame-accurate — it returns the frame whose PTS ≤ target
        // — so the painted frame matches the playhead readout above. cancelInFlight
        // (called just above) already dropped any older pending target.
        scrubPumpRef.current?.request(clamped);
      }
    },
    getCurrentTime: () => currentMediaTime(),
    getDuration: () => durationRef.current,
    isReady: () => readyRef.current,
    isPlaying: () => playingRef.current,
    setVolume: (v: number) => {
      volumeRef.current = Math.max(0, Math.min(1, v));
      if (gainRef.current && !mutedRef.current) {
        gainRef.current.gain.value = volumeRef.current;
      }
    },
    getVolume: () => volumeRef.current,
    setMuted: (m: boolean) => {
      mutedRef.current = m;
      if (gainRef.current) gainRef.current.gain.value = m ? 0 : volumeRef.current;
    },
    isMuted: () => mutedRef.current,
    // Advertised so the speed UI (badge, HUD, [ / ] / \ shortcuts, palette)
    // disables itself while this player is active instead of claiming a
    // rate that isn't playing.
    supportsPlaybackRate: false,
    setPlaybackRate: () => {
      // Deliberate no-op — this player always plays at 1×. Its master clock is
      // pre-scheduled Web Audio: every decoded chunk is queued at an exact
      // AudioContext time (runAudioLoop) and the video loop chases that clock
      // (runVideoLoop). A rate change would mean rescheduling all in-flight
      // audio with a pitch/duration transform and rescaling both loops'
      // timestamp math — there is no safe seam without rebuilding the
      // scheduling model. The persistent speed applies to the <video>-backed
      // players (local + MSE stream); `supportsPlaybackRate: false` above
      // tells the app not to pretend otherwise.
    },
    setShuttle: (rate: number) => {
      if (!readyRef.current) return;
      if (rate === 0) {
        // Exit shuttle: restore the clock at the shuttle position and HARD
        // STOP. K after an 8× shuttle must freeze, not glide on at 1× — the
        // L-ladder's landing-on-+1 path calls play() explicitly when real
        // playback should resume. (The old was-playing resume is retired.)
        if (shuttleRafRef.current) { cancelAnimationFrame(shuttleRafRef.current); shuttleRafRef.current = 0; }
        if (shuttleRateRef.current !== 0) {
          shuttleRateRef.current = 0;
          startMediaTimeRef.current = shuttleTimeRef.current;
          onTimeUpdateRef.current?.(shuttleTimeRef.current);
          {
            playingRef.current = false;
            setIsPlaying(false);
            onPlayStateChange?.(false);
          }
        }
        return;
      }
      // Enter / adjust shuttle.
      if (shuttleRateRef.current === 0) {
        shuttleWasPlayingRef.current = playingRef.current;
        if (playingRef.current) startMediaTimeRef.current = currentMediaTime();
        cancelInFlight();           // stop the normal audio + video loops
        playingRef.current = false; // the shuttle loop drives the canvas now
        shuttleTimeRef.current = startMediaTimeRef.current;
        lastShuttleWallRef.current = performance.now();
        setIsPlaying(true);
        onPlayStateChange?.(true);
      }
      shuttleRateRef.current = rate;
      startShuttleLoop();
    },
    /**
     * Frame-accurate snapshot via the live CanvasSink. Skips the ffmpeg
     * subprocess entirely (~200ms saved per snapshot) and uses the file
     * mediabunny already has open. Returns null when there's no video
     * track (audio-only imports) or the sink hasn't loaded yet — caller
     * is responsible for the fallback path.
     */
    getFrameBlob: async (seconds, opts) => {
      const sink = videoSinkRef.current;
      if (!sink) return null;
      const wrapped = await sink.getCanvas(Math.max(0, Math.min(durationRef.current, seconds)));
      if (!wrapped) return null;
      const src = wrapped.canvas;
      // Always copy onto a fresh HTMLCanvasElement before toBlob — `src`
      // could be an OffscreenCanvas (mediabunny uses these when available)
      // and OffscreenCanvas's convertToBlob is async-only with a different
      // surface. This normalises both cases through the same encoder path.
      const out = document.createElement("canvas");
      out.width = src.width;
      out.height = src.height;
      const ctx = out.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(src as CanvasImageSource, 0, 0);
      const mimeType = opts?.mimeType ?? "image/jpeg";
      const quality = opts?.quality ?? 0.95;
      return await new Promise<Blob | null>((resolve) => {
        out.toBlob((b) => resolve(b), mimeType, quality);
      });
    },
  }), []);

  // ─── Open input + set up sinks on mount / path change ────────────────
  useEffect(() => {
    let cancelled = false;
    readyRef.current = false;
    playingRef.current = false;
    setIsPlaying(false);

    // Fresh AudioContext per mount — old contexts may be in a weird state
    // if the previous file errored out.
    const ctx = new AudioContext();
    audioCtxRef.current = ctx;
    const gain = ctx.createGain();
    gain.gain.value = mutedRef.current ? 0 : volumeRef.current;
    gain.connect(ctx.destination);
    gainRef.current = gain;

    (async () => {
      try {
        // Local file → native fs byte-range reads (CustomSource); asset://
        // range-fetch stalls on large local files. http(s) URL → UrlSource
        // (r60), which range-fetches over HTTP: pointing it at the loopback
        // media proxy (http://127.0.0.1:<port>/v1/<b64>) lets mediabunny
        // demux a YouTube/web stream and decode it via WebCodecs to <canvas>
        // — WITHOUT the <video> element, which WKWebView refuses to stream
        // cross-origin. The proxy serves CORS + Range/206, exactly what
        // UrlSource's range-fetch needs. Seeking fetches only the bytes for
        // that region = true streaming, no full download. `mediabunnySource`
        // picks the right one from the path.
        const input = new Input({ source: mediabunnySource(path), formats: ALL_FORMATS });
        if (cancelled) { void input.dispose(); return; }
        inputRef.current = input;

        const [vt, at, dur] = await Promise.all([
          hasVideo ? input.getPrimaryVideoTrack() : Promise.resolve(null),
          input.getPrimaryAudioTrack(),
          input.computeDuration(),
        ]);
        if (cancelled) return;

        videoTrackRef.current = vt;
        audioTrackRef.current = at;
        durationRef.current = dur;

        if (vt) {
          // canDecode() short-circuits the whole mediabunny path if
          // WebCodecs can't handle this codec on the current platform —
          // surfacing the error here is much friendlier than a silent
          // decode failure 200ms into playback.
          if (!(await vt.canDecode())) {
            const codec = await vt.getCodec().catch(() => "unknown");
            // Sentinel prefix `[WEBCODECS_UNSUPPORTED]` lets App.tsx pattern-
            // match and trigger the ffmpeg-prep fallback for this single
            // import without touching the global Settings toggle.
            onError?.(`[WEBCODECS_UNSUPPORTED] video codec "${codec}"`);
            return;
          }
          // ProRes DECODES fine (turbores), but its output is 10/12-bit YUV.
          // mediabunny can only paint a sample to a canvas by wrapping it in a
          // WebCodecs VideoFrame, and this WKWebView's WebCodecs has no 10-bit
          // VideoFrame — so getCanvas() silently yields a BLACK canvas (no throw,
          // so the generic error path never fires). Treat "decodes but can't be
          // painted here" like an unsupported codec: hand off to the ffmpeg-prep
          // fallback, which transcodes to 8-bit H.264 for playback (the original
          // ProRes is untouched and still used for export). turbores is the only
          // custom-registered VIDEO decoder, so ProRes is the only >8-bit sample
          // that reaches here — gate any future one the same way.
          if (vt.codec === "prores") {
            onError?.(`[WEBCODECS_UNSUPPORTED] ProRes is 10-bit; WKWebView can't paint it to a canvas`);
            return;
          }
          videoSinkRef.current = new CanvasSink(vt, {
            poolSize: 4,
            // Scrub latency: `optimizeForLatency` tells WebCodecs to emit each
            // decoded frame ASAP instead of buffering several first, so a
            // getCanvas() lands sooner; `prefer-hardware` keeps decode on the
            // GPU. Both fall back gracefully if unavailable.
            decoderOptions: { hardwareAcceleration: "prefer-hardware", optimizeForLatency: true },
          });
          // Paint the first frame so the canvas isn't black before play. If a
          // sample decodes but can't be wrapped for the canvas, getCanvas throws
          // → same unsupported-render fallback rather than a silent black frame.
          try {
            const first = await videoSinkRef.current.getCanvas(0);
            if (!cancelled && first) drawCanvas(first.canvas);
          } catch (e) {
            if (cancelled) return;
            const codec = await vt.getCodec().catch(() => "unknown");
            onError?.(`[WEBCODECS_UNSUPPORTED] ${codec} video can't be rendered here (${e instanceof Error ? e.message : String(e)})`);
            return;
          }
        }
        if (at) {
          if (!(await at.canDecode())) {
            const codec = await at.getCodec().catch(() => "unknown");
            // Audio-only codec issues also trigger fallback — playing
            // silent video is technically possible but most users hit
            // this in podcasts/interviews where audio IS the content.
            onError?.(`[WEBCODECS_UNSUPPORTED] audio codec "${codec}"`);
            return;
          }
          audioSinkRef.current = new AudioBufferSink(at);
        }

        readyRef.current = true;
        onReady?.(dur);
      } catch (err) {
        if (!cancelled) {
          onError?.(`Failed to open file: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    })();

    return () => {
      cancelled = true;
      cancelInFlight();
      // Tear down decoders / context. Order matters: cancel iterators
      // first (handled by genRef bump above), THEN dispose the Input so
      // it doesn't yank the rug out from under in-flight reads.
      const input = inputRef.current;
      const audioCtx = audioCtxRef.current;
      inputRef.current = null;
      videoTrackRef.current = null;
      audioTrackRef.current = null;
      videoSinkRef.current = null;
      audioSinkRef.current = null;
      audioCtxRef.current = null;
      gainRef.current = null;
      readyRef.current = false;
      playingRef.current = false;
      lastDrawnRef.current = null;
      // Microtask: dispose after current call stack so any iterator
      // cleanup gets to observe the gen bump first.
      queueMicrotask(() => {
        if (input) void input.dispose();
        if (audioCtx) void audioCtx.close();
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Volume / mute prop changes — push to the live gain node.
  useEffect(() => {
    volumeRef.current = Math.max(0, Math.min(1, initialVolume));
    if (gainRef.current && !mutedRef.current) {
      gainRef.current.gain.value = volumeRef.current;
    }
  }, [initialVolume]);

  return (
    <div className="cp-local-media" onClick={onSurfaceClick}>
      {hasVideo ? (
        <canvas
          ref={canvasRef}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
            background: "#000",
            display: "block",
          }}
        />
      ) : (
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
      )}
    </div>
  );
}));
