/**
 * Sauce Bunny audio-decode probe (harness, not app code).
 *
 * Runs the REAL mediabunny decode path against a real Opus-bearing file in
 * Chromium, and reports observed numbers. Driven by run.mjs; each `?mode=`
 * gets a FRESH page so the module registry (and therefore the custom-decoder
 * registration) starts clean.
 *
 * Nothing in src/ is imported except src/lib/mediabunny-decoders.ts, which is
 * the real registration the app performs at startup.
 */
import {
  ALL_FORMATS, Input, UrlSource, AudioBufferSink, CanvasSink,
} from "mediabunny";
// The REAL clock rules the shipped player uses.
import { shouldRetakeAnchor, audioAnchorWaitMs } from "../src/lib/av-clock";

type Json = Record<string, unknown>;

const params = new URLSearchParams(location.search);
const mode = params.get("mode") ?? "caps";
const SRC = params.get("src") ?? "/harness-audio/sample.mp4";

// ─── spies ──────────────────────────────────────────────────────────────
// Two-sided proof of which decoder actually ran:
//   • native WebCodecs path  → `new AudioDecoder(...)` is constructed
//   • our OpusAudioDecoder   → opus-decoder compiles/instantiates libopus WASM
const spy = {
  audioDecoderCtors: [] as string[],
  audioDecoderConfigures: [] as string[],
  videoDecoderCtors: 0,
  wasmCompile: 0,
  wasmInstantiate: 0,
};

const NativeAudioDecoder = globalThis.AudioDecoder;
if (NativeAudioDecoder) {
  class SpyAudioDecoder extends NativeAudioDecoder {
    constructor(init: AudioDecoderInit) {
      super(init);
      spy.audioDecoderCtors.push(new Error().stack?.split("\n")[2]?.trim() ?? "?");
    }
    configure(cfg: AudioDecoderConfig) {
      spy.audioDecoderConfigures.push(cfg.codec);
      return super.configure(cfg);
    }
  }
  // @ts-expect-error test double
  globalThis.AudioDecoder = SpyAudioDecoder;
}
const NativeVideoDecoder = globalThis.VideoDecoder;
if (NativeVideoDecoder) {
  class SpyVideoDecoder extends NativeVideoDecoder {
    constructor(init: VideoDecoderInit) { super(init); spy.videoDecoderCtors++; }
  }
  // @ts-expect-error test double
  globalThis.VideoDecoder = SpyVideoDecoder;
}
const origCompile = WebAssembly.compile.bind(WebAssembly);
// @ts-expect-error test double
WebAssembly.compile = (...a: unknown[]) => { spy.wasmCompile++; return origCompile(...(a as [BufferSource])); };
const origInstantiate = WebAssembly.instantiate.bind(WebAssembly);
// @ts-expect-error test double
WebAssembly.instantiate = (...a: unknown[]) => { spy.wasmInstantiate++; return (origInstantiate as never as (...x: unknown[]) => unknown)(...a); };

// ─── helpers ────────────────────────────────────────────────────────────
const hex = (b: ArrayBufferView | ArrayBuffer | null | undefined, n = 24) => {
  if (!b) return null;
  const u8 = ArrayBuffer.isView(b)
    ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
    : new Uint8Array(b);
  return Array.from(u8.subarray(0, n)).map(x => x.toString(16).padStart(2, "0")).join(" ");
};

const ascii = (b: ArrayBufferView | ArrayBuffer | null | undefined, n = 8) => {
  if (!b) return null;
  const u8 = ArrayBuffer.isView(b)
    ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
    : new Uint8Array(b);
  return String.fromCharCode(...Array.from(u8.subarray(0, n))).replace(/[^\x20-\x7e]/g, ".");
};

/** peak + rms of an AudioBuffer, all channels. */
function measure(buf: AudioBuffer) {
  let peak = 0, sumsq = 0, n = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const v = Math.abs(d[i]);
      if (v > peak) peak = v;
      sumsq += d[i] * d[i];
      n++;
    }
  }
  return { peak: +peak.toFixed(6), rms: +Math.sqrt(sumsq / Math.max(1, n)).toFixed(6) };
}

async function openInput() {
  const input = new Input({ source: new UrlSource(SRC), formats: ALL_FORMATS });
  const [vt, at, dur] = await Promise.all([
    input.getPrimaryVideoTrack(),
    input.getPrimaryAudioTrack(),
    input.computeDuration(),
  ]);
  return { input, vt, at, dur };
}

async function trackInfo(at: NonNullable<Awaited<ReturnType<typeof openInput>>["at"]>) {
  const codec = await at.getCodec();
  const cfg = await at.getDecoderConfig();
  const canDecode = await at.canDecode();
  return {
    codec,
    canDecode,
    decoderConfig: cfg && {
      codec: cfg.codec,
      sampleRate: cfg.sampleRate,
      numberOfChannels: cfg.numberOfChannels,
      descriptionBytes: cfg.description ? (ArrayBuffer.isView(cfg.description) ? cfg.description.byteLength : (cfg.description as ArrayBuffer).byteLength) : 0,
      descriptionHex: hex(cfg.description as ArrayBufferView | undefined),
      descriptionMagic: ascii(cfg.description as ArrayBufferView | undefined),
    },
  };
}

/** Fully drain a buffers() iterator, recording every chunk. */
async function drain(
  sink: AudioBufferSink, from: number, to: number,
  opts: { interleaveGetBufferEvery?: number; cap?: number; paceMs?: number } = {},
) {
  const t0 = performance.now();
  const chunks: Json[] = [];
  const interleaved: Json[] = [];
  let firstAt = -1;
  let error: string | null = null;
  let i = 0;
  try {
    for await (const w of sink.buffers(from, to)) {
      if (firstAt < 0) firstAt = +(performance.now() - t0).toFixed(1);
      const m = measure(w.buffer);
      chunks.push({
        i, ts: +w.timestamp.toFixed(6), dur: +w.duration.toFixed(6),
        frames: w.buffer.length, sr: w.buffer.sampleRate, ch: w.buffer.numberOfChannels,
        ...m,
      });
      i++;
      if (opts.interleaveGetBufferEvery && i % opts.interleaveGetBufferEvery === 0) {
        // Exactly what the scrub-blip pump does: getBuffer() on the SAME sink
        // while a buffers() iteration is live.
        const g0 = performance.now();
        try {
          const g = await sink.getBuffer(Math.min(to - 0.1, w.timestamp + 1.0));
          interleaved.push({
            afterChunk: i, ok: !!g, ts: g ? +g.timestamp.toFixed(6) : null,
            ...(g ? measure(g.buffer) : {}),
            ms: +(performance.now() - g0).toFixed(1),
          });
        } catch (e) {
          interleaved.push({ afterChunk: i, ok: false, error: String(e) });
        }
      }
      if (opts.cap && i >= opts.cap) break;
      // Pace the pull so a concurrent consumer genuinely overlaps it (real
      // playback is rate-limited by the 3s-ahead backpressure, not by CPU).
      if (opts.paceMs) await new Promise(r => setTimeout(r, opts.paceMs));
    }
  } catch (e) {
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  const totalMs = +(performance.now() - t0).toFixed(1);
  const nonSilent = chunks.filter(c => (c.peak as number) > 1e-5).length;
  return {
    count: chunks.length,
    firstBufferMs: firstAt,
    totalMs,
    error,
    nonSilentChunks: nonSilent,
    silentChunks: chunks.length - nonSilent,
    coveredSeconds: chunks.length
      ? +(((chunks.at(-1)!.ts as number) + (chunks.at(-1)!.dur as number)) - (chunks[0].ts as number)).toFixed(3)
      : 0,
    globalPeak: chunks.length ? Math.max(...chunks.map(c => c.peak as number)) : 0,
    first5: chunks.slice(0, 5),
    last3: chunks.slice(-3),
    interleaved,
  };
}

// ─── modes ──────────────────────────────────────────────────────────────
async function run(): Promise<Json> {
  if (mode !== "native") {
    // The real app registration (src/lib/mediabunny-decoders.ts).
    const m = await import("../src/lib/mediabunny-decoders");
    m.registerLocalDecoders();
  }

  if (mode === "caps") {
    const audio = await (globalThis.AudioDecoder as typeof AudioDecoder | undefined)
      ?.isConfigSupported({ codec: "opus", sampleRate: 48000, numberOfChannels: 2 })
      .then(r => ({ supported: r.supported })).catch(e => ({ error: String(e) }));
    const video = await (globalThis.VideoDecoder as typeof VideoDecoder | undefined)
      ?.isConfigSupported({ codec: "av01.0.08M.08", codedWidth: 1920, codedHeight: 1080 })
      .then(r => ({ supported: r.supported })).catch(e => ({ error: String(e) }));
    const { input, vt, at, dur } = await openInput();
    const info = at ? await trackInfo(at) : null;
    const vinfo = vt ? { codec: await vt.getCodec(), canDecode: await vt.canDecode() } : null;
    await input.dispose();
    return {
      hasAudioDecoder: !!globalThis.AudioDecoder,
      hasVideoDecoder: !!globalThis.VideoDecoder,
      nativeOpusSupported: audio, nativeAv1Supported: video,
      duration: +dur.toFixed(3), audioTrack: info, videoTrack: vinfo,
    };
  }

  // ── Q1/Q2: plain full drain, with and without our custom decoder ──
  if (mode === "native" || mode === "custom") {
    const { input, at, dur } = await openInput();
    if (!at) throw new Error("no audio track");
    const info = await trackInfo(at);
    const sink = new AudioBufferSink(at);
    const res = await drain(sink, 0, dur);
    await input.dispose();
    return { track: info, drain: res, spy };
  }

  // ── Q3: prime with getBuffer(0), THEN iterate buffers() on the SAME sink ──
  if (mode === "prime") {
    const { input, at, dur } = await openInput();
    if (!at) throw new Error("no audio track");
    const sink = new AudioBufferSink(at);
    const p0 = performance.now();
    let primed: Json;
    try {
      const g = await sink.getBuffer(0);
      primed = { ok: !!g, ms: +(performance.now() - p0).toFixed(1), ts: g ? +g.timestamp.toFixed(6) : null, ...(g ? measure(g.buffer) : {}) };
    } catch (e) { primed = { ok: false, error: String(e), ms: +(performance.now() - p0).toFixed(1) }; }
    const res = await drain(sink, 0, dur);
    await input.dispose();
    return { primed, drain: res, spy };
  }

  // ── Q3b: the SHIPPED shape — fire-and-forget getBuffer(0), do NOT await,
  //         then immediately start the buffers() iteration (the race). ──
  if (mode === "prime-race") {
    const { input, at, dur } = await openInput();
    if (!at) throw new Error("no audio track");
    const sink = new AudioBufferSink(at);
    let primeDone = -1;
    const p0 = performance.now();
    let primeErr: string | null = null;
    void sink.getBuffer(0)
      .then(() => { primeDone = +(performance.now() - p0).toFixed(1); })
      .catch(e => { primeErr = String(e); });
    const res = await drain(sink, 0, dur);
    await new Promise(r => setTimeout(r, 250));
    await input.dispose();
    return { primeResolvedAtMs: primeDone, primeError: primeErr, drain: res, spy };
  }

  // ── Q4: getBuffer() interleaved DURING a live buffers() iteration ──
  if (mode === "interleave") {
    const { input, at, dur } = await openInput();
    if (!at) throw new Error("no audio track");
    const sink = new AudioBufferSink(at);
    const res = await drain(sink, 0, dur, { interleaveGetBufferEvery: 20 });
    await input.dispose();
    return { drain: res, spy };
  }

  // ── Real playback: replicate runAudioLoop's scheduling arithmetic against a
  //    real AudioContext and measure what the graph actually renders. ──
  if (mode === "playback" || mode === "playback-primed") {
    const { input, at, dur } = await openInput();
    if (!at) throw new Error("no audio track");
    const ctx = new AudioContext();
    const ctxStateBefore = ctx.state;
    const ctxTimeBefore = ctx.currentTime;
    let resumeMs = -1, resumeErr: string | null = null;
    if (ctx.state === "suspended") {
      const r0 = performance.now();
      // Bound it: a resume that never settles is itself the finding.
      await Promise.race([
        ctx.resume().catch((e) => { resumeErr = String(e); }),
        new Promise(r => setTimeout(() => { resumeErr = "resume() did not settle in 5s"; r(null); }, 5000)),
      ]);
      resumeMs = +(performance.now() - r0).toFixed(1);
    }
    const ctxStateAfterResume = ctx.state;
    // Does the clock actually ADVANCE? A frozen clock is the difference
    // between "scheduled" and "heard".
    const clockT0 = ctx.currentTime;
    await new Promise(r => setTimeout(r, 300));
    const clockAdvancedBy = +(ctx.currentTime - clockT0).toFixed(4);
    const gain = ctx.createGain();
    gain.gain.value = 1;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    gain.connect(analyser);
    analyser.connect(ctx.destination);

    const sink = new AudioBufferSink(at);
    if (mode === "playback-primed") {
      void sink.getBuffer(0).catch(() => {});
    }

    // Analyser poll = "is anything actually audible on the graph".
    const probe = new Float32Array(analyser.fftSize);
    let renderedPeak = 0;
    const poll = setInterval(() => {
      analyser.getFloatTimeDomainData(probe);
      for (let i = 0; i < probe.length; i++) {
        const v = Math.abs(probe[i]);
        if (v > renderedPeak) renderedPeak = v;
      }
    }, 25);

    let anchored = false;
    let startMediaTime = 0, startContextTime = 0;
    let started = 0, dropped = 0, scheduled = 0;
    const events: Json[] = [];
    const t0 = performance.now();
    let firstBufferMs = -1;
    let loopErr: string | null = null;
    let bailedOnWallClock = false;
    try {
      for await (const w of sink.buffers(0, dur)) {
        if (performance.now() - t0 > 25_000) { bailedOnWallClock = true; break; }
        if (firstBufferMs < 0) firstBufferMs = +(performance.now() - t0).toFixed(1);
        if (!anchored) {
          startMediaTime = Math.max(0, w.timestamp);
          startContextTime = ctx.currentTime;
          anchored = true;
        }
        const targetCtxTime = startContextTime + (w.timestamp - startMediaTime);
        const src = ctx.createBufferSource();
        src.buffer = w.buffer;
        src.connect(gain);
        let didStart = false;
        if (targetCtxTime <= ctx.currentTime) {
          const offset = ctx.currentTime - targetCtxTime;
          if (offset < w.buffer.duration) { src.start(0, offset); didStart = true; }
        } else { src.start(targetCtxTime); didStart = true; }
        if (didStart) { started++; scheduled++; src.onended = () => { scheduled--; }; }
        else {
          dropped++;
          if (events.length < 10) events.push({ droppedTs: +w.timestamp.toFixed(4), targetCtxTime: +targetCtxTime.toFixed(4), now: +ctx.currentTime.toFixed(4) });
        }
        const ahead = targetCtxTime + w.buffer.duration - ctx.currentTime;
        if (ahead > 3.0) await new Promise(r => setTimeout(r, (ahead - 2.0) * 1000));
      }
    } catch (e) { loopErr = String(e); }

    // Let the graph actually play out so the analyser sees real output.
    await new Promise(r => setTimeout(r, Math.min(3000, dur * 1000 + 400)));
    clearInterval(poll);
    const out = {
      ctxStateBefore, ctxTimeBefore, resumeMs, resumeErr,
      ctxStateAfterResume, clockAdvancedInA300msWallWindow: clockAdvancedBy,
      contextState: ctx.state, contextSampleRate: ctx.sampleRate,
      firstBufferMs, startedNodes: started, droppedNodes: dropped,
      bailedOnWallClock,
      renderedPeakAmplitude: +renderedPeak.toFixed(6),
      audible: renderedPeak > 1e-4,
      loopError: loopErr, dropExamples: events, spy,
    };
    await ctx.close().catch(() => {});
    await input.dispose();
    return out;
  }

  // ── The scrub-blip shape for real: a SECOND, CONCURRENT buffers()
  //    iteration on the SAME sink while the playback iteration is live.
  //    (`interleave` only tests a sequential getBuffer; the shipped scrub
  //    pump runs its own sink.buffers(t, t+0.08) loop in parallel.) ──
  if (mode === "concurrent") {
    const { input, at, dur } = await openInput();
    if (!at) throw new Error("no audio track");
    const sink = new AudioBufferSink(at);

    const blips: Json[] = [];
    let blipsRunning = true;
    // Fire a blip every 40ms at a wandering target, exactly like a drag.
    const blipLoop = (async () => {
      let n = 0;
      while (blipsRunning && n < 60) {
        const target = (n * 0.17) % Math.max(0.1, dur - 0.2);
        const got: number[] = [];
        let err: string | null = null;
        try {
          for await (const w of sink.buffers(target, target + 0.08)) got.push(+w.timestamp.toFixed(4));
        } catch (e) { err = String(e); }
        blips.push({ n, target: +target.toFixed(3), chunks: got.length, err });
        n++;
        await new Promise(r => setTimeout(r, 40));
      }
    })();

    const main = await drain(sink, 0, dur, { paceMs: 20 });
    blipsRunning = false;
    await blipLoop;
    await input.dispose();
    const blipErrs = blips.filter(b => b.err);
    const blipEmpty = blips.filter(b => (b.chunks as number) === 0);
    return {
      drain: main,
      blipCount: blips.length,
      blipErrors: blipErrs.length,
      blipEmpty: blipEmpty.length,
      blipFirstErrors: blipErrs.slice(0, 5),
      blipSample: blips.slice(0, 5),
      spy,
    };
  }

  // ── AudioContext running at a rate that does NOT match the 48kHz buffers ──
  if (mode === "rate-mismatch") {
    const { input, at, dur } = await openInput();
    if (!at) throw new Error("no audio track");
    const ctx = new AudioContext({ sampleRate: 44100 });
    if (ctx.state === "suspended") await Promise.race([ctx.resume().catch(() => {}), new Promise(r => setTimeout(r, 3000))]);
    const gain = ctx.createGain();
    const analyser = ctx.createAnalyser();
    gain.connect(analyser); analyser.connect(ctx.destination);
    const sink = new AudioBufferSink(at);
    const probe = new Float32Array(analyser.fftSize);
    let renderedPeak = 0;
    const poll = setInterval(() => {
      analyser.getFloatTimeDomainData(probe);
      for (let i = 0; i < probe.length; i++) if (Math.abs(probe[i]) > renderedPeak) renderedPeak = Math.abs(probe[i]);
    }, 25);
    let anchored = false, sm = 0, sc = 0, started = 0, dropped = 0;
    for await (const w of sink.buffers(0, dur)) {
      if (!anchored) { sm = Math.max(0, w.timestamp); sc = ctx.currentTime; anchored = true; }
      const target = sc + (w.timestamp - sm);
      const src = ctx.createBufferSource();
      src.buffer = w.buffer; src.connect(gain);
      if (target <= ctx.currentTime) {
        const off = ctx.currentTime - target;
        if (off < w.buffer.duration) { src.start(0, off); started++; } else dropped++;
      } else { src.start(target); started++; }
      const ahead = target + w.buffer.duration - ctx.currentTime;
      if (ahead > 3.0) await new Promise(r => setTimeout(r, (ahead - 2.0) * 1000));
    }
    await new Promise(r => setTimeout(r, Math.min(3000, dur * 1000 + 400)));
    clearInterval(poll);
    const out = {
      contextSampleRate: ctx.sampleRate, bufferSampleRate: 48000,
      startedNodes: started, droppedNodes: dropped,
      renderedPeakAmplitude: +renderedPeak.toFixed(6), audible: renderedPeak > 1e-4, spy,
    };
    await ctx.close().catch(() => {});
    await input.dispose();
    return out;
  }

  // ── The full player: runAudioLoop + runVideoLoop racing for the anchor,
  //    real AV1 decode load, real AudioContext, real av-clock.ts rules.
  //    `?prime=0` disables the shipped getBuffer(0) warm-up. ──
  if (mode === "race") {
    const doPrime = params.get("prime") !== "0";
    const { input, vt, at, dur } = await openInput();
    if (!at || !vt) throw new Error("need both tracks");

    const ctx = new AudioContext();
    if (ctx.state === "suspended") {
      await Promise.race([ctx.resume().catch(() => {}), new Promise(r => setTimeout(r, 4000))]);
    }
    const gain = ctx.createGain();
    const analyser = ctx.createAnalyser();
    gain.connect(analyser); analyser.connect(ctx.destination);
    const probe = new Float32Array(analyser.fftSize);
    let renderedPeak = 0;
    const poll = setInterval(() => {
      analyser.getFloatTimeDomainData(probe);
      for (let i = 0; i < probe.length; i++) if (Math.abs(probe[i]) > renderedPeak) renderedPeak = Math.abs(probe[i]);
    }, 25);

    // `prefer-hardware` is what the app asks for; headless Chromium has no
    // hardware AV1 and hard-fails configure(), so it is opt-in here.
    const videoSink = new CanvasSink(vt, params.get("hw") === "1"
      ? { poolSize: 4, decoderOptions: { hardwareAcceleration: "prefer-hardware", optimizeForLatency: true } }
      : { poolSize: 4, decoderOptions: { optimizeForLatency: true } });
    const audioSink = new AudioBufferSink(at);

    // Mirrors the player's refs.
    let anchored = false, startMediaTime = 0, startContextTime = 0;
    let audioDelivered = false, audioWarm = false;
    let scheduledCount = 0;
    const anchorClock = (t: number) => { startMediaTime = t; startContextTime = ctx.currentTime; anchored = true; };

    // Shipped warm-up: paint the first frame, then fire-and-forget getBuffer(0).
    const firstCanvas = await videoSink.getCanvas(0);
    let primeMs = -1;
    if (doPrime) {
      const p0 = performance.now();
      void audioSink.getBuffer(0)
        .then(() => { audioWarm = true; primeMs = +(performance.now() - p0).toFixed(1); })
        .catch(() => {});
    }

    const t0 = performance.now();
    let audioStarted = 0, audioDropped = 0, framesDrawn = 0;
    let whoAnchored = "nobody";
    let audioFirstMs = -1, videoFirstMs = -1;
    const audioErr: string[] = [];
    const dropExamples: Json[] = [];

    const runAudio = (async () => {
      try {
        for await (const w of audioSink.buffers(0, dur)) {
          if (audioFirstMs < 0) audioFirstMs = +(performance.now() - t0).toFixed(1);
          const firstOfGeneration = !audioDelivered;
          audioDelivered = true; audioWarm = true;
          if (!anchored) { anchorClock(Math.max(0, w.timestamp)); whoAnchored = "audio"; }
          else if (shouldRetakeAnchor({
            firstOfGeneration, scheduledCount,
            wouldLandAt: startContextTime + (w.timestamp - startMediaTime),
            chunkDuration: w.buffer.duration, now: ctx.currentTime,
          })) { anchorClock(Math.max(0, w.timestamp)); whoAnchored += "+audio-retake"; }

          const target = startContextTime + (w.timestamp - startMediaTime);
          const src = ctx.createBufferSource();
          src.buffer = w.buffer; src.connect(gain);
          let didStart = false;
          if (target <= ctx.currentTime) {
            const off = ctx.currentTime - target;
            if (off < w.buffer.duration) { src.start(0, off); didStart = true; }
          } else { src.start(target); didStart = true; }
          if (didStart) { audioStarted++; scheduledCount++; src.onended = () => { scheduledCount--; }; }
          else {
            audioDropped++;
            if (dropExamples.length < 8) dropExamples.push({ ts: +w.timestamp.toFixed(4), target: +target.toFixed(4), now: +ctx.currentTime.toFixed(4) });
          }
          const ahead = target + w.buffer.duration - ctx.currentTime;
          if (ahead > 3.0) await new Promise(r => setTimeout(r, (ahead - 2.0) * 1000));
        }
      } catch (e) { audioErr.push(String(e)); }
    })();

    const runVideo = (async () => {
      const audioLeads = true;
      for await (const wrapped of videoSink.canvases(0, dur)) {
        if (videoFirstMs < 0) videoFirstMs = +(performance.now() - t0).toFixed(1);
        if (!anchored) {
          if (audioLeads) {
            const deadline = performance.now() + audioAnchorWaitMs(audioWarm);
            while (!anchored && performance.now() < deadline) await new Promise(r => setTimeout(r, 10));
          }
          if (!anchored) { anchorClock(Math.max(0, wrapped.timestamp)); whoAnchored = "video"; }
        }
        const target = startContextTime + (wrapped.timestamp - startMediaTime);
        const waitMs = (target - ctx.currentTime) * 1000;
        if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
        framesDrawn++;
      }
    })();

    // `?blip=1` fires the shipped scrub-blip shape (its own buffers()
    // iteration on the SAME sink + its own envelope on the master gain)
    // WHILE playback is live — failed-fix-attempt #2, measured.
    let blipsFired = 0, blipErrors = 0;
    const blipTask = params.get("blip") === "1" ? (async () => {
      let live = true;
      setTimeout(() => { live = false; }, 6000);
      let n = 0;
      while (live && n < 80) {
        const target = (n * 0.13) % Math.max(0.1, dur - 0.2);
        const env = ctx.createGain();
        env.connect(gain);
        const start = ctx.currentTime + 0.005;
        env.gain.setValueAtTime(0, start);
        env.gain.linearRampToValueAtTime(1, start + 0.005);
        env.gain.setValueAtTime(1, start + 0.075);
        env.gain.linearRampToValueAtTime(0, start + 0.08);
        try {
          for await (const w of audioSink.buffers(target, target + 0.08)) {
            const off = Math.max(0, target - w.timestamp);
            if (off >= w.buffer.duration) continue;
            const s = ctx.createBufferSource();
            s.buffer = w.buffer; s.connect(env);
            s.start(start + Math.max(0, w.timestamp - target), off);
          }
          blipsFired++;
        } catch { blipErrors++; }
        n++;
        await new Promise(r => setTimeout(r, 60));
      }
    })() : Promise.resolve();

    await Promise.all([runAudio, runVideo, blipTask]);
    await new Promise(r => setTimeout(r, 400));
    clearInterval(poll);
    const out = {
      primed: doPrime, primeResolvedMs: primeMs, firstFramePainted: !!firstCanvas,
      contextState: ctx.state,
      whoAnchored, audioFirstBufferMs: audioFirstMs, videoFirstFrameMs: videoFirstMs,
      audioStarted, audioDropped, framesDrawn,
      renderedPeakAmplitude: +renderedPeak.toFixed(6), audible: renderedPeak > 1e-4,
      blipsFired, blipErrors,
      audioErrors: audioErr, dropExamples, spy,
    };
    await ctx.close().catch(() => {});
    await input.dispose();
    return out;
  }

  throw new Error(`unknown mode ${mode}`);
}

run()
  .then((r) => {
    (window as unknown as Json).__RESULT__ = { mode, ok: true, ...r };
    document.getElementById("out")!.textContent = JSON.stringify(r, null, 2);
  })
  .catch((e) => {
    (window as unknown as Json).__RESULT__ = {
      mode, ok: false, error: e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : String(e), spy,
    };
    document.getElementById("out")!.textContent = "ERROR " + String(e);
  });
