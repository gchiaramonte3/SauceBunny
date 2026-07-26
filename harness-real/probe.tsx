/**
 * Mounts the REAL src/components/MediaBunnyPlayer.tsx against the REAL
 * src/lib/mediabunny-source.ts CustomSource (Tauri `read_file_range` shimmed
 * to HTTP range reads) and the REAL registerLocalDecoders(), then drives
 * play() and measures what the Web Audio graph actually receives.
 *
 * Harness only — nothing here is app code.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { registerLocalDecoders } from "../src/lib/mediabunny-decoders";
import { MediaBunnyPlayer } from "../src/components/MediaBunnyPlayer";
import type { PlayerHandle } from "../src/components/player-handle";
import { extractWaveformPeaks } from "../src/lib/waveform";
import { extractFilmstrip, canMediabunnyDecode } from "../src/lib/mediabunny-helpers";

type Json = Record<string, unknown>;
const params = new URLSearchParams(location.search);
const SRC = params.get("src") ?? "/harness-real/sample.mp4";
const SEEK_FIRST = params.get("seek") === "1";
const SCRUB_AUDIO = params.get("scrubAudio") !== "0";
const VOLUME = Number(params.get("volume") ?? "1");

// ── Tauri IPC shim: get_file_size / read_file_range over HTTP Range ──
let fileSize = 0;
(globalThis as unknown as Json).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: Json) => {
    if (cmd === "get_file_size") {
      if (!fileSize) {
        const h = await fetch(SRC, { method: "HEAD" });
        fileSize = Number(h.headers.get("content-length"));
      }
      return fileSize;
    }
    if (cmd === "read_file_range") {
      const offset = Number(args.offset);
      const length = Number(args.length);
      const r = await fetch(SRC, {
        headers: { Range: `bytes=${offset}-${offset + length - 1}` },
      });
      return await r.arrayBuffer();
    }
    return null;
  },
  transformCallback: (cb: unknown) => cb,
  unregisterCallback: () => {},
  convertFileSrc: (p: string) => p,
};

registerLocalDecoders();

// ── Instrumentation ────────────────────────────────────────────────────
const ctxEvents: Json[] = [];
const startCalls: Json[] = [];
const createdSources: { started: boolean; peak: number; dur: number }[] = [];
const gainWrites: Json[] = [];
let analyser: AnalyserNode | null = null;
let liveCtx: AudioContext | null = null;
let stoppedNodes = 0;
let disconnects = 0;

const peakOf = (b: AudioBuffer | null) => {
  if (!b) return 0;
  let p = 0;
  for (let c = 0; c < b.numberOfChannels; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < d.length; i += 7) { const v = Math.abs(d[i]); if (v > p) p = v; }
  }
  return p;
};

const NativeAC = globalThis.AudioContext;
class SpyAudioContext extends NativeAC {
  constructor(o?: AudioContextOptions) {
    super(o);
    liveCtx = this as unknown as AudioContext;
    ctxEvents.push({ at: "ctor", state: this.state, sampleRate: this.sampleRate });
    this.addEventListener("statechange", () => {
      ctxEvents.push({ at: "statechange", state: this.state, t: +this.currentTime.toFixed(4) });
    });
  }
  createBufferSource() {
    const node = super.createBufferSource();
    const rec = { started: false, peak: 0, dur: 0 };
    createdSources.push(rec);
    const origStart = node.start.bind(node);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (node as any).start = (when?: number, off?: number, d?: number) => {
      rec.started = true;
      rec.peak = peakOf(node.buffer);
      rec.dur = node.buffer?.duration ?? 0;
      if (startCalls.length < 2000) {
        startCalls.push({
          when: when === undefined ? null : +when.toFixed(5),
          off: off === undefined ? null : +off.toFixed(5),
          now: +this.currentTime.toFixed(5),
          bufDur: +(node.buffer?.duration ?? 0).toFixed(5),
          bufSr: node.buffer?.sampleRate ?? 0,
          peak: +rec.peak.toFixed(5),
        });
      }
      return origStart(when as number, off as number, d as number);
    };
    const origStop = node.stop.bind(node);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (node as any).stop = (when?: number) => { stoppedNodes++; return origStop(when as number); };
    const origDisc = node.disconnect.bind(node);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (node as any).disconnect = (...a: unknown[]) => { disconnects++; return (origDisc as never as (...x: unknown[]) => void)(...a); };
    return node;
  }
  createGain() {
    const g = super.createGain();
    gainWrites.push({ at: "createGain", value: g.gain.value, t: +this.currentTime.toFixed(4) });
    return g;
  }
}
// @ts-expect-error test double
globalThis.AudioContext = SpyAudioContext;

// Tap everything that connects to the destination through an analyser.
const origConnect = AudioNode.prototype.connect;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(AudioNode.prototype as any).connect = function (dest: unknown, ...rest: unknown[]) {
  if (dest instanceof AudioDestinationNode) {
    const ctx = dest.context as AudioContext;
    if (!analyser || analyser.context !== ctx) {
      analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      origConnect.call(analyser, dest);
    }
    return origConnect.call(this, analyser);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (origConnect as any).call(this, dest, ...rest);
};

// ── Drive the real component ───────────────────────────────────────────
const events: Json[] = [];
const times: number[] = [];
let readyDur = 0;
let ready = false;
const errors: string[] = [];

const handleRef: { current: PlayerHandle | null } = { current: null };

function Harness() {
  return React.createElement(MediaBunnyPlayer, {
    ref: handleRef as never,
    path: "/fake/local/path.mp4",
    filename: "sample.mp4",
    hasVideo: true,
    initialVolume: VOLUME,
    scrubAudio: SCRUB_AUDIO,
    onReady: (d: number) => { readyDur = d; ready = true; events.push({ e: "ready", d }); },
    onError: (m: string) => { errors.push(m); events.push({ e: "error", m }); },
    onPlayStateChange: (p: boolean) => events.push({ e: "playState", p, t: performance.now() | 0 }),
    onTimeUpdate: (s: number) => { times.push(+s.toFixed(3)); },
  });
}

createRoot(document.getElementById("root")!).render(React.createElement(Harness));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const t0 = performance.now();
  while (!ready && performance.now() - t0 < 30_000) await sleep(50);
  const openMs = +(performance.now() - t0).toFixed(0);

  const probe = new Float32Array(2048);
  let renderedPeak = 0;
  const poll = setInterval(() => {
    if (!analyser) return;
    analyser.getFloatTimeDomainData(probe);
    for (let i = 0; i < probe.length; i++) {
      const v = Math.abs(probe[i]);
      if (v > renderedPeak) renderedPeak = v;
    }
  }, 20);

  // App-realistic concurrent load: the Clip timeline kicks off a filmstrip
  // decode and a full waveform drain on the same file as soon as duration is
  // known, and App re-probes decodability. All three open their own Input.
  const sideload: Json = {};
  if (params.get("load") === "1") {
    const p = "/fake/local/path.mp4";
    void canMediabunnyDecode(p).then((r) => { sideload.canDecode = r; });
    void extractFilmstrip(p, Array.from({ length: 24 }, (_, i) => (i * readyDur) / 24), { height: 176 })
      .then((s) => { sideload.filmstrip = s.length; })
      .catch((e) => { sideload.filmstripErr = String(e); });
    void extractWaveformPeaks(p)
      .then((w) => { sideload.waveform = w ? "ok" : "null"; })
      .catch((e) => { sideload.waveformErr = String(e); });
  }
  // App calls these the moment onReady fires.
  if (params.get("app") === "1") {
    try { handleRef.current?.setPlaybackRate(1); } catch { /* ignore */ }
    try {
      handleRef.current?.setVolume(VOLUME);
      handleRef.current?.setMuted(params.get("muted") === "1");
    } catch { /* ignore */ }
  }

  if (SEEK_FIRST) { handleRef.current?.seekTo(0.5); await sleep(400); }

  const ctxAtPlay = liveCtx ? { state: liveCtx.state, t: +liveCtx.currentTime.toFixed(4) } : null;
  const playerCtx = liveCtx;
  const wall0 = performance.now();
  handleRef.current?.play();
  // A UI chime (src/lib/sound.ts) builds a SECOND AudioContext mid-playback.
  if (params.get("chime") === "1") {
    await sleep(600);
    const m = await import("../src/lib/sound");
    m.playSuccess();
  }
  let peakBeforeChime = renderedPeak;
  let ctxAfterChime = playerCtx ? { state: playerCtx.state, t: +playerCtx.currentTime.toFixed(4) } : null;
  if (params.get("chime") === "1") {
    peakBeforeChime = renderedPeak;
    renderedPeak = 0;
    await sleep(400);
    ctxAfterChime = playerCtx ? { state: playerCtx.state, t: +playerCtx.currentTime.toFixed(4) } : null;
  }
  await sleep(3000);
  const ctxMid = liveCtx ? { state: liveCtx.state, t: +liveCtx.currentTime.toFixed(4) } : null;
  await sleep(3500);
  const wallMs = +(performance.now() - wall0).toFixed(0);
  clearInterval(poll);

  const started = createdSources.filter((s) => s.started);
  const nonSilentStarted = started.filter((s) => s.peak > 1e-5);
  (window as unknown as Json).__RESULT__ = {
    ok: true,
    openMs,
    readyDur: +readyDur.toFixed(3),
    errors,
    events: events.slice(0, 40),
    ctxEvents,
    ctxAtPlay,
    ctxMid,
    ctxEnd: liveCtx ? { state: liveCtx.state, t: +liveCtx.currentTime.toFixed(4), sr: liveCtx.sampleRate } : null,
    ctxClockAdvancedOverWall: liveCtx && ctxAtPlay ? +(liveCtx.currentTime - (ctxAtPlay.t as number)).toFixed(3) : null,
    wallMs,
    createdSourceNodes: createdSources.length,
    startedNodes: started.length,
    droppedNodes: createdSources.length - started.length,
    nonSilentStartedNodes: nonSilentStarted.length,
    stopCalls: stoppedNodes,
    disconnectCalls: disconnects,
    gainWrites,
    renderedPeakAmplitude: +renderedPeak.toFixed(6),
    audible: renderedPeak > 1e-4,
    firstStarts: startCalls.slice(0, 6),
    midStarts: startCalls.slice(100, 104),
    lastStarts: startCalls.slice(-3),
    timeUpdates: { n: times.length, first: times[0] ?? null, last: times.at(-1) ?? null },
    sideload,
    peakBeforeChime: +peakBeforeChime.toFixed(6),
    ctxAfterChime,
  };
  document.getElementById("out")!.textContent =
    JSON.stringify((window as unknown as Json).__RESULT__, null, 2);
})().catch((e) => {
  (window as unknown as Json).__RESULT__ = { ok: false, error: String(e), errors, events };
});
