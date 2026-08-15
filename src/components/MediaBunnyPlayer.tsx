import {
  forwardRef, memo, useEffect, useImperativeHandle, useRef, useState,
} from "react";
import {
  Input, ALL_FORMATS,
  CanvasSink, AudioBufferSink, EncodedPacketSink,
  type InputVideoTrack, type InputAudioTrack, type WrappedCanvas,
} from "mediabunny";
import { mediabunnySource } from "../lib/mediabunny-source";
import { canvasLooksBlank } from "../lib/mediabunny-helpers";
import { audioAnchorWaitMs, shouldRetakeAnchor } from "../lib/av-clock";
import { createScrubPump, type ScrubPump } from "../lib/scrub-pump";
import { BunnyMark } from "./BunnyMark";
import type { PlayerHandle } from "./player-handle";

/** How long to wait for a decode loop to pin the clock before pinning it to
 *  the requested time anyway. Only reachable on sources with no video track,
 *  where the audio loop is the sole anchor and a dead track would otherwise
 *  leave the transport wedged. */
const ANCHOR_FALLBACK_MS = 1000;

/** How long seeks must stop arriving before a scrub-while-playing gesture is
 *  considered over and the decode pipelines are rebuilt. Matches
 *  LocalMediaPlayer's settle so the two local engines feel the same. */
const SCRUB_SETTLE_MS = 200;
/** Fast-drag detector: seeks landing closer together in time than this and
 *  farther apart in media than FAST_SCRUB_MIN_JUMP_S get KEYFRAME previews
 *  (one decode each) instead of exact frames (keyframe + forward-walk, up to
 *  a whole GOP of hidden decodes per painted frame). */
const FAST_SCRUB_GAP_MS = 160;
const FAST_SCRUB_MIN_JUMP_S = 0.35;
/** After the last seek of a fast drag, decode the EXACT frame under the
 *  cursor once the hand rests (the NLE settle). */
const FAST_SCRUB_EXACT_MS = 170;

/** Audio-scrub blip length (s). Long enough to hear a syllable at a slow
 *  drag; a fast drag supersedes it long before it ends, which is what makes
 *  the classic NLE scrub chatter. */
const SCRUB_BLIP_S = 0.08;
/** Per-blip fade in/out (s) so back-to-back blips don't click at the seams. */
const SCRUB_BLIP_FADE_S = 0.005;

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
  /** NLE-style audio blips while scrubbing (Settings, default on). */
  scrubAudio?: boolean;
  onTimeUpdate?: (seconds: number) => void;
  onPlayStateChange?: (playing: boolean) => void;
  onReady?: (duration: number) => void;
  onError?: (message: string) => void;
  onSurfaceClick?: () => void;
};

export const MediaBunnyPlayer = memo(forwardRef<PlayerHandle, Props>(function MediaBunnyPlayer(
  { path, filename, hasVideo, initialVolume, scrubAudio, onTimeUpdate, onPlayStateChange, onReady, onError, onSurfaceClick },
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
  /** Decode time accrued since the last committed shuttle step, credited back
   *  to dt so the achieved scan rate matches the rate on the badge. */
  const shuttleBusyMsRef = useRef(0);
  const lastShuttleWallRef = useRef(0);

  /**
   * Bumped on every pause/seek/teardown. In-flight async iterators read
   * their captured generation and break if it no longer matches — kills
   * the "previous decode loop schedules audio for a stale timeline" race.
   */
  const genRef = useRef(0);
  /**
   * Has the A/V clock been anchored for the CURRENT generation?
   *
   * The anchor used to be set at the moment play/seek was *requested*, which
   * charged the whole demux-seek + first-decode latency to the audio: by the
   * time the first buffer arrived it was already "late" and got discarded, so
   * every transcript-cue click opened a silent hole while the picture and the
   * playhead (both reading the still-advancing context clock) looked perfect.
   * Now the anchor is established from the first sample actually DELIVERED
   * (clamped so it can never land before the requested time), so that latency
   * becomes "starts a few ms later" instead of "loses a few ms".
   *
   * The anchor is set ONCE per generation and never moved mid-playback: moving
   * it would rewind the master clock, and every consumer of the playhead reads
   * that clock.
   */
  const anchoredRef = useRef(false);
  /** True once the audio decoder has produced a buffer for THIS source. A
   *  custom WASM decoder (Opus) pays a one-time instantiate on its first
   *  decode; until that is paid the audio loop cannot win the anchor race. */
  const audioWarmRef = useRef(false);
  /** Has any audio buffer been delivered for the CURRENT generation? Gates
   *  the one legitimate re-anchor (see runAudioLoop). */
  const audioDeliveredRef = useRef(false);
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
  /**
   * Scrub-gesture latch for seeking WHILE PLAYING. Without it every seek of a
   * drag restarted both decode pipelines — a fresh video decoder, a fresh audio
   * decoder and a demuxer keyframe seek, up to 60 times a second, none of them
   * living long enough to produce anything. The other two engines already
   * pause-and-settle (LocalMediaPlayer 200ms, MSEStreamPlayer 300ms); this
   * brings the default local player in line so scrub feel stops depending on
   * which engine happened to mount.
   */
  const scrubLatchRef = useRef(false);
  const scrubResumeRef = useRef(false);
  const scrubSettleRef = useRef(0);
  /** Audio-scrub pref (Settings → Local playback), mirrored to a ref so the
   *  []-deps imperative handle and the pump drain read the live value. */
  const scrubAudioPrefRef = useRef(scrubAudio !== false);
  /** The blip currently sounding, so the next target can cut it off. One
   *  envelope gain + the chunk nodes scheduled under it (AAC chunks are only
   *  ~21ms, so a blip is several consecutive chunks). */
  const scrubBlipRef = useRef<{ nodes: AudioBufferSourceNode[]; env: GainNode } | null>(null);
  /** Latest-wins decoder for scrub BLIPS (audio twin of scrubPumpRef). */
  const scrubAudioPumpRef = useRef<ScrubPump | null>(null);
  /** Keyframe index over the video track (fast-scrub previews). */
  const keyPacketSinkRef = useRef<EncodedPacketSink | null>(null);
  /** Fast-drag state: last request (for velocity), current mode, and the
   *  trailing exact-decode timer. */
  const scrubLastReqRef = useRef<{ t: number; at: number } | null>(null);
  const scrubFastRef = useRef(false);
  const scrubExactTimerRef = useRef(0);

  // Driving a setState for the visible play/pause UI on audio-only mode.
  const [isPlaying, setIsPlaying] = useState(false);

  // Live-mirror the pref; the imperative handle and pump drains read the ref.
  useEffect(() => { scrubAudioPrefRef.current = scrubAudio !== false; }, [scrubAudio]);

  // ─── Helpers ────────────────────────────────────────────────────────
  const currentMediaTime = () => {
    if (!playingRef.current) return startMediaTimeRef.current;
    const ctx = audioCtxRef.current;
    if (!ctx) return startMediaTimeRef.current;
    // Pre-roll: play/seek has been requested but no sample has landed yet, so
    // the anchor is stale. Hold at the requested time rather than measuring
    // against a previous generation's anchor (which would jump the playhead).
    if (!anchoredRef.current) return startMediaTimeRef.current;
    return startMediaTimeRef.current + (ctx.currentTime - startContextTimeRef.current);
  };

  /**
   * Pin the media clock to the wall clock using the first sample actually
   * delivered for this generation. Audio owns the anchor when there's an audio
   * track (it's the sample-accurate clock); the video loop only anchors when
   * there's no audio, or audio didn't produce anything in time.
   */
  const anchorClock = (mediaTime: number, ctx: AudioContext) => {
    startMediaTimeRef.current = mediaTime;
    startContextTimeRef.current = ctx.currentTime;
    anchoredRef.current = true;
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

  /**
   * Cut the current scrub blip off (start of the next blip, or any path that
   * takes over the transport). Ref-only, safe from render scope.
   *
   * IT FADES, IT DOES NOT STOP. Calling `stop()` on a source severs the
   * waveform at whatever amplitude it happened to be at, and a discontinuity
   * that steep is a click. The envelope already has a fade at each end, but it
   * only ever ran when a blip played all the way through — and during a real
   * drag almost NO blip does, because the pump is latest-wins and the next
   * target cuts this one off. So the fade was in place for the quiet case and
   * absent for every case anyone would hear, which is why scrubbing sounded
   * like a machine gun of attack transients rather than like audio.
   *
   * Ramping to zero over the same 5ms instead means a cutover crossfades into
   * the incoming blip (which starts after exactly that much scheduling
   * headroom) rather than colliding with it.
   */
  const stopScrubBlip = () => {
    const blip = scrubBlipRef.current;
    if (!blip) return;
    scrubBlipRef.current = null;
    const ctx = audioCtxRef.current;
    const release = (nodes: AudioBufferSourceNode[], env: GainNode) => {
      for (const n of nodes) {
        try { n.stop(); } catch { /* already stopped */ }
        try { n.disconnect(); } catch { /* ignore */ }
      }
      try { env.disconnect(); } catch { /* ignore */ }
    };
    // No context (teardown) means nothing is sounding anyway; drop the graph.
    if (!ctx || ctx.state === "closed") { release(blip.nodes, blip.env); return; }
    const now = ctx.currentTime;
    const end = now + SCRUB_BLIP_FADE_S;
    try {
      const g = blip.env.gain;
      // cancelAndHoldAtTime pins the CURRENT automated value before ramping;
      // without it, cancelScheduledValues alone can snap the gain back to the
      // last explicitly-set value and produce the very click being avoided.
      if (typeof g.cancelAndHoldAtTime === "function") g.cancelAndHoldAtTime(now);
      else { g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); }
      g.linearRampToValueAtTime(0, end);
      for (const n of blip.nodes) { try { n.stop(end); } catch { /* already stopped */ } }
    } catch {
      release(blip.nodes, blip.env);
      return;
    }
    // Disconnect only after the ramp has actually run.
    window.setTimeout(() => release(blip.nodes, blip.env), (SCRUB_BLIP_FADE_S + 0.05) * 1000);
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
      let decodeAt = target;
      if (scrubFastRef.current && keyPacketSinkRef.current) {
        // Fast drag: paint the keyframe at-or-before the cursor. Decoding a
        // keyframe timestamp needs no forward walk, so preview rate stops
        // depending on the source's GOP length. The trailing settle pass
        // (seekTo) repaints the exact frame once the hand rests.
        try {
          const pkt = await keyPacketSinkRef.current.getKeyPacket(target, { verifyKeyPackets: false });
          if (pkt) decodeAt = pkt.timestamp;
        } catch { /* fall back to the exact decode */ }
      }
      let wrapped: WrappedCanvas | null = null;
      try { wrapped = await sink.getCanvas(decodeAt); }
      catch { return; }
      if (gen === genRef.current && wrapped) drawCanvas(wrapped.canvas);
    });
  }

  // Audio twin of the pump above: an NLE-style blip of the sound under the
  // cursor. Same latest-wins shape (a fast drag supersedes each blip, which
  // is exactly the classic scrub chatter). One blip = ~80ms of consecutive
  // decoded chunks (AAC chunks are only ~21ms each) scheduled sample-
  // continuously under a single 5ms-fade envelope, riding the master gain so
  // volume and mute apply. Deliberately fire-and-forget: it never touches
  // the anchor, the playback generation, or scheduledRef, so it cannot
  // interact with the clock model.
  if (!scrubAudioPumpRef.current) {
    scrubAudioPumpRef.current = createScrubPump(async (target: number) => {
      if (!scrubAudioPrefRef.current || mutedRef.current) return;
      const gen = genRef.current;
      const sink = audioSinkRef.current;
      const ctx = audioCtxRef.current;
      const gain = gainRef.current;
      if (!sink || !ctx || !gain) return;
      if (ctx.state === "suspended") {
        // A scrub IS a user gesture, so WKWebView allows the resume here.
        try { await ctx.resume(); } catch { return; }
        if (gen !== genRef.current) return;
      }
      stopScrubBlip();
      const env = ctx.createGain();
      env.connect(gain);
      const start = ctx.currentTime + 0.005; // scheduling headroom
      env.gain.setValueAtTime(0, start);
      env.gain.linearRampToValueAtTime(1, start + SCRUB_BLIP_FADE_S);
      env.gain.setValueAtTime(1, start + SCRUB_BLIP_S - SCRUB_BLIP_FADE_S);
      env.gain.linearRampToValueAtTime(0, start + SCRUB_BLIP_S);
      const entry = { nodes: [] as AudioBufferSourceNode[], env };
      scrubBlipRef.current = entry;
      try {
        for await (const w of sink.buffers(target, target + SCRUB_BLIP_S)) {
          // Bail if playback took over or a newer blip cut this one off.
          if (gen !== genRef.current || scrubBlipRef.current !== entry) break;
          const off = Math.max(0, target - w.timestamp);
          if (off >= w.buffer.duration) continue;
          const src = ctx.createBufferSource();
          src.buffer = w.buffer;
          src.connect(env);
          // The envelope bounds the audible window, so chunks just play out.
          src.start(start + Math.max(0, w.timestamp - target), off);
          entry.nodes.push(src);
        }
      } catch { /* sink torn down mid-drag */ }
      // The envelope is fully closed at start+SCRUB_BLIP_S; release the graph
      // shortly after (stopScrubBlip may already have — everything is guarded).
      window.setTimeout(() => {
        if (scrubBlipRef.current === entry) scrubBlipRef.current = null;
        for (const n of entry.nodes) {
          try { n.stop(); } catch { /* done */ }
          try { n.disconnect(); } catch { /* ignore */ }
        }
        try { env.disconnect(); } catch { /* ignore */ }
      }, (SCRUB_BLIP_S + 0.05) * 1000);
    });
  }

  /** Cancel all in-flight work without changing playing state. */
  const cancelInFlight = () => {
    genRef.current++;
    // A new generation must re-anchor from its own first delivered sample.
    // (stopPlayback reads currentMediaTime() before calling this, so the
    // resume point is already captured against the outgoing anchor.)
    anchoredRef.current = false;
    audioDeliveredRef.current = false;
    // Drop any pending scrub target too; the in-flight decode (if any) is
    // gated by the gen bump above and won't paint.
    scrubPumpRef.current?.cancel();
    scrubAudioPumpRef.current?.cancel();
    stopScrubBlip();
    if (scrubExactTimerRef.current) {
      window.clearTimeout(scrubExactTimerRef.current);
      scrubExactTimerRef.current = 0;
    }
    scrubFastRef.current = false;
    for (const node of scheduledRef.current) {
      try { node.stop(); } catch { /* already stopped */ }
      try { node.disconnect(); } catch { /* ignore */ }
    }
    scheduledRef.current = [];
  };

  /** Abandon any in-progress scrub gesture WITHOUT resuming playback. Called
   *  from every path that decides the transport state itself (pause, play,
   *  shuttle, teardown), so a pending settle can't resurrect playback after. */
  const clearScrubLatch = () => {
    scrubLatchRef.current = false;
    scrubResumeRef.current = false;
    if (scrubSettleRef.current) { window.clearTimeout(scrubSettleRef.current); scrubSettleRef.current = 0; }
  };

  const stopPlayback = () => {
    if (playingRef.current) {
      startMediaTimeRef.current = currentMediaTime();
    }
    clearScrubLatch();
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
      // Clamp only the time NOT spent inside a decode. The busy guard above
      // skips frames without moving lastShuttleWall, so a decode longer than
      // 100ms (routine on long-GOP 1080p/4K, where each getCanvas decodes from
      // the preceding keyframe) had everything past the clamp thrown away: an
      // 8x shuttle actually scanned at ~3x while the badge read 8x. Decode time
      // is expected work and must still advance the scan; a genuine stall
      // (backgrounded tab, long GC) is still capped.
      const busySec = shuttleBusyMsRef.current / 1000;
      shuttleBusyMsRef.current = 0;
      const elapsed = Math.max(0, (now - lastShuttleWallRef.current) / 1000);
      const dt = Math.min(0.1, Math.max(0, elapsed - busySec)) + busySec;
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
        const decodeStart = performance.now();
        sink.getCanvas(t)
          .then((wrapped) => { if (wrapped && shuttleRateRef.current !== 0) drawCanvas(wrapped.canvas); })
          .catch(() => { /* ignore */ })
          .finally(() => {
            // Credited back to dt above, so a slow decode doesn't slow the scan.
            shuttleBusyMsRef.current += performance.now() - decodeStart;
            shuttleBusyRef.current = false;
          });
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
      // Audio owns the clock anchor when there IS an audio track, so hold the
      // first frame until it lands (bounded — a silent or undecodable track
      // must never stall the picture). With no audio sink, video anchors.
      const audioLeads = !!audioSinkRef.current;
      for await (const wrapped of sink.canvases(fromTime, durationRef.current)) {
        if (gen !== genRef.current) return;
        if (!anchoredRef.current) {
          if (audioLeads) {
            // Audio owns the clock when there is an audio track, so the
            // picture waits for it. How long depends on whether the audio
            // decoder has already paid its instantiate: warm, it lands in
            // milliseconds; COLD (first play of an Opus/WASM-decoded file)
            // it can take most of a second, and cutting the wait short is
            // exactly what hands the anchor to video and silences the file.
            const deadline = performance.now() + audioAnchorWaitMs(audioWarmRef.current);
            while (!anchoredRef.current && performance.now() < deadline) {
              await new Promise<void>((r) => setTimeout(r, 10));
              if (gen !== genRef.current) return;
            }
          }
          // Clamped to fromTime for the same reason as the audio anchor: the
          // sink yields the frame at or before the requested time first.
          if (!anchoredRef.current) anchorClock(Math.max(fromTime, wrapped.timestamp), ctx);
        }
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
        onErrorRef.current?.(`Video decode failed: ${err instanceof Error ? err.message : String(err)}`);
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
        // First buffer of this generation owns the clock — see anchoredRef.
        // Clamped to fromTime because the sink deliberately yields the last
        // sample at or BEFORE the requested time first: anchoring on that raw
        // timestamp would report a position up to one packet earlier than the
        // caller asked for, which lands a cue click on the previous cue and
        // creeps backwards across repeated play/pause cycles.
        const firstOfGeneration = !audioDeliveredRef.current;
        audioDeliveredRef.current = true;
        audioWarmRef.current = true; // the decoder has now paid its instantiate
        if (!anchoredRef.current) {
          anchorClock(Math.max(fromTime, wrapped.timestamp), ctx);
        } else if (shouldRetakeAnchor({
          // The video loop anchored while this decoder was still warming up,
          // so the clock has run past the audio we are only now holding and
          // every chunk would be dropped below as late — a perfect picture
          // with no sound. Audio is the master clock: take it back. The rule
          // (and why it is safe only here) lives in lib/av-clock.ts, pinned
          // by av-clock.test.ts against this exact scenario.
          firstOfGeneration,
          scheduledCount: scheduledRef.current.length,
          wouldLandAt: startContextTimeRef.current
            + (wrapped.timestamp - startMediaTimeRef.current),
          chunkDuration: wrapped.buffer.duration,
          now: ctx.currentTime,
        })) {
          anchorClock(Math.max(fromTime, wrapped.timestamp), ctx);
        }
        const source = ctx.createBufferSource();
        source.buffer = wrapped.buffer;
        source.connect(gain);
        const targetCtxTime = startContextTimeRef.current + (wrapped.timestamp - startMediaTimeRef.current);
        let started = false;
        if (targetCtxTime <= ctx.currentTime) {
          // Behind the clock: play only the part of the chunk still ahead of
          // it. (This is also how the first chunk after a seek trims itself
          // down to exactly the requested time.)
          const offset = ctx.currentTime - targetCtxTime;
          if (offset < wrapped.buffer.duration) {
            source.start(0, offset);
            started = true;
          }
          // Otherwise the chunk is entirely in the past, so it is dropped:
          // skipping late audio is how playback stays in sync after a stall.
          // Do NOT "rescue" it by re-anchoring the clock to its timestamp —
          // that rewinds the master clock by the whole lateness, jumping the
          // playhead (and every consumer of it) backwards and stalling the
          // picture for the same span while video waits for the new anchor.
        } else {
          source.start(targetCtxTime);
          started = true;
        }
        if (started) {
          scheduledRef.current.push(source);
          source.onended = () => {
            const idx = scheduledRef.current.indexOf(source);
            if (idx >= 0) scheduledRef.current.splice(idx, 1);
          };
        } else {
          // Never-started nodes can never fire onended, so they must not go in
          // scheduledRef — they would sit there holding their decoded PCM.
          try { source.disconnect(); } catch { /* ignore */ }
        }
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
        // With no video track this loop is the only one running, so nothing
        // else would ever settle the transport — the UI would sit reporting
        // "playing" against a frozen clock.
        if (!videoSinkRef.current) stopPlayback();
        onErrorRef.current?.(`Audio decode failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  /**
   * Resume the context, then run both decode loops for `gen`.
   *
   * The resume must be AWAITED. This context is built inside an effect, never
   * inside a user gesture, so WKWebView can start it suspended — and a
   * gestureless caller (a remote transport op arriving from the co-review
   * network callback) would otherwise leave it suspended: ctx.currentTime
   * frozen, no audio, yet the UI reporting "playing". Awaiting costs nothing
   * now that the clock is anchored from the first delivered buffer rather than
   * from this moment.
   */
  const startLoops = async (ctx: AudioContext, fromTime: number, gen: number) => {
    if (ctx.state === "suspended") {
      try { await ctx.resume(); } catch { /* fall through to the state check */ }
      if (gen !== genRef.current) return;
      if (ctx.state === "suspended") {
        // Settle paused and let the next gesture-backed play() retry. This is a
        // recoverable transport condition, NOT a decode failure — reporting it
        // through onError would make App tear this player down and swap engines
        // over something the very next click fixes.
        playingRef.current = false;
        setIsPlaying(false);
        onPlayStateChange?.(false);
        return;
      }
    }
    if (gen !== genRef.current) return;
    audioDeliveredRef.current = false;
    runAudioLoop(fromTime, gen);
    runVideoLoop(fromTime, gen);
    // Anchor fallback. runVideoLoop is the unconditional anchor, but it returns
    // immediately when there is no video sink, which leaves runAudioLoop as the
    // ONLY anchor on audio-only sources (podcasts, interviews). If it never
    // delivers a buffer the clock would stay frozen while the UI reports
    // playing, so pin it here rather than leave the transport wedged.
    window.setTimeout(() => {
      if (gen !== genRef.current || !playingRef.current || anchoredRef.current) return;
      anchorClock(fromTime, ctx);
    }, ANCHOR_FALLBACK_MS);
  };

  // Periodic time-update tick for the parent's playhead — independent of
  // the decode loops so the UI updates smoothly even between frame draws.
  // Read onTimeUpdate via a ref so the interval (set once on mount with
  // [] deps) always calls the LATEST callback; without this the parent's
  // freshly-created inline handler would never be invoked, the playhead
  // would freeze the moment App.tsx re-rendered.
  const onTimeUpdateRef = useRef(onTimeUpdate);
  useEffect(() => { onTimeUpdateRef.current = onTimeUpdate; }, [onTimeUpdate]);
  /**
   * Same treatment for onError, and for the same reason the ref above exists.
   *
   * The imperative handle is built once (`[]`) and captures startLoops,
   * stopPlayback, cancelInFlight and startShuttleLoop as they were on the first
   * render. Those close over props — and `onError` reaches this player from an
   * inline arrow in App, rebuilt every render over live state. The player is
   * NOT keyed on `path`, so switching files reuses this instance and the
   * captured copies stay behind.
   *
   * Every onError call now reads the ref, not just the ones inside the handle:
   * one pattern per prop is what stops the next long-lived closure quietly
   * reintroducing this.
   */
  const onErrorRef = useRef(onError);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  useEffect(() => {
    const t = window.setInterval(() => {
      if (playingRef.current) onTimeUpdateRef.current?.(currentMediaTime());
    }, 100);
    return () => {
      window.clearInterval(t);
      if (shuttleRafRef.current) { cancelAnimationFrame(shuttleRafRef.current); shuttleRafRef.current = 0; }
    };
  }, []);

  // ─── Public handle ──────────────────────────────────────────────────
  useImperativeHandle(ref, () => ({
    play: () => {
      if (!readyRef.current) return;
      const ctx = audioCtxRef.current;
      if (!ctx) return;
      clearScrubLatch(); // an explicit play supersedes any pending scrub settle
      cancelInFlight();
      const gen = ++genRef.current;
      // No anchor here: the clock is pinned by the first sample the loops
      // actually deliver (see anchoredRef), so decode latency delays the start
      // instead of being charged to the audio and dropped.
      // startMediaTime stays whatever it was — the resume point.
      playingRef.current = true;
      setIsPlaying(true);
      onPlayStateChange?.(true);
      void startLoops(ctx, startMediaTimeRef.current, gen);
    },
    pause: () => stopPlayback(),
    seekTo: (s: number) => {
      const clamped = Math.max(0, Math.min(durationRef.current, s));
      const wasPlaying = playingRef.current;
      // Fast-drag detection: closely-spaced seeks covering real media
      // distance switch the preview pump to keyframe mode (one decode per
      // painted frame). The trailing timer decodes the EXACT resting frame
      // once seeks stop, so precision returns the moment the hand does.
      {
        const now = performance.now();
        const last = scrubLastReqRef.current;
        scrubLastReqRef.current = { t: clamped, at: now };
        scrubFastRef.current = !!last
          && now - last.at < FAST_SCRUB_GAP_MS
          && Math.abs(clamped - last.t) > FAST_SCRUB_MIN_JUMP_S;
        if (scrubExactTimerRef.current) window.clearTimeout(scrubExactTimerRef.current);
        if (scrubFastRef.current) {
          scrubExactTimerRef.current = window.setTimeout(() => {
            scrubExactTimerRef.current = 0;
            scrubFastRef.current = false;
            const rest = scrubLastReqRef.current;
            if (rest) scrubPumpRef.current?.request(rest.t);
          }, FAST_SCRUB_EXACT_MS);
        }
      }
      startMediaTimeRef.current = clamped;
      // Via the ref, like the 100ms tick and the shuttle loop: this handle is
      // built with [] deps, so calling the prop directly would publish through
      // the callback captured at MOUNT (a stale fps), desyncing the transcript
      // from the player on every cue click.
      onTimeUpdateRef.current?.(clamped);
      if (wasPlaying || scrubLatchRef.current) {
        // Seeking while playing. Treat a burst of seeks as ONE gesture: stop
        // the pipelines on the first, preview through the scrub pump for the
        // duration, and rebuild them ONCE when the seeks stop. Restarting per
        // seek meant building and abandoning a video decoder, an audio decoder
        // and a demuxer seek every vsync, so a drag produced silence and a
        // stalled picture rather than a preview.
        if (!scrubLatchRef.current) {
          scrubLatchRef.current = true;
          scrubResumeRef.current = wasPlaying;
          cancelInFlight(); // playback really is being interrupted here
        }
        scrubPumpRef.current?.request(clamped);
        scrubAudioPumpRef.current?.request(clamped);
        if (scrubSettleRef.current) window.clearTimeout(scrubSettleRef.current);
        scrubSettleRef.current = window.setTimeout(() => {
          scrubSettleRef.current = 0;
          scrubLatchRef.current = false;
          if (!scrubResumeRef.current) return;
          scrubResumeRef.current = false;
          const ctx = audioCtxRef.current;
          if (!ctx || !playingRef.current) return;
          // A blip still sounding would double the first ~50ms of the
          // resumed audio at the same position — cut it before the rebuild.
          stopScrubBlip();
          const gen = ++genRef.current;
          // Anchored from the first delivered sample, not from here — this is
          // the path a transcript-cue click takes, and anchoring at the request
          // charged the whole seek latency to the audio and lost it.
          void startLoops(ctx, startMediaTimeRef.current, gen);
        }, SCRUB_SETTLE_MS);
      } else {
        // Paused seek / scrub. Coalesce into the single-flight pump: it keeps
        // only the newest target, so a fast drag chases the cursor instead of
        // queueing a decode per seek.
        //
        // Deliberately NOT cancelInFlight() here. That bumped the playback
        // generation on every seek, which invalidated the scrub decode it had
        // just started: the timeline fires one seek per vsync, so while the
        // cursor kept moving nothing ever survived to paint. The picture sat
        // frozen until the drag stopped, having burned a full keyframe-to-target
        // decode per display frame producing images nobody saw. The drain's own
        // generation check still prevents a scrub frame landing after playback
        // resumes, which is the case that gate exists for.
        scrubPumpRef.current?.request(clamped);
        scrubAudioPumpRef.current?.request(clamped);
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
        clearScrubLatch();          // J-K-L supersedes any pending scrub settle
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
    audioWarmRef.current = false; // a new source means a cold decoder again
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
            onErrorRef.current?.(`[WEBCODECS_UNSUPPORTED] video codec "${codec}"`);
            return;
          }
          // NO ProRes short-circuit (r148). turbores is the FASTER decoder
          // for ProRes — ~310 fps vs ffmpeg's ~107 at 4K 422 HQ — so routing
          // it to a transcode on sight would trade a 3x win for a subprocess
          // and a wait. The old 10-bit black-canvas hazard is handled inside
          // @mediabunny/prores: it probes which VideoFrame formats this
          // platform can actually construct and passes them to turbores as
          // allowedOutputFormats, so it never emits a sample WKWebView cannot
          // wrap. The empirical paint check below is the backstop, and it now
          // guards EVERY codec instead of banning one.
          // Packet-level keyframe lookup: lets a fast drag snap its preview
          // to the keyframe at-or-before the cursor, ONE decode per painted
          // frame instead of a keyframe-to-target walk.
          keyPacketSinkRef.current = new EncodedPacketSink(vt);
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
            if (cancelled) return;
            if (!first) throw new Error("no frame at 0s");
            drawCanvas(first.canvas);
            // A canvas that decoded but reads PURE BLACK is the silent
            // failed-wrap signature (nothing throws). One black frame proves
            // nothing — fades and slates are ordinary footage — so probe a
            // second time deeper in. Two blacks = this platform cannot paint
            // this source: hand off to the ffmpeg-prep fallback instead of
            // playing a black picture.
            if (canvasLooksBlank(first.canvas)) {
              const probeAt = dur > 0 ? Math.min(dur * 0.25, Math.max(0, dur - 0.05)) : 1;
              const second = await videoSinkRef.current.getCanvas(probeAt);
              if (cancelled) return;
              if (!second || canvasLooksBlank(second.canvas)) {
                const codec = await vt.getCodec().catch(() => "unknown");
                onErrorRef.current?.(`[WEBCODECS_UNSUPPORTED] ${codec} decodes but paints black here`);
                return;
              }
              drawCanvas(second.canvas);
            }
          } catch (e) {
            if (cancelled) return;
            const codec = await vt.getCodec().catch(() => "unknown");
            onErrorRef.current?.(`[WEBCODECS_UNSUPPORTED] ${codec} video can't be rendered here (${e instanceof Error ? e.message : String(e)})`);
            return;
          }
        }
        if (at) {
          if (!(await at.canDecode())) {
            const codec = await at.getCodec().catch(() => "unknown");
            // Audio-only codec issues also trigger fallback — playing
            // silent video is technically possible but most users hit
            // this in podcasts/interviews where audio IS the content.
            onErrorRef.current?.(`[WEBCODECS_UNSUPPORTED] audio codec "${codec}"`);
            return;
          }
          audioSinkRef.current = new AudioBufferSink(at);
          // Pay the audio decoder's one-time instantiate NOW, not on the first
          // play(). A custom WASM decoder (Opus registers one) builds libopus
          // inside its first decode; when that cost lands during play() the
          // video loop wins the anchor race, every audio chunk is then judged
          // late and dropped, and the file plays SILENTLY behind a perfect
          // picture. Fire and forget — onReady must not wait on it.
          void audioSinkRef.current.getBuffer(0)
            .then(() => { if (!cancelled) audioWarmRef.current = true; })
            .catch(() => { /* still cold: the video loop just waits longer */ });
        }

        readyRef.current = true;
        onReady?.(dur);
      } catch (err) {
        if (!cancelled) {
          onErrorRef.current?.(`Failed to open file: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    })();

    return () => {
      cancelled = true;
      clearScrubLatch(); // no settle may fire against the outgoing source
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
      )}
    </div>
  );
}));
