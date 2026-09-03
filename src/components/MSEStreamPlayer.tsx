import {
  forwardRef, memo, useEffect, useImperativeHandle, useRef, useState,
} from "react";
import { Input, UrlSource, CanvasSink, EncodedPacketSink, ALL_FORMATS } from "mediabunny";
import { BunnyMark } from "./BunnyMark";
import type { PlayerHandle } from "./player-handle";
import { base64UrlEncode } from "../lib/stream-proxy";
import { encodedStreamMime, peerStreamMime } from "../lib/codec-strings";
import { rebuildLogLine } from "../lib/seek-log";
import { mayHideScrubOverlay, shouldFreezeOutgoingFrame } from "../lib/scrub-freeze";
import { planFirstAppend } from "../lib/first-append";

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
  /** Tier B peer streams: the raw route has no random access (405), so the
   *  frame-accurate scrub overlay must not open its mediabunny pipeline.
   *  Explicit flag rather than a silent probe failure (plan risk note). */
  disableScrubPreview?: boolean;
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
  /** Tier B: the quality rung to ask the presenter to encode, or null for
   *  source passthrough. Changing it rebuilds the pipeline — see `rungKey`. */
  rung?: number | null;
  /** Fired when the <video> runs out of buffered media (`waiting`). The ONLY
   *  starvation signal the app has; `src/lib/stream-rung.ts` turns a pattern
   *  of these into a downshift. Deliberately raw: the policy lives there, not
   *  here, so it can be tested without a media stack. */
  onStall?: () => void;
  /** Reports what the presenter ACTUALLY served (X-Rung / X-Relay), which is
   *  not always what was asked for — an older host ignores the rung entirely,
   *  and a relayed path caps the ladder regardless of preference. */
  onStreamInfo?: (info: { rung: number | null; relayed: boolean }) => void;
  /** Initial pipeline start (seconds). A fresh-retry stream resumes where
   *  the dying one was (review fix: the retry previously restarted at 0). */
  startAtSeconds?: number;
  /** Low-volume pipeline diagnostics → the Pipeline log (channel "seek"), so
   *  seek/rebuild behaviour is inspectable without DevTools. Logged only on
   *  actual seeks/rebuilds (not per-frame), so it stays quiet. */
  onDiag?: (tag: string, message: string) => void;
};

/** Seconds to stay buffered ahead of the playhead before pausing reads —
 *  bounds memory and (via TCP backpressure) throttles ffmpeg to ~playback. */
const BUFFER_AHEAD_SECONDS = 30;

export const MSEStreamPlayer = memo(forwardRef<PlayerHandle, Props>(function MSEStreamPlayer(
  { path, filename, hasVideo, initialVolume, onTimeUpdate, onPlayStateChange, onReady, onError, onSurfaceClick, knownDuration, audioStreamUrl, videoCodec, audioCodec, onDiag, startAtSeconds, disableScrubPreview, rung, onStall, onStreamInfo },
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
  // Has THIS pipeline been forced to present a frame? See the nudge in
  // `updateend`. One per pipeline, reset alongside clockOriginSetRef.
  const paintedOnceRef = useRef(false);
  /**
   * Resume-after-idle forensics.
   *
   * "Sometimes I pause, come back later, and it is not snappy" is a real
   * report with at least three different causes that look identical from the
   * outside, so guessing at a fix would be guessing. These refs make the next
   * occurrence self-diagnosing: we record how much buffer existed at the
   * moment of the pause, and compare it on the first gesture afterwards.
   *
   * That gesture is a SEEK as well as a play. The original wording of this
   * comment said "hit play", and the code believed it — but the report being
   * chased is "I scrub twenty minutes later and it holds on the frame it was
   * parked on", and a scrub never fires `play`. LocalMediaPlayer was corrected
   * for this; this player was not, so the web half of the investigation
   * recorded nothing for the gesture it exists to explain.
   *
   *   buffer survived     → the stall is downstream (decode, or the source
   *                         swap), not the pipeline
   *   buffer gone         → WebKit evicted the SourceBuffer while idle, and
   *                         the fix is a re-append, not a rebuild
   *   pipeline gone       → ffmpeg/the fetch died on an idle timeout, and the
   *                         fix is keeping it warm or rebuilding sooner
   */
  const pausedAtRef = useRef(0);
  const aheadAtPauseRef = useRef(0);
  /** One idle report per idle, not one per seek event inside a scrub. */
  const reportedIdleRef = useRef(false);
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
  // Read at pipeline-build time. A rung CHANGE must rebuild, which the
  // `rungKey` dependency below drives; the ref is so startFetch sees the
  // current value without re-running its own effect.
  const rungRef = useRef<number | null>(null);
  useEffect(() => { rungRef.current = rung ?? null; }, [rung]);
  const onStallRef = useRef<Props["onStall"]>(undefined);
  useEffect(() => { onStallRef.current = onStall; }, [onStall]);
  const onStreamInfoRef = useRef<Props["onStreamInfo"]>(undefined);
  useEffect(() => { onStreamInfoRef.current = onStreamInfo; }, [onStreamInfo]);
  const onDiagRef = useRef<Props["onDiag"]>(undefined);
  useEffect(() => { onDiagRef.current = onDiag; }, [onDiag]);
  useEffect(() => { disableScrubPreviewRef.current = !!disableScrubPreview; }, [disableScrubPreview]);
  // Read at pipeline-build time only (a prop change must not rebuild).
  const startAtSecondsRef = useRef(0);
  useEffect(() => {
    startAtSecondsRef.current = startAtSeconds && isFinite(startAtSeconds) && startAtSeconds > 0.5 ? startAtSeconds : 0;
  }, [startAtSeconds]);
  // Latest-callback ref for onTimeUpdate: the media effect below runs on
  // [path] only, so its handlers would otherwise close over the callback from
  // MOUNT time. App's callback converts seconds to frames with the CURRENT
  // fps; the mount-time one used the pre-metadata fallback (24), so every
  // tick republished the playhead at 24/30 of the true position and every
  // seek visibly slid backward to 0.8x the clicked time.
  const onTimeUpdateRef = useRef<Props["onTimeUpdate"]>(undefined);
  useEffect(() => { onTimeUpdateRef.current = onTimeUpdate; }, [onTimeUpdate]);
  // Timeline mode of the current source's proxy stream (X-Timeline header):
  // absolute → the fMP4 carries real source timestamps, video.currentTime IS
  // source time (baseTime/clockOrigin stay 0, rebuilds land exactly on the
  // requested second); rebased (HLS) → the legacy asserted-baseTime model.
  const timelineAbsRef = useRef(false);
  // Absolute-mode rebuilds land here once the buffer covers the request —
  // input-side -ss starts the stream at the keyframe AT-OR-BEFORE it.
  const pendingLandRef = useRef<number | null>(null);

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
  /** Keyframe index over the preview input (fast-drag snap). */
  const previewKeySinkRef = useRef<EncodedPacketSink | null>(null);
  /** Fast-drag mode for the preview + its velocity/settle bookkeeping. */
  const previewFastRef = useRef(false);
  const previewLastReqRef = useRef<{ t: number; at: number } | null>(null);
  const previewExactTimerRef = useRef(0);
  const previewInputRef = useRef<Input | null>(null);
  const previewTargetRef = useRef<number | null>(null);
  const previewBusyRef = useRef(false);
  const scrubCanvasRef = useRef<HTMLCanvasElement | null>(null);
  /** The live playhead in SOURCE seconds. `startAtSeconds` is zeroed once a
   *  stream is playing (PLAYER_READY clears resumeAtSeconds), so a rebuild
   *  triggered by anything other than a user seek - a quality change, say -
   *  had nothing to resume from and restarted the file at 0. A guest watching
   *  at 5:17 went black and came back at 00:00, paused. */
  const livePosRef = useRef(0);
  /**
   * Has the preview overlay ever painted a frame for THIS source?
   *
   * It matters because the overlay is opaque. `.cp-scrub-preview` carries
   * `background: var(--bg-0)` and sits at z-index 2 over the video, and the
   * old code turned it on the instant a seek began - before the decoder had
   * been created, let alone produced a frame. So touching the scrubber put a
   * near-black rectangle over the picture and left it there until a frame
   * arrived: seconds on a long source over the network, and FOREVER when the
   * preview decoder failed to open, which it does silently.
   *
   * "The frames are black for long periods until finally it comes available"
   * is that, exactly. The overlay was showing its own background.
   */
  const previewPaintedRef = useRef(false);
  const requestPreviewRef = useRef<((seconds: number) => void) | null>(null);
  const [scrubPreview, setScrubPreview] = useState(false);
  // True from the moment an out-of-buffer seek starts until the rebuilt
  // pipeline is positioned at the target. While true, the old/transitional
  // <video> must NOT report its time (it would yank the playhead back to
  // the pre-seek position — the "scrubbing won't go past here" wrestling).
  const seekingRef = useRef(false);
  /** Mirror of the disableScrubPreview prop for the []-deps handle. */
  const disableScrubPreviewRef = useRef(!!disableScrubPreview);
  /**
   * Where the current gesture STARTED, and how many seeks it has emitted.
   *
   * The seek log reports `seek req` once per gesture (a drag emits one per
   * animation frame, and each line is App state, so logging every one
   * re-rendered the app per vsync). The rebuild that follows reports where the
   * gesture ENDED. Those two lines sat next to each other in the Pipeline log
   * with nothing saying they were different moments, so an ordinary drag read
   * as a seek that had landed hundreds of seconds from where it was asked:
   *
   *     seek req 2666.0 → target 2666.0
   *     seek out-of-buffer → rebuilding from 3855.5s
   *
   * Both numbers are correct and the player did exactly the right thing. The
   * log was the defect. It is kept once-per-gesture for the reason it always
   * was; what it now says is which gesture it belongs to.
   */
  const gestureFromRef = useRef<number | null>(null);
  const gestureSeeksRef = useRef(0);

  // Per-source once-guard: a single decode/append failure can fire several error
  // signals (SourceBuffer 'error', appendBuffer throw, <video> 'error') in
  // back-to-back tasks. Only the first should reach onError — the rest would
  // surface a spurious error toast after the fallback already took over.
  const failedRef = useRef(false);

  // ─── Imperative handle ──────────────────────────────────────────────
  useImperativeHandle(ref, () => ({
    // The element a live session captures to show a peer what the
    // presenter is watching. See lib/viewer-capture.ts.
    getCaptureElement: () => videoRef.current,
    play: () => {
      const el = videoRef.current;
      if (!el) return;
      el.play().catch((err) => {
        // AbortError is a BENIGN interruption per the HTML spec: any pause()
        // (scrub gesture) or src swap (out-of-buffer rebuild) rejects a
        // pending play() with it. Treating it as fatal killed a healthy
        // stream mid-seek and forced the download fallback for nothing.
        // The rebuild owns resume via wantPlayRef; genuine pipeline deaths
        // still surface through the SourceBuffer/<video> error listeners
        // and the no-data stall guard.
        if ((err as DOMException)?.name === "AbortError" || failedRef.current) return;
        failedRef.current = true;
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
      // ── Gesture bookkeeping ──────────────────────────────────────────
      // A scrub fires seekTo() many times. On the FIRST of a gesture,
      // remember whether we were playing, then PAUSE — playback advancing
      // mid-scrub is exactly what fights the playhead and causes jitter.
      // `seekingRef` stays true for the whole gesture so the video's own
      // timeupdate is suppressed (only the explicit target moves the
      // playhead). A settle timer (no seek for 300ms) ends the gesture and
      // resumes playback if we were playing.
      const newGesture = seekSettleRef.current == null && !seekingRef.current;
      // Diagnostic (Pipeline log, channel "seek"): if a forward seek lands
      // earlier than requested, this shows WHERE — a `total` smaller than `s`
      // clamps `target` backward; otherwise the branch/rel/clockOrigin reveal it.
      // Logged once per GESTURE, not per seek: log lines are App state, so a
      // drag was forcing a full App re-render per vsync. A single click is a
      // gesture of one and still logs exactly as before.
      if (newGesture) {
        gestureFromRef.current = target;
        gestureSeeksRef.current = 0;
        onDiagRef.current?.("info",
          `seek req ${s.toFixed(1)} → target ${target.toFixed(1)} (base ${baseTimeRef.current.toFixed(1)}, total ${total.toFixed(1)}, rel ${rel.toFixed(1)}, clockOrigin ${co.toFixed(2)})`);
      }
      gestureSeeksRef.current += 1;
      if (newGesture) wantPlayRef.current = !!v && !v.paused;
      seekingRef.current = true;
      try { v?.pause(); } catch { /* ignore */ }
      onTimeUpdateRef.current?.(target);
      // Frame-accurate preview overlay while scrubbing (r68). The decoded
      // frame at `target` is drawn instantly to a canvas above the <video>,
      // hiding the video's laggier native seek. The 'seeked'/'loadeddata'
      // listeners hide it once the real video catches up post-gesture.
      // Peer streams skip it: no random access on the raw route.
      if (!disableScrubPreviewRef.current) {
        // Fast-drag detection (mirrors MediaBunnyPlayer): closely-spaced
        // seeks covering real distance preview KEYFRAMES; a trailing pass
        // decodes the exact resting frame.
        const nowMs = performance.now();
        const last = previewLastReqRef.current;
        previewLastReqRef.current = { t: target, at: nowMs };
        previewFastRef.current = !!last && nowMs - last.at < 160 && Math.abs(target - last.t) > 0.35;
        if (previewExactTimerRef.current) window.clearTimeout(previewExactTimerRef.current);
        if (previewFastRef.current) {
          previewExactTimerRef.current = window.setTimeout(() => {
            previewExactTimerRef.current = 0;
            previewFastRef.current = false;
            const rest = previewLastReqRef.current;
            if (rest) requestPreviewRef.current?.(rest.t);
          }, 170);
        }
        // Only reveal the overlay when it is holding a real frame. Before the
        // first paint the video underneath is a far better thing to look at
        // than an opaque black rectangle, and after it a slightly stale frame
        // still beats one. The paint itself turns it on (see requestPreview).
        if (previewPaintedRef.current) setScrubPreview(true);
        requestPreviewRef.current?.(target);
      }
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
            // Review fix: a landing target armed by an earlier out-of-buffer
            // rebuild is superseded by this click — clearing it here stops the
            // updateend landing from later yanking currentTime back to it.
            pendingLandRef.current = null;
            try { v.currentTime = localTarget; } catch { /* ignore */ }
            if (newGesture) {
              onDiagRef.current?.("ok", `seek in-buffer → currentTime ${localTarget.toFixed(1)}`);
            }
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
        pendingLandRef.current = t;
        // Review fix (mode-flip race): baseTime is NOT committed here — the
        // timeline mode is per-pipeline (the proxy's probe can fail on any
        // rebuild, flipping absolute→rebased), so the clock commits only in
        // startFetch once this pipeline's X-Timeline header is read.
        // Say which gesture this rebuild belongs to. Wording lives in
        // lib/seek-log.ts, where it can be tested.
        onDiagRef.current?.("info",
          rebuildLogLine(t, gestureFromRef.current, gestureSeeksRef.current));
        // FREEZE THE OUTGOING FRAME, immediately before it is taken away.
        //
        // `teardownRef` + rebuild assigns `video.src` for a fresh MediaSource,
        // and that runs the media load algorithm, which DISCARDS the presented
        // frame. The element then paints nothing and what you see is
        // .cp-monitor's own black for the whole rebuild - the "scrubbing shows
        // no frames" report.
        //
        // IT BELONGS HERE AND NOWHERE EARLIER. A first attempt seeded this at
        // the start of every gesture, which also covered the IN-BUFFER path
        // above - and that path is an instant native seek, the thing that made
        // scrubbing feel good in the clip panel. Freezing there replaced a
        // live seek with a stale canvas that only moved at decoder speed, and
        // made the common case worse to fix the rare one. Only a rebuild
        // blanks the element, so only a rebuild gets the freeze.
        // AND ONLY WHEN THE OVERLAY IS HOLDING NOTHING.
        //
        // This is the bug that made YouTube scrubbing feel ruined, and it is
        // worse than the one it was fixing. On an out-of-buffer drag the
        // <video> never moves - it stays parked at the PRE-DRAG position,
        // because the seek it was given cannot land until the pipeline is
        // rebuilt. Meanwhile the decoder overlay has been painting the
        // frame-accurate frame at the target, which is the whole reason
        // scrubbing a web source feels good.
        //
        // Drawing the video here therefore painted the frame you started
        // from OVER the frame you had just scrubbed to: let go of the
        // playhead and the picture snapped back to the beginning of the
        // gesture and sat there for the entire rebuild.
        //
        // So the freeze is a LAST RESORT for an overlay with nothing in it -
        // a peer stream, where the decoder is off, or the moments before its
        // first paint. A decoded frame is always better than this one and is
        // never overwritten.
        const fv = videoRef.current;
        const dst = scrubCanvasRef.current;
        if (fv && dst && shouldFreezeOutgoingFrame({
          previewPainted: previewPaintedRef.current,
          readyState: fv.readyState,
          videoWidth: fv.videoWidth,
        })) {
          if (dst.width !== fv.videoWidth || dst.height !== fv.videoHeight) {
            dst.width = fv.videoWidth;
            dst.height = fv.videoHeight;
          }
          try {
            dst.getContext("2d")?.drawImage(fv, 0, 0, dst.width, dst.height);
            previewPaintedRef.current = true;
            setScrubPreview(true);
          } catch { /* not drawable: the decoder overlay or the video covers it */ }
        }
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
    // Poster capture for a source row — the current frame, downscaled, skipped
    // when near-black. Same-origin blob-fed <video>, so the canvas isn't tainted.
    getPosterDataUrl: async () => {
      const v = videoRef.current;
      if (!v || v.readyState < 2 || !v.videoWidth || !v.videoHeight) return null;
      const scale = Math.min(1, 480 / v.videoWidth);
      const w = Math.max(1, Math.round(v.videoWidth * scale));
      const h = Math.max(1, Math.round(v.videoHeight * scale));
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      try {
        ctx.drawImage(v, 0, 0, w, h);
        const { data } = ctx.getImageData(0, 0, w, h);
        let sum = 0;
        for (let i = 0; i < data.length; i += 4) {
          sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        }
        // LUMA_OK = 16, matching extractPosterBlob's black-frame floor.
        if (sum / (data.length / 4) < 16) return null;
        return c.toDataURL("image/jpeg", 0.7);
      } catch { return null; }
    },
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
    timelineAbsRef.current = false; // re-learned from the new source's header
    pendingLandRef.current = null;
    mimeRef.current = null;
    seekingRef.current = false;
    // A scrub gesture dies with its source. If the path changes mid-gesture
    // (scrub, then load another URL within the 300ms settle), the cleanup
    // cancels the settle timer, so a leaked wantPlay would be consumed by
    // the NEXT source's pipeline-open and auto-play a source the app
    // mounted paused (the scrub-then-switch resume race).
    wantPlayRef.current = false;
    failedRef.current = false;
    setScrubPreview(false);
    previewPaintedRef.current = false;
    // A NEW SOURCE starts at its own beginning. Without this the resume
    // fallback above would carry the previous clip's playhead into an
    // unrelated one - which is a worse bug than the one it fixes.
    livePosRef.current = 0;

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
    let previewOpenedAt = 0;
    /**
     * Every exit from here used to be `return null`, silently.
     *
     * A preview that cannot open is indistinguishable from one that is merely
     * slow: both leave the overlay empty. One is a permanent property of the
     * source and the other passes; they want completely different responses
     * from whoever is looking at it, and the log said nothing at all about
     * either. Now it says which.
     */
    const previewUnavailable = (why: string): null => {
      onDiagRef.current?.("warn", `scrub preview unavailable: ${why}. Scrubbing falls back to the video's own seek.`);
      return null;
    };
    const ensurePreviewSink = () => {
      if (!previewSinkPromise) {
        previewOpenedAt = performance.now();
        previewSinkPromise = (async () => {
          try {
            const input = new Input({ source: new UrlSource(path), formats: ALL_FORMATS });
            previewInputRef.current = input;
            const vt = await input.getPrimaryVideoTrack();
            if (disposed) return null;
            if (!vt) return previewUnavailable("the raw stream has no video track mediabunny can index");
            if (!(await vt.canDecode())) return previewUnavailable("this platform cannot decode the raw stream's video codec");
            const sink = new CanvasSink(vt, { poolSize: 2 });
            previewSinkRef.current = sink;
            // Keyframe index for fast drags: decoding a keyframe timestamp
            // needs ONE ranged fetch + one decode, vs keyframe + a forward
            // walk of fetches for an exact mid-GOP frame. Over the network
            // that walk is the whole scrub lag.
            previewKeySinkRef.current = new EncodedPacketSink(vt);
            return sink;
          } catch (e) {
            return previewUnavailable(e instanceof Error ? e.message : String(e));
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
          let decodeAt = Math.max(0, t);
          const keySink = previewKeySinkRef.current;
          if (previewFastRef.current && keySink) {
            const pkt = await keySink.getKeyPacket(decodeAt, { verifyKeyPackets: false }).catch(() => null);
            if (pkt) decodeAt = pkt.timestamp;
          }
          const wrapped = await sink.getCanvas(decodeAt).catch(() => null);
          if (!wrapped) continue;
          const dst = scrubCanvasRef.current;
          if (dst) {
            const src = wrapped.canvas;
            if (dst.width !== src.width || dst.height !== src.height) {
              dst.width = src.width;
              dst.height = src.height;
            }
            dst.getContext("2d")?.drawImage(src as CanvasImageSource, 0, 0);
            // NOW it is safe to show. The first paint also reports how long it
            // took, because "scrubbing is black" and "scrubbing is slow" look
            // identical from the outside and want different fixes.
            if (!previewPaintedRef.current) {
              previewPaintedRef.current = true;
              onDiagRef.current?.("ok",
                `scrub preview ready (first frame in ${Math.round(performance.now() - previewOpenedAt)}ms)`);
            }
            setScrubPreview(true);
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
          // Review fix: a stream that ended SHORT of the landing target
          // (seek past the real end; stale cue with unknown duration) would
          // otherwise leave the element parked at currentTime 0 outside the
          // buffered range forever. Land at the closest buffered moment.
          const land = pendingLandRef.current;
          if (timelineAbsRef.current && land != null && v && sb.buffered.length > 0) {
            pendingLandRef.current = null;
            const start = sb.buffered.start(0);
            const end = sb.buffered.end(sb.buffered.length - 1);
            try { v.currentTime = Math.min(land, Math.max(start, end - 0.1)); } catch { /* ignore */ }
          }
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
      // UNPARK every producer waiting on an append we are about to drop.
      // startFetch awaits a promise the pump resolves on the SourceBuffer's
      // updateend; clearing the queue without resolving left that task parked
      // forever, holding its chunk, its reader and its whole response object.
      // One leaked task per seek rebuild, and a scrub is many rebuilds. The
      // refs are nulled BEFORE resolving so a resolve-triggered pump finds
      // nothing to do, and the woken producer exits on its generation check
      // (genRef was bumped at the top of this function).
      const dropped = queueRef.current;
      const inFlight = currentRef.current;
      currentRef.current = null;
      queueRef.current = [];
      inFlight?.resolve();
      for (const item of dropped) item.resolve();
      endedRef.current = false;
      if (objUrl) { try { URL.revokeObjectURL(objUrl); } catch { /* ignore */ } }
      // Cancelling the reader aborts the fetch → ffmpeg sees the client
      // disconnect and the Rust side kills it.
      if (reader) { void reader.cancel().catch(() => { /* ignore */ }); }
      if (probe) { queueMicrotask(() => { void probe.dispose(); }); }
    };
    teardownRef.current = teardownPipeline;

    const buildPipeline = (fromSeconds: number) => {
      // Review fix: seek rebuilds had NO stall rescue (the app-level 15s
      // watchdog disarms after the first pipeline opens). If this pipeline
      // produces no data within 20s of its fetch starting (wedged epoch
      // probe, dead CDN URL), fail -> onMediaError -> download fallback.
      let sawData = false;
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
          // /fmp4 path does the real work.
          //
          // The MIME is built by `peerStreamMime`, which exists because this
          // block used to interpolate the codec strings straight into the
          // template and that quietly broke Tier B peer streaming for every
          // H.264 file. Two vocabularies were being mixed: a WEB source's
          // resolver hands over RFC 6381 ("avc1.640028"), but a PEER source's
          // offer carries whatever ffmpeg's stderr called it ("h264"), and the
          // old `/^(avc1|avc3|h264)/i` test matched BOTH — so a peer offer took
          // the fast path and produced `codecs="h264, aac"`, which
          // isTypeSupported rejects. The MIME then stayed unset, control fell
          // to the probe below, and the probe reads the raw peer route, which
          // answers 405 by design because "codecs ride the offer". Straight to
          // onMediaError, and the download fallback has no URL to download
          // because the file is on the other Mac.
          if (!mimeRef.current && videoCodecRef.current) {
            const MSx: typeof MediaSource | undefined =
              (typeof MediaSource !== "undefined" ? MediaSource : undefined) ??
              (window as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource;
            const supported = MSx && typeof MSx.isTypeSupported === "function"
              ? (m: string) => MSx.isTypeSupported(m)
              : null;
            // On a rung the presenter is TRANSCODING, so the stream is H.264
            // High + AAC-LC no matter what the source file was. Describing it
            // by the offer's source codecs would be wrong in general and fatal
            // for a ProRes or DNxHD master, which has no MP4 codec string at
            // all — peerStreamMime would return null and the fallback probe
            // would hit the raw peer route's 405.
            const mime = !supported
              ? null
              : rungRef.current
                ? encodedStreamMime(supported)
                : peerStreamMime(videoCodecRef.current, audioCodecRef.current, supported);
            if (mime) {
              mimeRef.current = mime;
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
            // Parked in the ref so teardownPipeline can cancel an in-flight
            // probe; the finally below releases OUR handle once the probe is
            // done with it either way.
            probeInputRef.current = input;
            try {
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
            } finally {
              // The probe's answers are copied into refs above — the demuxer
              // and its byte cache have no further use. It used to sit parked
              // until teardownPipeline, i.e. for the WHOLE SESSION on a web
              // source played without an out-of-buffer seek (the Clip view
              // never unmounts). Ownership check mirrors teardown's
              // take-then-null, so whichever runs first disposes, never both.
              if (probeInputRef.current === input) {
                probeInputRef.current = null;
                queueMicrotask(() => { void input.dispose(); });
              }
            }
          }
          const mime = mimeRef.current;
          const total = totalDurationRef.current;

          const MS: typeof MediaSource | undefined =
            (typeof MediaSource !== "undefined" ? MediaSource : undefined) ??
            (window as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource;
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
            paintedOnceRef.current = false;
            // ms.duration is sized in startFetch once the response header
            // reveals THIS pipeline's timeline mode (review fix: sizing it
            // here used the previous pipeline's mode).
            sb.addEventListener("updateend", () => {
              // Capture the timeline origin from the first buffered range (later
              // ranges shift forward as old data is evicted, so capture ONCE).
              if (sb.buffered.length > 0) sawData = true;
              if (!clockOriginSetRef.current && sb.buffered.length > 0) {
                clockOriginSetRef.current = true;
                // Absolute timeline: currentTime IS source time; origin stays 0.
                clockOriginRef.current = timelineAbsRef.current ? 0 : sb.buffered.start(0);
              }
              // Landing seek + first-frame paint, as ONE decision.
              //
              // These are two things that both want to set currentTime at this
              // exact moment, and letting each guard on the other's leftovers
              // produced two high-severity bugs within an hour: in rebased mode
              // the nudge never ran at all, and in absolute mode it overwrote
              // the landing seek and dropped the playhead a whole GOP before
              // where the user clicked. The rules, and why, are in
              // lib/first-append.ts, where they are tested.
              {
                const pv = videoRef.current;
                const plan = planFirstAppend({
                  painted: paintedOnceRef.current,
                  absolute: timelineAbsRef.current,
                  pendingLand: pendingLandRef.current,
                  bufferedStart: sb.buffered.length > 0 ? sb.buffered.start(0) : 0,
                  bufferedEnd: sb.buffered.length > 0 ? sb.buffered.end(sb.buffered.length - 1) : 0,
                  currentTime: pv?.currentTime ?? 0,
                  paused: pv?.paused ?? true,
                  hasBuffer: sb.buffered.length > 0,
                });
                if (plan.clearLand) pendingLandRef.current = null;
                if (plan.burnOneShot) paintedOnceRef.current = true;
                const to = plan.landTo ?? plan.nudgeTo;
                if (pv && to != null) { try { pv.currentTime = to; } catch { /* ignore */ } }
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
            // RC5b: a NEWER seek arrived while this pipeline was opening
            // (debounce armed or a target pending). Publishing T1 here would
            // visibly snap the just-clicked playhead backward for ~280ms and
            // consuming wantPlay would resume the wrong stream — yield; the
            // newer rebuild owns the resume and tears this MediaSource down.
            if (rebuildTimerRef.current != null || pendingSeekRef.current != null) {
              onDiagRef.current?.("info", "pipeline superseded before open; yielding to the newer seek");
              return;
            }
            seekingRef.current = false;
            onTimeUpdateRef.current?.(fromSeconds);
            onDiagRef.current?.("ok", `pipeline open at ${fromSeconds.toFixed(1)}s → playhead ${fromSeconds.toFixed(1)}s`);
            if (wantPlayRef.current) {
              wantPlayRef.current = false;
              video.play().catch(() => { /* gesture/autoplay — ignore */ });
            }
            void startFetch(fromSeconds, gen);
            window.setTimeout(() => {
              if (!disposed && gen === genRef.current && !sawData) {
                fail("stream pipeline stalled: no data within 20s of the rebuild");
              }
            }, 20_000);
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
              // Tier B quality rung. Omitted entirely for a web source and for
              // passthrough, so the request is byte-identical to what every
              // build before the ladder sent.
              if (rungRef.current) qs.push(`rung=${rungRef.current}`);
              const fmp4Url = path.replace("/v1/", "/fmp4/v1/")
                + (qs.length ? `?${qs.join("&")}` : "");
              const resp = await fetch(fmp4Url);
              if (disposed || g !== genRef.current) { try { await resp.body?.cancel(); } catch { /* ignore */ } return; }
              if (!resp.ok || !resp.body) { fail(`fMP4 stream HTTP ${resp.status}`); return; }
              // What the presenter really did, which can differ from the ask:
              // a host on an older build ignores `rung` and serves the source,
              // and a relayed path is a fact about the network rather than a
              // preference. Reporting both is what stops the guest downshifting
              // repeatedly against a host that was never going to comply.
              {
                const servedRaw = resp.headers.get("X-Rung");
                const served = servedRaw && servedRaw !== "source" ? Number(servedRaw) : null;
                onStreamInfoRef.current?.({
                  rung: Number.isFinite(served) ? served : null,
                  relayed: resp.headers.get("X-Relay") === "1",
                });
              }
              timelineAbsRef.current = resp.headers.get("x-timeline") === "absolute";
              // Review fix (mode-flip race): the (mode, baseTime, duration)
              // tuple commits HERE, atomically per pipeline, from this
              // response's own header — never from a previous pipeline's
              // mode. Absolute → base 0 (currentTime IS source time after the
              // epoch shift below); rebased → base asserts the seek target.
              baseTimeRef.current = timelineAbsRef.current ? 0 : from;
              {
                const localDur = timelineAbsRef.current ? total : (total > from ? total - from : 0);
                const msNow = msRef.current;
                if (localDur > 0 && msNow && msNow.readyState === "open") {
                  try { msNow.duration = localDur; } catch { /* ignore */ }
                }
              }
              // RC7: ffmpeg's fragmented-MP4 muxer re-zeros the remux to its
              // first dts, so the wire timestamps are NOT absolute on their
              // own. The proxy probes the erased origin (the first video dts
              // at the same -ss keyframe) and sends it as X-Stream-Epoch;
              // re-adding it via timestampOffset shifts the whole SourceBuffer
              // into true source time, so buffered ranges, the landing seek,
              // and the playhead math all hold exactly. Safe to set here:
              // appends for this pipeline begin only after this response.
              const epoch = parseFloat(resp.headers.get("x-stream-epoch") ?? "");
              const sbNow = sbRef.current;
              if (timelineAbsRef.current && Number.isFinite(epoch) && epoch > 0 && sbNow && !sbNow.updating) {
                try { sbNow.timestampOffset = epoch; } catch { /* ignore */ }
              }
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

    {
      // Fresh-retry resume: build from where the previous stream died and
      // land exactly there once buffered (same contract as a user seek).
      //
      // Falls back to the LIVE playhead, which is what makes a rebuild that
      // is not a user seek keep its place. This effect re-runs on a rung
      // change, and `startAtSeconds` is 0 for any stream past PLAYER_READY -
      // so an automatic quality change used to restart the file from the top,
      // taking a guest from 5:17 to 00:00 with a black gap in between and no
      // sign of what happened.
      const startAt = startAtSecondsRef.current || livePosRef.current;
      if (startAt > 0) pendingLandRef.current = startAt;
      buildPipeline(startAt);
    }

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
      previewKeySinkRef.current = null;
      previewFastRef.current = false;
      previewLastReqRef.current = null;
      if (previewExactTimerRef.current) {
        window.clearTimeout(previewExactTimerRef.current);
        previewExactTimerRef.current = 0;
      }
      const previewInput = previewInputRef.current;
      previewInputRef.current = null;
      if (previewInput) queueMicrotask(() => { void previewInput.dispose(); });
      readyRef.current = false;
      playingRef.current = false;
      const v = videoRef.current;
      try { v?.pause(); } catch { /* ignore */ }
      try { if (v) { v.removeAttribute("src"); v.load(); } } catch { /* ignore */ }
    };
    // A rung change is a different STREAM, not a different setting: the
    // presenter re-encodes at a new resolution and bitrate, so the pipeline
    // has to be torn down and rebuilt for it to take effect. Listing `rung`
    // here is what makes that happen; `rungRef` above exists only so
    // startFetch reads the current value without re-running its own effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, rung]);

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
      if (!seekingRef.current) {
        const at = corrected(el.currentTime);
        livePosRef.current = at;
        onTimeUpdateRef.current?.(at);
      }
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
    /** Seconds of media buffered ahead of the playhead, or -1 if unknowable. */
    const aheadNow = (): number => {
      const sb = sbRef.current;
      if (!sb || sb.buffered.length === 0) return -1;
      try { return sb.buffered.end(sb.buffered.length - 1) - el.currentTime; }
      catch { return -1; }
    };

    /**
     * The idle report, on the gesture that was actually reported.
     *
     * This fired only from onPlay, which measures the wrong thing for the same
     * reason it did in LocalMediaPlayer: the complaint is "I scrub twenty
     * minutes later and it holds on the parked frame", and a scrub does not
     * start with a play. The local player was corrected; this one was not, so
     * the web half of the investigation has been collecting nothing for the
     * gesture it was written to explain.
     *
     * Fires once per idle rather than once per seek, because a scrub emits a
     * burst of `seeking` events and the first is the one that pays.
     */
    const reportIdleResume = (gesture: string) => {
      const idleMs = pausedAtRef.current ? Date.now() - pausedAtRef.current : 0;
      if (idleMs <= 10_000 || reportedIdleRef.current) return;
      reportedIdleRef.current = true;
      const before = aheadAtPauseRef.current;
      const after = aheadNow();
      const pipeline = readerRef.current ? "alive" : (endedRef.current ? "ended" : "gone");
      const verdict = after < 0 ? "NO BUFFER (source buffer empty or detached)"
        : after < 0.5 ? "BUFFER EVICTED while idle"
        : before - after > 5 ? "buffer partly evicted"
        : "buffer survived (stall is downstream, not the pipeline)";
      onDiagRef.current?.(
        after >= 0.5 ? "info" : "warn",
        `${gesture} after ${Math.round(idleMs / 1000)}s idle: ahead ${before.toFixed(1)}s → `
        + `${after < 0 ? "n/a" : `${after.toFixed(1)}s`} · pipeline ${pipeline} · ${verdict}`,
      );
    };

    const onPlay = () => {
      playingRef.current = true; setIsPlaying(true); onPlayStateChange?.(true); startTick();
      // Only for a real idle. Every ordinary play/pause would drown the log.
      reportIdleResume("resume");
      pausedAtRef.current = 0;
    };
    const onPause = () => {
      pausedAtRef.current = Date.now();
      reportedIdleRef.current = false;
      aheadAtPauseRef.current = aheadNow();
      playingRef.current = false; setIsPlaying(false); onPlayStateChange?.(false);
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      if (rvfcId) { try { rvfc.cancelVideoFrameCallback(rvfcId); } catch { /* ignore */ } rvfcId = 0; }
    };
    // 'timeupdate' (≈4Hz) stays as the playhead signal while PAUSED — e.g. a
    // seek landing — and as a backstop if the frame callbacks are throttled.
    const onSeeking = () => reportIdleResume("seek");
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
    // The overlay must OUTLIVE A REBUILD - see mayHideScrubOverlay. The
    // rebuild attaches a fresh, empty MediaSource, whose `loadeddata` used to
    // reach this handler and hide the one thing holding a picture.
    const onSettled = () => {
      if (mayHideScrubOverlay({
        settleArmed: seekSettleRef.current != null,
        rebuildPending: rebuildTimerRef.current != null,
        hasSourceBuffer: !!sbRef.current,
      })) setScrubPreview(false);
    };
    // Also hide the overlay the instant real playback resumes. The
    // out-of-buffer REBUILD path can fire 'loadeddata' while the settle
    // timer is still armed (so onSettled bails), then resume the rebuilt
    // <video> with no further 'seeked' — leaving the preview canvas frozen
    // over a playing video (audio but no picture). 'playing' can't fire
    // mid-scrub (we pause on every seek tick), so clearing here is always
    // correct: if the video is genuinely playing, show it, not a stale frame.
    const onResume = () => setScrubPreview(false);
    // The starvation signal. Nothing in this app listened for `waiting`
    // anywhere before the ladder — there was no way to know a guest was
    // running dry, which is why a stalled peer stream simply stayed stalled.
    // Raw and unfiltered on purpose: debouncing here would hide the pattern
    // the (tested, pure) policy in stream-rung.ts is built to read.
    const onWaiting = () => onStallRef.current?.();
    el.addEventListener("waiting", onWaiting);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("playing", onResume);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("error", onErr);
    el.addEventListener("seeking", onSeeking);
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
      el.removeEventListener("waiting", onWaiting);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("playing", onResume);
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("error", onErr);
      el.removeEventListener("seeking", onSeeking);
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
              <BunnyMark size={52} />
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
