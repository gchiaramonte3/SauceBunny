import {
  forwardRef, memo, useEffect, useImperativeHandle, useRef, useState,
} from "react";
import { Input, UrlSource, CanvasSink, ALL_FORMATS } from "mediabunny";
import { IconFilm } from "./Icons";
import type { PlayerHandle } from "./player-handle";

/**
 * Streams a web source (YouTube/Vimeo/…) into a NATIVE `<video>` element via
 * Media Source Extensions (MSE) with FULL AUDIO. (r61 → r63.)
 *
 * Why MSE (all verified):
 *   • cross-origin `<video src>` → WKWebView probes then refuses to read.
 *   • WebCodecs `AudioDecoder` is absent in WKWebView < Safari 26 → silent.
 *   • MSE: bytes via fetch() (through our CORS proxy) → appended into a
 *     same-origin blob: MediaSource → WebKit NATIVE decode (H.264 + AAC).
 *
 * Why ffmpeg for the remux (r63): progressive MP4 can't be appended to MSE
 * as-is — it must be fragmented MP4. mediabunny CAN produce fMP4 and keeps
 * both tracks, but WKWebView played its muxed output with NO AUDIO. The
 * ffmpeg sidecar's reference-grade muxing plays both. So the Rust proxy's
 * `/fmp4/` route spawns `ffmpeg -c copy -movflags frag_keyframe+empty_moov…`
 * and pipes fragmented MP4; here we just fetch() that stream and feed MSE.
 * mediabunny is still used for the lightweight codec/duration probe.
 *
 * SEEK-ANYWHERE: MSE holds a bounded buffer, so each seek OUTSIDE the
 * buffered window rebuilds the stream from the seek point (ffmpeg `-ss` via
 * the `?start=` query) as a fresh 0-based timeline; the player tracks an
 * absolute `baseTime`. In-buffer seeks are instant/native. Far seeks are
 * debounced so a continuous scrub doesn't thrash the pipeline.
 */
type Props = {
  path: string; // http(s) RAW proxy URL (…/v1/<b64>); we derive the /fmp4/ URL from it
  filename?: string;
  hasVideo: boolean;
  initialVolume: number; // 0..1
  onTimeUpdate?: (seconds: number) => void;
  onPlayStateChange?: (playing: boolean) => void;
  onReady?: (duration: number) => void;
  onError?: (message: string) => void;
  onSurfaceClick?: () => void;
};

/** Seconds to stay buffered ahead of the playhead before pausing reads —
 *  bounds memory and (via TCP backpressure) throttles ffmpeg to ~playback. */
const BUFFER_AHEAD_SECONDS = 30;

export const MSEStreamPlayer = memo(forwardRef<PlayerHandle, Props>(function MSEStreamPlayer(
  { path, filename, hasVideo, initialVolume, onTimeUpdate, onPlayStateChange, onReady, onError, onSurfaceClick },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const readyRef = useRef(false);
  const playingRef = useRef(false);
  const [isPlaying, setIsPlaying] = useState(false);

  const baseTimeRef = useRef(0);
  const totalDurationRef = useRef(0);
  const mimeRef = useRef<string | null>(null);

  const msRef = useRef<MediaSource | null>(null);
  const sbRef = useRef<SourceBuffer | null>(null);
  const probeInputRef = useRef<Input | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const queueRef = useRef<Array<{ data: Uint8Array; resolve: () => void }>>([]);
  const currentRef = useRef<{ resolve: () => void } | null>(null);
  const endedRef = useRef(false);
  const genRef = useRef(0);
  const wantPlayRef = useRef(false);
  const readyOnceRef = useRef(false);
  const rebuildRef = useRef<((fromSeconds: number) => void) | null>(null);
  const teardownRef = useRef<(() => void) | null>(null);
  const rebuildTimerRef = useRef<number | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  // Scrubbing = pause playback so it can't fight the playhead; resume on
  // settle (no seek for ~300ms). Fires after the last seek of a gesture.
  const seekSettleRef = useRef<number | null>(null);
  // Frame-accurate scrub preview (r68). While dragging, a WebCodecs
  // CanvasSink decodes the exact frame under the cursor onto an overlay
  // canvas — instant + every frame, vs the <video>'s laggy native seek.
  // Hidden again once the real video shows a frame at the new position.
  const previewSinkRef = useRef<CanvasSink | null>(null);
  const previewInputRef = useRef<Input | null>(null);
  const previewTargetRef = useRef<number | null>(null);
  const previewBusyRef = useRef(false);
  const scrubCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const requestPreviewRef = useRef<((seconds: number) => void) | null>(null);
  const [scrubPreview, setScrubPreview] = useState(false);
  // True from the moment an out-of-buffer seek starts until the rebuilt
  // pipeline is positioned at the target. While true, the old/transitional
  // <video> must NOT report its time (it would yank the playhead back to
  // the pre-seek position — the "scrubbing won't go past here" wrestling).
  const seekingRef = useRef(false);

  // ─── Imperative handle ──────────────────────────────────────────────
  useImperativeHandle(ref, () => ({
    play: () => {
      const el = videoRef.current;
      if (!el) return;
      el.play().catch((err) => {
        onError?.(`Playback failed: ${err?.name ?? "Error"} — ${err?.message ?? String(err)}`);
      });
    },
    pause: () => { videoRef.current?.pause(); },
    seekTo: (s) => {
      const v = videoRef.current;
      const sb = sbRef.current;
      const total = totalDurationRef.current || 0;
      const target = Math.max(0, total > 0 ? Math.min(total, s) : s);
      const rel = target - baseTimeRef.current;

      // ── Gesture bookkeeping ──────────────────────────────────────────
      // A scrub fires seekTo() many times. On the FIRST of a gesture,
      // remember whether we were playing, then PAUSE — playback advancing
      // mid-scrub is exactly what fights the playhead and causes jitter.
      // `seekingRef` stays true for the whole gesture so the video's own
      // timeupdate is suppressed (only the explicit target moves the
      // playhead). A settle timer (no seek for 300ms) ends the gesture and
      // resumes playback if we were playing.
      const newGesture = seekSettleRef.current == null && !seekingRef.current;
      if (newGesture) wantPlayRef.current = !!v && !v.paused;
      seekingRef.current = true;
      try { v?.pause(); } catch { /* ignore */ }
      onTimeUpdate?.(target);
      // Frame-accurate preview overlay while scrubbing (r68). The decoded
      // frame at `target` is drawn instantly to a canvas above the <video>,
      // hiding the video's laggier native seek. The 'seeked'/'loadeddata'
      // listeners hide it once the real video catches up post-gesture.
      setScrubPreview(true);
      requestPreviewRef.current?.(target);
      if (seekSettleRef.current != null) window.clearTimeout(seekSettleRef.current);
      seekSettleRef.current = window.setTimeout(() => {
        seekSettleRef.current = null;
        // A rebuild (out-of-buffer) owns its own resume via onReady — only
        // resume here for the in-buffer case (current pipeline still live).
        if (rebuildTimerRef.current != null) return; // rebuild imminent
        if (!sbRef.current) return;                   // rebuild in flight
        seekingRef.current = false;
        if (wantPlayRef.current) { wantPlayRef.current = false; videoRef.current?.play().catch(() => { /* ignore */ }); }
      }, 300);

      // ── In-buffer → instant native seek ─────────────────────────────
      if (v && sb && rel >= 0) {
        for (let i = 0; i < sb.buffered.length; i++) {
          if (rel >= sb.buffered.start(i) - 0.25 && rel <= sb.buffered.end(i) + 0.25) {
            if (rebuildTimerRef.current != null) { window.clearTimeout(rebuildTimerRef.current); rebuildTimerRef.current = null; }
            pendingSeekRef.current = null;
            try { v.currentTime = rel; } catch { /* ignore */ }
            return;
          }
        }
      }

      // ── Out of buffer → debounce the heavy rebuild ──────────────────
      pendingSeekRef.current = target;
      if (rebuildTimerRef.current != null) window.clearTimeout(rebuildTimerRef.current);
      rebuildTimerRef.current = window.setTimeout(() => {
        rebuildTimerRef.current = null;
        const t = pendingSeekRef.current;
        pendingSeekRef.current = null;
        if (t == null) return;
        baseTimeRef.current = t;
        teardownRef.current?.();
        rebuildRef.current?.(t);
      }, 280);
    },
    // While a seek is resolving, report the TARGET (not the old/paused
    // video's time) so nothing reading this can snap the playhead back.
    getCurrentTime: () =>
      (seekingRef.current && pendingSeekRef.current != null)
        ? pendingSeekRef.current
        : baseTimeRef.current + (videoRef.current?.currentTime ?? 0),
    getDuration: () => totalDurationRef.current || 0,
    isReady: () => readyRef.current,
    isPlaying: () => playingRef.current,
    setVolume: (v) => { if (videoRef.current) videoRef.current.volume = Math.max(0, Math.min(1, v)); },
    getVolume: () => videoRef.current?.volume ?? 1,
    setMuted: (m) => { if (videoRef.current) videoRef.current.muted = m; },
    isMuted: () => videoRef.current?.muted ?? false,
  }), [onError, onTimeUpdate]);

  // ─── Pipeline lifecycle ─────────────────────────────────────────────
  useEffect(() => {
    let disposed = false;
    readyRef.current = false;
    readyOnceRef.current = false;
    playingRef.current = false;
    setIsPlaying(false);
    baseTimeRef.current = 0;
    mimeRef.current = null;
    seekingRef.current = false;
    setScrubPreview(false);

    const fail = (msg: string) => { if (!disposed) onError?.(msg); };

    // ── Scrub-preview decoder (r68) ──────────────────────────────────
    // A second, read-only mediabunny pipeline over the RAW proxy stream,
    // used ONLY to decode the frame under the cursor while scrubbing.
    // Lazily created on the first scrub (no cost if the user never
    // scrubs). `requestPreview` coalesces to the latest target so rapid
    // drags never backlog the decoder.
    let previewSinkPromise: Promise<CanvasSink | null> | null = null;
    const ensurePreviewSink = () => {
      if (!previewSinkPromise) {
        previewSinkPromise = (async () => {
          try {
            const input = new Input({ source: new UrlSource(path), formats: ALL_FORMATS });
            previewInputRef.current = input;
            const vt = await input.getPrimaryVideoTrack();
            if (disposed || !vt || !(await vt.canDecode())) return null;
            const sink = new CanvasSink(vt, { poolSize: 2 });
            previewSinkRef.current = sink;
            return sink;
          } catch {
            return null;
          }
        })();
      }
      return previewSinkPromise;
    };
    const requestPreview = (seconds: number) => {
      previewTargetRef.current = seconds;
      if (previewBusyRef.current) return;
      previewBusyRef.current = true;
      void (async () => {
        const sink = await ensurePreviewSink();
        if (!sink) { previewBusyRef.current = false; return; }
        while (previewTargetRef.current != null && !disposed) {
          const t = previewTargetRef.current;
          previewTargetRef.current = null;
          const wrapped = await sink.getCanvas(Math.max(0, t)).catch(() => null);
          if (!wrapped) continue;
          const dst = scrubCanvasRef.current;
          if (dst) {
            const src = wrapped.canvas;
            if (dst.width !== src.width || dst.height !== src.height) {
              dst.width = src.width;
              dst.height = src.height;
            }
            dst.getContext("2d")?.drawImage(src as CanvasImageSource, 0, 0);
          }
        }
        previewBusyRef.current = false;
      })();
    };
    requestPreviewRef.current = requestPreview;

    const pump = () => {
      const sb = sbRef.current;
      const ms = msRef.current;
      const v = videoRef.current;
      if (!sb || !ms || ms.readyState !== "open" || sb.updating || currentRef.current) return;
      if (v && sb.buffered.length > 0) {
        const ahead = sb.buffered.end(sb.buffered.length - 1) - v.currentTime;
        if (ahead > BUFFER_AHEAD_SECONDS) return;
      }
      const item = queueRef.current.shift();
      if (!item) {
        if (endedRef.current && ms.readyState === "open") {
          try { ms.endOfStream(); } catch { /* already ended */ }
        }
        return;
      }
      currentRef.current = { resolve: item.resolve };
      try {
        sb.appendBuffer(item.data as BufferSource);
      } catch (err) {
        if (err instanceof DOMException && err.name === "QuotaExceededError" && v) {
          currentRef.current = null;
          queueRef.current.unshift(item);
          const safe = Math.max(0, v.currentTime - 10);
          try { if (sb.buffered.length && sb.buffered.start(0) < safe) sb.remove(0, safe); } catch { /* ignore */ }
          return;
        }
        fail(`appendBuffer failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    const ticker = window.setInterval(() => pump(), 250);

    const teardownPipeline = () => {
      genRef.current++;
      const reader = readerRef.current;
      const probe = probeInputRef.current;
      const objUrl = objectUrlRef.current;
      readerRef.current = null;
      probeInputRef.current = null;
      sbRef.current = null;
      msRef.current = null;
      objectUrlRef.current = null;
      currentRef.current = null;
      queueRef.current = [];
      endedRef.current = false;
      if (objUrl) { try { URL.revokeObjectURL(objUrl); } catch { /* ignore */ } }
      // Cancelling the reader aborts the fetch → ffmpeg sees the client
      // disconnect and the Rust side kills it.
      if (reader) { void reader.cancel().catch(() => { /* ignore */ }); }
      if (probe) { queueMicrotask(() => { void probe.dispose(); }); }
    };
    teardownRef.current = teardownPipeline;

    const buildPipeline = (fromSeconds: number) => {
      const gen = ++genRef.current;
      endedRef.current = false;
      queueRef.current = [];
      currentRef.current = null;

      void (async () => {
        try {
          // Probe codecs + total duration once (same source across seeks).
          // Reads the RAW proxy stream's moov; cheap.
          if (!mimeRef.current) {
            const input = new Input({ source: new UrlSource(path), formats: ALL_FORMATS });
            probeInputRef.current = input;
            const [vt, at, dur] = await Promise.all([
              hasVideo ? input.getPrimaryVideoTrack() : Promise.resolve(null),
              input.getPrimaryAudioTrack(),
              input.computeDuration().catch(() => 0),
            ]);
            if (disposed || gen !== genRef.current) return;
            const [vCodec, aCodec] = await Promise.all([
              vt ? vt.getCodecParameterString() : Promise.resolve(null),
              at ? at.getCodecParameterString() : Promise.resolve(null),
            ]);
            if (disposed || gen !== genRef.current) return;
            mimeRef.current = `video/mp4; codecs="${[vCodec, aCodec].filter(Boolean).join(", ")}"`;
            totalDurationRef.current = dur && isFinite(dur) ? dur : 0;
          }
          const mime = mimeRef.current;
          const total = totalDurationRef.current;

          const MS: typeof MediaSource | undefined =
            (typeof MediaSource !== "undefined" ? MediaSource : undefined) ??
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (window as any).ManagedMediaSource;
          if (!MS) { fail("MediaSource API unavailable in this WebView."); return; }
          if (mime.includes('codecs=""')) { fail("Could not determine stream codecs."); return; }
          if (typeof MS.isTypeSupported === "function" && !MS.isTypeSupported(mime)) {
            fail(`MSE can't decode ${mime}`); return;
          }

          const ms = new MS();
          msRef.current = ms;
          const objectUrl = URL.createObjectURL(ms);
          objectUrlRef.current = objectUrl;
          const video = videoRef.current;
          if (!video) return;
          try { (video as HTMLVideoElement & { disableRemotePlayback?: boolean }).disableRemotePlayback = true; } catch { /* ignore */ }
          video.src = objectUrl;

          ms.addEventListener("sourceopen", () => {
            if (disposed || gen !== genRef.current) return;
            try { URL.revokeObjectURL(objectUrl); } catch { /* ignore */ }
            let sb: SourceBuffer;
            try { sb = ms.addSourceBuffer(mime); }
            catch (err) { fail(`addSourceBuffer(${mime}) failed: ${err instanceof Error ? err.message : String(err)}`); return; }
            sb.mode = "segments";
            sbRef.current = sb;
            const localDur = total > fromSeconds ? total - fromSeconds : 0;
            if (localDur > 0) { try { ms.duration = localDur; } catch { /* ignore */ } }
            sb.addEventListener("updateend", () => {
              const c = currentRef.current;
              currentRef.current = null;
              c?.resolve();
              pump();
            });
            sb.addEventListener("error", () => fail("SourceBuffer error during append"));

            readyRef.current = true;
            if (!readyOnceRef.current) { readyOnceRef.current = true; onReady?.(total); }
            // New pipeline is positioned at baseTime (video.currentTime 0) —
            // safe to report time again, and resume if we were playing.
            seekingRef.current = false;
            onTimeUpdate?.(baseTimeRef.current);
            if (wantPlayRef.current) {
              wantPlayRef.current = false;
              video.play().catch(() => { /* gesture/autoplay — ignore */ });
            }
            void startFetch(fromSeconds, gen);
          }, { once: true });

          // Fetch the ffmpeg-remuxed fMP4 and feed it to the SourceBuffer.
          const startFetch = async (from: number, g: number) => {
            try {
              // path is the RAW proxy URL …/v1/<b64>; the fMP4 route is the
              // same b64 under /fmp4/v1/ with an optional ?start= seek.
              const fmp4Url = path.replace("/v1/", "/fmp4/v1/")
                + (from > 0 ? `?start=${Math.floor(from)}` : "");
              const resp = await fetch(fmp4Url);
              if (disposed || g !== genRef.current) { try { await resp.body?.cancel(); } catch { /* ignore */ } return; }
              if (!resp.ok || !resp.body) { fail(`fMP4 stream HTTP ${resp.status}`); return; }
              const reader = resp.body.getReader();
              readerRef.current = reader;
              for (;;) {
                if (disposed || g !== genRef.current) { try { await reader.cancel(); } catch { /* ignore */ } return; }
                const { done, value } = await reader.read();
                if (done) { endedRef.current = true; pump(); break; }
                if (value && value.byteLength) {
                  // Resolve fires on appendBuffer's updateend; pump won't
                  // append while buffer-ahead is capped → this await stalls
                  // reads → TCP backpressure pauses ffmpeg until playback
                  // drains the buffer. Keeps memory + ffmpeg bounded.
                  await new Promise<void>((resolve) => {
                    queueRef.current.push({ data: value, resolve });
                    pump();
                  });
                }
              }
            } catch (err) {
              if (disposed || g !== genRef.current) return;
              fail(`fMP4 stream failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          };
        } catch (err) {
          if (disposed || gen !== genRef.current) return;
          fail(`Failed to open stream: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    };
    rebuildRef.current = buildPipeline;

    buildPipeline(0);

    return () => {
      disposed = true;
      window.clearInterval(ticker);
      if (rebuildTimerRef.current != null) { window.clearTimeout(rebuildTimerRef.current); rebuildTimerRef.current = null; }
      if (seekSettleRef.current != null) { window.clearTimeout(seekSettleRef.current); seekSettleRef.current = null; }
      pendingSeekRef.current = null;
      teardownPipeline();
      // Tear down the scrub-preview decoder.
      requestPreviewRef.current = null;
      previewTargetRef.current = null;
      previewBusyRef.current = false;
      previewSinkRef.current = null;
      const previewInput = previewInputRef.current;
      previewInputRef.current = null;
      if (previewInput) queueMicrotask(() => { void previewInput.dispose(); });
      readyRef.current = false;
      playingRef.current = false;
      const v = videoRef.current;
      try { v?.pause(); } catch { /* ignore */ }
      try { if (v) { v.removeAttribute("src"); v.load(); } } catch { /* ignore */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // ─── Native <video> events → parent callbacks ───────────────────────
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.volume = Math.max(0, Math.min(1, initialVolume));
    const onPlay = () => { playingRef.current = true; setIsPlaying(true); onPlayStateChange?.(true); };
    const onPause = () => { playingRef.current = false; setIsPlaying(false); onPlayStateChange?.(false); };
    const onTime = () => {
      // While an out-of-buffer seek is resolving, the old/transitional video
      // would report a stale position and fight the playhead — suppress it.
      if (seekingRef.current) return;
      onTimeUpdate?.(baseTimeRef.current + el.currentTime);
    };
    const onErr = () => {
      const me = el.error;
      const map: Record<number, string> = {
        1: "MEDIA_ERR_ABORTED", 2: "MEDIA_ERR_NETWORK", 3: "MEDIA_ERR_DECODE", 4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
      };
      onError?.(`Video error: ${map[me?.code ?? 0] ?? "unknown"}${me?.message ? ` — ${me.message}` : ""}`);
    };
    // Hide the scrub-preview overlay once the real <video> has a frame at
    // the new position AND the gesture has ended (no pending settle). During
    // an active drag the settle timer is armed, so per-tick 'seeked's don't
    // prematurely reveal the laggy video.
    const onSettled = () => { if (seekSettleRef.current == null) setScrubPreview(false); };
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("error", onErr);
    el.addEventListener("seeked", onSettled);
    el.addEventListener("loadeddata", onSettled);
    return () => {
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("error", onErr);
      el.removeEventListener("seeked", onSettled);
      el.removeEventListener("loadeddata", onSettled);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return (
    <div className="cp-local-media" onClick={onSurfaceClick}>
      {hasVideo ? (
        <>
          <video ref={(el) => { videoRef.current = el; }} playsInline className="cp-local-video" />
          {/* Frame-accurate scrub preview overlay (r68) — WebCodecs-decoded
              frame at the cursor, shown only while scrubbing. */}
          <canvas
            ref={(el) => { scrubCanvasRef.current = el; }}
            className={"cp-scrub-preview" + (scrubPreview ? " show" : "")}
            aria-hidden
          />
        </>
      ) : (
        <>
          <video ref={(el) => { videoRef.current = el; }} style={{ display: "none" }} />
          <div className="cp-audio-card">
            <div className={"cp-audio-icon" + (isPlaying ? " playing" : "")}>
              <IconFilm size={28} stroke="rgba(255,255,255,0.5)" />
              {isPlaying && <div className="cp-eq"><span /><span /><span /><span /></div>}
            </div>
            <div className="cp-audio-name">{filename ?? "Streaming audio"}</div>
            <div className="cp-audio-hint">
              {isPlaying ? "Now playing — use the transport below to scrub." : "Press play to start."}
            </div>
          </div>
        </>
      )}
    </div>
  );
}));
