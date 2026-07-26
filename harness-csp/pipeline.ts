// End-to-end: the REAL app registration + the REAL sinks over the REAL file,
// under the shipped CSP. Answers: does runAudioLoop's iterator yield / throw /
// hang, and does the video loop keep working?
import { Input, ALL_FORMATS, UrlSource, AudioBufferSink, CanvasSink } from "mediabunny";
import { registerLocalDecoders } from "../src/lib/mediabunny-decoders";

type R = Record<string, unknown>;
const out: R = {};
const unhandled: string[] = [];
window.addEventListener("unhandledrejection", (e) =>
  unhandled.push(String((e as PromiseRejectionEvent).reason).slice(0, 160)));

out.hasNativeAudioDecoder = typeof (globalThis as { AudioDecoder?: unknown }).AudioDecoder !== "undefined";
try {
  const AD = (globalThis as { AudioDecoder?: { isConfigSupported(c: unknown): Promise<{supported:boolean}> } }).AudioDecoder;
  out.nativeOpusSupported = AD ? (await AD.isConfigSupported({ codec: "opus", sampleRate: 48000, numberOfChannels: 2 })).supported : null;
} catch (e) { out.nativeOpusSupported = "THREW " + String(e); }

// The real app startup call (registers OpusAudioDecoder + ProRes).
let regErr: string | null = null;
try { registerLocalDecoders(); } catch (e) { regErr = String(e); }
out.registerLocalDecodersError = regErr;

const input = new Input({ source: new UrlSource("/harness-csp/sample.mp4"), formats: ALL_FORMATS });
const [vt, at, dur] = await Promise.all([
  input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack(), input.computeDuration(),
]);
out.audioTrackPresent = !!at;              // hypothesis 1
out.audioCodec = at ? await at.getCodec() : null;
out.audioCanDecode = at ? await at.canDecode() : null;
out.videoCodec = vt ? await vt.getCodec() : null;
out.duration = dur;

// ── VIDEO: does the picture path still work? (AV1 → native WebCodecs, no WASM)
if (vt) {
  const cs = new CanvasSink(vt, { poolSize: 4 });
  const t0 = performance.now();
  let frames = 0, verr: string | null = null;
  try {
    for await (const w of cs.canvases(0, dur)) { frames++; if (frames >= 12) break; void w; }
  } catch (e) { verr = String(e); }
  out.videoFrames = frames;
  out.videoFirstMs = Math.round(performance.now() - t0);
  out.videoError = verr;
}

// ── AUDIO: exactly what MediaBunnyPlayer does.
if (at) {
  const sink = new AudioBufferSink(at);
  // 1. the mount-effect priming call
  const p0 = performance.now();
  let prime = "HUNG";
  await Promise.race([
    sink.getBuffer(0).then((b) => { prime = b ? "buffer" : "null"; }, (e) => { prime = "rejected: " + String(e).slice(0,120); }),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
  out.primeGetBuffer = prime;
  out.primeMs = Math.round(performance.now() - p0);

  // 2. runAudioLoop's iterator
  const t0 = performance.now();
  let delivered = 0, loopErr: string | null = null, completed = false, peak = 0;
  const loop = (async () => {
    try {
      for await (const w of sink.buffers(0, dur)) {
        delivered++;
        const d = w.buffer.getChannelData(0);
        for (let i = 0; i < d.length; i += 32) peak = Math.max(peak, Math.abs(d[i]));
        if (delivered >= 40) break;
      }
      completed = true;
    } catch (e) { loopErr = String(e).slice(0, 200); }
  })();
  await Promise.race([loop, new Promise((r) => setTimeout(r, 8000))]);
  out.audioBuffersDelivered = delivered;   // hypothesis 2
  out.audioLoopCompleted = completed;
  out.audioLoopError = loopErr;            // did anything surface?
  out.audioLoopMs = Math.round(performance.now() - t0);
  out.audioPeak = +peak.toFixed(4);
  out.audioLoopVerdict = (!completed && !loopErr && delivered === 0) ? "SILENT HANG" : "other";
}
out.unhandledRejections = unhandled;
(window as unknown as { __RESULT__: R }).__RESULT__ = out;
document.getElementById("out")!.textContent = JSON.stringify(out, null, 2);
