import {
  forwardRef, memo, useEffect, useImperativeHandle, useRef, useState,
} from "react";
import { Input, UrlSource, CanvasSink, ALL_FORMATS } from "mediabunny";
import { IconFilm } from "./Icons";
import type { PlayerHandle } from "./player-handle";
import { base64UrlEncode } from "../lib/stream-proxy";

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
  /** Authoritative duration (seconds) from yt-dlp metadata. Preferred over the
   *  stream probe, which can read short and make far seeks clamp early. */
  knownDuration?: number;
  /** r75 — DASH-split sources (Reddit, YouTube >360p) have no muxed progressive
   *  URL. When present, this is the RAW audio-track CDN URL; the player passes
   *  it to the proxy's fMP4 route as `?audio=<b64>` so ffmpeg merges video +
   *  audio on the fly and the source STREAMS (with sound) instead of falling
   *  back to a full download. Native muxed playback then keeps A/V in sync and
   *  currentTime tracks the heard audio, so captions stay married to it. */
  audioStreamUrl?: string;
  /** r79 — codec strings from yt-dlp's resolver (`get_direct_stream_url`), e.g.
   *  "avc1.640028" / "mp4a.40.2". When the video codec is H.264 we build the
   *  MSE MIME directly from these and SKIP the mediabunny probe of the raw
   *  stream — that probe was a fragile extra round-trip that turned a transient
   *  CDN hiccup into an instant "Load failed" → full-download fallback. If the
   *  codecs are absent/unsupported we fall back to probing (then to download). */
  videoCodec?: string;
  audioCodec?: string;
  /** Low-volume pipeline diagnostics → the Pipeline log (channel "seek"), so
   *  seek/rebuild behaviour is inspectable without DevTools. Logged only on
   *  actual seeks/rebuilds (not per-frame), so it stays quiet. */
  onDiag?: (tag: string, message: string) => void;
};

/** Seconds to stay buffered ahead of the playhead before pausing reads —
 *  bounds memory and (via TCP backpressure) throttles ffmpeg to ~playback. */
const BUFFER_AHEAD_SECONDS = 30;

export const MSEStreamPlayer = memo(forwardRef<PlayerHandle, Props>(function MSEStreamPlayer(
  { path, filename, hasVideo, initialVolume, onTimeUpdate, onPlayStateChange, onReady, onError, onSurfaceClick, knownDuration, audioStreamUrl, videoCodec, audioCodec, onDiag },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const readyRef = useRef(false);
  const playingRef = useRef(false);
  const [isPlaying, setIsPlaying] = useState(false);

  const baseTimeRef = useRef(0);
  const totalDurationRef = useRef(0);
  const mimeRef = useRef<string | null>(null);
  // Origin of the fMP4 timeline (buffered.start(0) of the current pipeline).
  // The proxy can emit a non-zero start PTS / encoder-priming, which made
  // <video>.currentTime sit BEHIND real media time and captions lag. We
  // capture it once per pipeline and subtract it so the reported playhead
  // tracks real media time. Re-captured on every rebuild (seek).
  const clockOriginRef = useRef(0);
  const clockOriginSetRef = useRef(false);
  // Authoritative total from yt-dlp metadata. The mediabunny probe of the
  // fragmented proxy stream can read short, which made `seekTo` clamp far
  // seeks early (e.g. 19:40 landing at 15:12). Metadata wins when present.
  const knownDurationRef = useRef(0);
  useEffect(() => {
    const d = knownDuration && isFinite(knownDuration) && knownDuration > 0 ? knownDuration : 0;
    knownDurationRef.current = d;
    if (d > 0) totalDurationRef.current = d;
  }, [knownDuration]);

  // r79: codec strings from the resolver, kept in refs so buildPipeline reads
  // the current values without re-running its effect (mirrors knownDurationRef).
  // Declared before the pipeline effect so they're set first on a source switch.
  const videoCodecRef = useRef<string | null>(null);
  const audioCodecRef = useRef<string | null>(null);
  useEffect(() => { videoCodecRef.current = videoCodec ?? null; }, [videoCodec]);
  useEffect(() => { audioCodecRef.current = audioCodec ?? null; }, [audioCodec]);
  const onDiagRef = useRef<Props["onDiag"]>(undefined);
  useEffect(() => { onDiagRef.current = onDiag; }, [onDiag]);
  // Latest-callback ref for onTimeUpdate: the media effect below runs on
  // [path] only, so its handlers would otherwise close over the callback from
  // MOUNT time. App's callback converts seconds to frames with the CURRENT
  // fps; the mount-time one used the pre-metadata fallback (24), so every
  // tick republished the playhead at 24/30 of the true position and every
  // seek visibly slid backward to 0.8x the clicked time.
  const onTimeUpdateRef = useRef<Props["onTimeUpdate"]>(undefined);
  useEffect(() => { onTimeUpdateRef.current = onTimeUpdate; }, [onTimeUpdate]);

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
  // Shuttle (J-K-L): forward uses native playbackRate (capped 4× — beyond that
  // playback outruns the proxy's fMP4 remux); reverse runs a wall-clock rAF
  // scan walking currentTime backward (no native reverse in WebKit), clamped
  // to the buffered window. Audio mutes while |rate| > 2; the pre-shuttle
  // muted state is stashed so exit restores what the user had.
  const shuttleRateRef = useRef(0);
  const shuttleRafRef = useRef(0);
  const preShuttleMutedRef = useRef<boolean | null>(null);
  // User's persistent playback speed (Transport speed picker, 0.5–2×). Well
  // under the 4× the proxy remux can sustain. The shuttle temporarily owns
  // `playbackRate`; every shuttle exit restores THIS value.
  const userRateRef = useRef(1);
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

  // Per-source once-guard: a single decode/append failure can fire several error
  // signals (SourceBuffer 'error', appendBuffer throw, <video> 'error') in
  // back-to-back tasks. Only the first should reach onError — the rest would
  // surface a spurious error toast after the fallback already took over.
  const failedRef = useRef(false);

  // ─── Imperative handle ──────────────────────────────────────────────
  useImperativeHandle(ref, () => ({
    play: () => {
      const el = videoRef.current;
      if (!el) return;
      el.play().catch((err) => {
        onError?.(`Playback failed: ${err?.name ?? "Error"}: ${err?.message ?? String(err)}`);
      });
    },
    pause: () => {
      videoRef.current?.pause();
    },
    seekTo: (s) => {
      const v = videoRef.current;
      const sb = sbRef.current;
      // Clamp to the AUTHORITATIVE duration: max of the (possibly short) stream
      // probe and yt-dlp's known metadata duration. A short probe value here is
      // exactly what made far seeks land backward ("19:40 → 15:12"); never let
      // it clamp a valid forward seek.
      const total = Math.max(totalDurationRef.current || 0, knownDurationRef.current || 0);
      const target = Math.max(0, total > 0 ? Math.min(total, s) : s);
      const co = clockOriginRef.current;
      const rel = target - baseTimeRef.current;
      // Diagnostic (Pipeline log, channel "seek"): if a forward seek lands
      // earlier than requested, this shows WHERE — a `total` smaller than `s`
      // clamps `target` backward; otherwise the branch/rel/clockOrigin reveal it.
      onDiagRef.current?.("info",
        `seek req ${s.toFixed(1)} → target ${target.toFixed(1)} (base ${baseTimeRef.current.toFixed(1)}, total ${total.toFixed(1)}, rel ${rel.toFixed(1)}, clockOrigin ${co.toFixed(2)})`);

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
      onTimeUpdateRef.current?.(target);
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
      // Buffered ranges + el.currentTime live in the pipeline's LOCAL timeline,
      // which starts at clockOrigin (the fMP4 start-PTS). The absolute target
      // maps to local time `rel + clockOrigin`; compare + seek in that space so
      // a non-zero start-PTS can't offset the landing.
      if (v && sb && rel >= 0) {
        const localTarget = rel + co;
        for (let i = 0; i < sb.buffered.length; i++) {
          if (localTarget >= sb.buffered.start(i) - 0.25 && localTarget <= sb.buffered.end(i) + 0.25) {
            if (rebuildTimerRef.current != null) { window.clearTimeout(rebuildTimerRef.current); rebuildTimerRef.current = null; }
            pendingSeekRef.current = null;
            try { v.currentTime = localTarget; } catch { /* ignore */ }
            onDiagRef.current?.("ok", `seek in-buffer → currentTime ${localTarget.toFixed(1)}`);
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
        onDiagRef.current?.("info", `seek out-of-buffer → rebuilding from ${t.toFixed(1)}s`);
        teardownRef.current?.();
        rebuildRef.current?.(t);
      }, 280);
    },
    // While a seek is resolving, report the TARGET (not the old/paused
    // video's time) so nothing reading this can snap the playhead back.
    getCurrentTime: () => {
      if (seekingRef.current && pendingSeekRef.current != null) return pendingSeekRef.current;
      // The native <video> is the single clock; clockOrigin subtracts the
      // fMP4 start-PTS so the reported playhead tracks real media time.
      return baseTimeRef.current + Math.max(0, (videoRef.current?.currentTime ?? 0) - clockOriginRef.current);
    },
    getDuration: () => totalDurationRef.current || 0,
    isReady: () => readyRef.current,
    isPlaying: () => playingRef.current,
    setVolume: (v) => {
      const c = Math.max(0, Math.min(1, v));
      if (videoRef.current) videoRef.current.volume = c;
    },
    getVolume: () => videoRef.current?.volume ?? 1,
    setMuted: (m) => {
      if (videoRef.current) videoRef.current.muted = m;
    },
    isMuted: () => videoRef.current?.muted ?? false,
    supportsPlaybackRate: true,
    setPlaybackRate: (rate) => {
      // Clamp to what the streaming pipeline sustains (shuttle caps here too);
      // the app's list is 0.5–2×, comfortably under it.
      const r = Math.max(0.25, Math.min(4, rate));
      userRateRef.current = r;
      const v = videoRef.current;
      if (!v) return;
      // defaultPlaybackRate survives the load algorithm — seek rebuilds swap
      // video.src to a fresh MediaSource, whose reset lands on the default,
      // so the rate sticks across out-of-buffer seeks.
      v.defaultPlaybackRate = r;
      // A live shuttle owns playbackRate until it exits (setShuttle(0) restores).
      if (shuttleRateRef.current === 0) v.playbackRate = r;
    },
    setShuttle: (rate) => {
      const v = videoRef.current;
      if (!v) return;
      if (shuttleRafRef.current) { cancelAnimationFrame(shuttleRafRef.current); shuttleRafRef.current = 0; }
      // Entering shuttle from rest → remember the user's muted state once;
      // rate adjustments mid-shuttle keep the original value for restore.
      if (rate !== 0 && shuttleRateRef.current === 0) preShuttleMutedRef.current = v.muted;
      shuttleRateRef.current = rate;
      if (rate === 0) {
        // Back to the user's chosen speed, not a hardcoded 1× — the shuttle is
        // a transient override on top of the persistent rate.
        v.playbackRate = userRateRef.current;
        if (preShuttleMutedRef.current != null) { v.muted = preShuttleMutedRef.current; preShuttleMutedRef.current = null; }
        // Exit is a HARD STOP (K = freeze instantly); the L-ladder's +1 landing
        // resumes real playback explicitly after this.
        try { v.pause(); } catch { /* ignore */ }
        return;
      }
      // Chipmunk audio above 2× is noise — mute there, audible at ≤2×.
      v.muted = Math.abs(rate) > 2 ? true : (preShuttleMutedRef.current ?? v.muted);
      if (rate > 0) {
        // Native fast-forward — smooth; the <video> carries its own audio.
        // Capped 4× so playback can't outrun the streaming remux.
        v.playbackRate = Math.min(4, rate);
        v.play().catch(() => { /* ignore */ });
        return;
      }
      // Reverse: <video> can't play backward, so walk currentTime backward on
      // a wall-clock rAF (scan speed = |rate|× real time regardless of frame
      // cadence). Smooth where buffered; clamps at the buffered start (going
      // further back would need a full stream rebuild).
      v.playbackRate = 1;
      try { v.pause(); } catch { /* ignore */ }
      let last = performance.now();
      const tick = (now: number) => {
        shuttleRafRef.current = 0;
        const vv = videoRef.current;
        const r = shuttleRateRef.current;
        if (!vv || r >= 0) return; // shuttle cancelled / direction changed
        const dt = (now - last) / 1000;
        last = now;
        let next = vv.currentTime + r * dt; // r<0 → backward
        // Clamp at the buffered window's start (the pipeline's local timeline
        // begins at clockOrigin ≈ buffered.start(0), not 0).
        let floor = 0;
        try { if (vv.buffered.length > 0) floor = Math.max(0, vv.buffered.start(0)); } catch { /* ignore */ }
        if (next <= floor) {
          // Hit the buffered head — exit the shuttle, settle paused there.
          next = floor;
          try { vv.currentTime = next; } catch { /* ignore */ }
          onTimeUpdateRef.current?.(baseTimeRef.current + Math.max(0, next - clockOriginRef.current));
          shuttleRateRef.current = 0;
          vv.playbackRate = userRateRef.current; // self-exit restores the user rate too
          if (preShuttleMutedRef.current != null) { vv.muted = preShuttleMutedRef.current; preShuttleMutedRef.current = null; }
          setIsPlaying(false);
          return;
        }
        try { vv.currentTime = next; } catch { /* ignore */ }
        onTimeUpdateRef.current?.(baseTimeRef.current + Math.max(0, next - clockOriginRef.current));
        shuttleRafRef.current = requestAnimationFrame(tick);
      };
      shuttleRafRef.current = requestAnimationFrame(tick);
    },
  }), [onError]);

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
    failedRef.current = false;
    setScrubPreview(false);

    // One failure typically emits several error signals; only the first reaches
    // onError (App's fallback owns the rest), so a single fault can't surface a
    // spurious "Playback error" toast after the download fallback already began.
    const fail = (msg: string) => { if (disposed || failedRef.current) return; failedRef.current = true; onError?.(msg); };

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
          // r79 FAST PATH: build the MIME from the resolver's codec strings and
          // skip the raw-stream probe entirely. That probe (mediabunny reading
          // the moov over the loopback proxy) is the one fragile pre-check that
          // turned a transient CDN hiccup into an instant "Load failed" + a
          // full-video download. We already know the codecs; the robust ffmpeg
          // /fmp4 path does the real work. Only H.264 video qualifies (what the
          // resolver targets + what WKWebView decodes); anything else falls
          // through to the probe below (which falls through to download).
          if (!mimeRef.current && videoCodecRef.current && /^(avc1|avc3|h264)/i.test(videoCodecRef.current)) {
            const aCodec = audioCodecRef.current && /(mp4a|aac)/i.test(audioCodecRef.current)
              ? audioCodecRef.current
              : "mp4a.40.2";
            const candidate = `video/mp4; codecs="${videoCodecRef.current}, ${aCodec}"`;
            const MSx: typeof MediaSource | undefined =
              (typeof MediaSource !== "undefined" ? MediaSource : undefined) ??
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (window as any).ManagedMediaSource;
            if (MSx && typeof MSx.isTypeSupported === "function" && MSx.isTypeSupported(candidate)) {
              mimeRef.current = candidate;
              // Metadata duration (0 ⇒ filled when metadata lands via the
              // knownDuration effect; seek clamping uses knownDurationRef too).
              totalDurationRef.current = knownDurationRef.current;
            }
          }
          // Probe codecs + total duration once (same source across seeks).
          // Reads the RAW proxy stream's moov; cheap. Only runs when the fast
          // path above didn't already establish the MIME.
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
            // Prefer the authoritative metadata duration; only trust the probe
            // when metadata didn't give us one (the probe can read short).
            totalDurationRef.current = knownDurationRef.current > 0
              ? knownDurationRef.current
              : (dur && isFinite(dur) ? dur : 0);
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
            clockOriginSetRef.current = false; // re-capture for this pipeline
            const localDur = total > fromSeconds ? total - fromSeconds : 0;
            if (localDur > 0) { try { ms.duration = localDur; } catch { /* ignore */ } }
            sb.addEventListener("updateend", () => {
              // Capture the timeline origin from the first buffered range (later
              // ranges shift forward as old data is evicted, so capture ONCE).
              if (!clockOriginSetRef.current && sb.buffered.length > 0) {
                clockOriginSetRef.current = true;
                clockOriginRef.current = sb.buffered.start(0);
              }
              // First real media data is in the buffer → the pipeline genuinely
              // delivered. NOW fire onReady so the watchdog covered the full path
              // through first bytes, not just the MediaSource attach.
              if (!readyOnceRef.current && sb.buffered.length > 0) {
                readyOnceRef.current = true;
                onReady?.(total);
              }
              const c = currentRef.current;
              currentRef.current = null;
              c?.resolve();
              pump();
            });
            sb.addEventListener("error", () => fail("SourceBuffer error during append"));

            readyRef.current = true;
            // onReady (which clears App's 15s stall watchdog + drops the
            // "Starting playback…" overlay) fires from the FIRST successful
            // append below, not here at sourceopen — sourceopen happens the
            // instant the MediaSource attaches, before any bytes arrive, so
            // firing here would disarm the watchdog during the exact data-
            // delivery phase it exists to guard.
            // New pipeline is positioned at baseTime (video.currentTime 0) —
            // safe to report time again, and resume if we were playing.
            seekingRef.current = false;
            onTimeUpdateRef.current?.(baseTimeRef.current);
            onDiagRef.current?.("ok", `pipeline open at ${fromSeconds.toFixed(1)}s → playhead ${baseTimeRef.current.toFixed(1)}s`);
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
              // same b64 under /fmp4/v1/ with an optional ?start= seek, plus an
              // optional ?audio=<b64> second input for DASH-split sources so the
              // proxy merges video+audio into one fMP4 (full audio, no download).
              const qs: string[] = [];
              if (from > 0) qs.push(`start=${from.toFixed(3)}`);
              if (audioStreamUrl) qs.push(`audio=${base64UrlEncode(audioStreamUrl)}`);
              const fmp4Url = path.replace("/v1/", "/fmp4/v1/")
                + (qs.length ? `?${qs.join("&")}` : "");
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
    // Drive the playhead from requestAnimationFrame (~display refresh) while
    // playing, NOT the <video>'s 'timeupdate' event. Browsers throttle
    // 'timeupdate' to ~4Hz, so on 15-30fps content the playhead visibly skips
    // ~4 frames per update ("playing in chunks"). rAF reads currentTime every
    // frame, so the playhead advances frame-by-frame. App floors to a frame
    // number and React bails when it's unchanged, so this only re-renders when
    // the frame actually advances — cheap.
    let rafId = 0;
    let rvfcId = 0;
    type RVFCVideo = HTMLVideoElement & {
      requestVideoFrameCallback: (cb: () => void) => number;
      cancelVideoFrameCallback: (id: number) => void;
    };
    const rvfc = el as RVFCVideo;
    const hasRVFC = typeof rvfc.requestVideoFrameCallback === "function";
    // SINGLE-CLOCK MODEL: the native muxed <video> is the one clock for audio,
    // picture AND captions — WebKit keeps A/V locked inside it, so captions
    // (which read this same playhead) can't drift from the audio you hear. The
    // proxy can leave a non-zero start PTS / encoder priming on the fMP4, which
    // would make <video>.currentTime sit behind real media time and captions
    // lag; clockOrigin (= buffered.start(0), captured once per pipeline)
    // subtracts it. baseTime is the current pipeline's absolute media time
    // (set on rebuild/seek), so corrected() tracks true source time.
    const corrected = (raw: number) =>
      baseTimeRef.current + Math.max(0, raw - clockOriginRef.current);
    const reportTime = () => {
      // Suppress while an out-of-buffer seek resolves — the old/transitional
      // video reports a stale position that would fight the playhead.
      if (!seekingRef.current) onTimeUpdateRef.current?.(corrected(el.currentTime));
    };
    // Drive the playhead from currentTime every frame via
    // requestVideoFrameCallback (smooth, ~display refresh); rAF is the fallback
    // when rVFC is throttled/occluded.
    const onFrame = () => {
      rvfcId = 0;
      if (!playingRef.current) return;
      reportTime();
      rvfcId = rvfc.requestVideoFrameCallback(onFrame);
    };
    const tick = () => {
      rafId = 0;
      if (!playingRef.current) return;
      reportTime();
      rafId = requestAnimationFrame(tick);
    };
    const startTick = () => {
      if (hasRVFC) { if (!rvfcId) rvfcId = rvfc.requestVideoFrameCallback(onFrame); }
      else if (!rafId) rafId = requestAnimationFrame(tick);
    };
    const onPlay = () => { playingRef.current = true; setIsPlaying(true); onPlayStateChange?.(true); startTick(); };
    const onPause = () => {
      playingRef.current = false; setIsPlaying(false); onPlayStateChange?.(false);
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      if (rvfcId) { try { rvfc.cancelVideoFrameCallback(rvfcId); } catch { /* ignore */ } rvfcId = 0; }
    };
    // 'timeupdate' (≈4Hz) stays as the playhead signal while PAUSED — e.g. a
    // seek landing — and as a backstop if the frame callbacks are throttled.
    const onTime = () => reportTime();
    const onErr = () => {
      if (failedRef.current) return; // first error already reported for this source
      failedRef.current = true;
      const me = el.error;
      const map: Record<number, string> = {
        1: "MEDIA_ERR_ABORTED", 2: "MEDIA_ERR_NETWORK", 3: "MEDIA_ERR_DECODE", 4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
      };
      onError?.(`Video error: ${map[me?.code ?? 0] ?? "unknown"}${me?.message ? ` (${me.message})` : ""}`);
    };
    // Hide the scrub-preview overlay once the real <video> has a frame at
    // the new position AND the gesture has ended (no pending settle). During
    // an active drag the settle timer is armed, so per-tick 'seeked's don't
    // prematurely reveal the laggy video.
    const onSettled = () => { if (seekSettleRef.current == null) setScrubPreview(false); };
    // Also hide the overlay the instant real playback resumes. The
    // out-of-buffer REBUILD path can fire 'loadeddata' while the settle
    // timer is still armed (so onSettled bails), then resume the rebuilt
    // <video> with no further 'seeked' — leaving the preview canvas frozen
    // over a playing video (audio but no picture). 'playing' can't fire
    // mid-scrub (we pause on every seek tick), so clearing here is always
    // correct: if the video is genuinely playing, show it, not a stale frame.
    const onResume = () => setScrubPreview(false);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("playing", onResume);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("error", onErr);
    el.addEventListener("seeked", onSettled);
    el.addEventListener("loadeddata", onSettled);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      if (rvfcId) { try { rvfc.cancelVideoFrameCallback(rvfcId); } catch { /* ignore */ } rvfcId = 0; }
      if (shuttleRafRef.current) { cancelAnimationFrame(shuttleRafRef.current); shuttleRafRef.current = 0; }
      shuttleRateRef.current = 0;
      // Mid-shuttle source swap: give the element back its pre-shuttle audio.
      if (preShuttleMutedRef.current != null) { el.muted = preShuttleMutedRef.current; preShuttleMutedRef.current = null; }
      el.playbackRate = userRateRef.current; // clear any shuttle override, keep the user rate
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("playing", onResume);
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
              <IconFilm size={32} stroke="rgba(255,255,255,0.6)" />
              {isPlaying && <div className="cp-eq"><span /><span /><span /><span /></div>}
            </div>
            <div className="cp-audio-name">{filename ?? "Streaming audio"}</div>
            <div className="cp-audio-hint">
              {isPlaying ? "Now playing. Scrub with the transport below." : "Press play to start."}
            </div>
          </div>
        </>
      )}
    </div>
  );
}));
