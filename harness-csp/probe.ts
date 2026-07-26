// Does the SHIPPED Tauri CSP (script-src 'self', no wasm-unsafe-eval) allow
// WebAssembly? And if not, how does opus-decoder fail?
import { OpusDecoder } from "opus-decoder";

type R = Record<string, unknown>;
const out: R = {};
const errs: string[] = [];
window.addEventListener("error", (e) => errs.push("window.error: " + e.message));
window.addEventListener("unhandledrejection", (e) =>
  errs.push("unhandledrejection: " + String((e as PromiseRejectionEvent).reason)));

// 1. tiny valid wasm module: (module)
const TINY = new Uint8Array([0x00,0x61,0x73,0x6d,0x01,0x00,0x00,0x00]);

out.cspMeta = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? null;

try {
  const m = new WebAssembly.Module(TINY);
  out.syncModule = "ok " + !!m;
} catch (e) { out.syncModule = "THREW: " + String(e); }

try {
  await WebAssembly.compile(TINY);
  out.asyncCompile = "ok";
} catch (e) { out.asyncCompile = "THREW: " + String(e); }

try {
  await WebAssembly.instantiate(TINY, {});
  out.asyncInstantiate = "ok";
} catch (e) { out.asyncInstantiate = "THREW: " + String(e); }

// 2. The real opus-decoder, exactly as src/lib/mediabunny-decoders.ts builds it.
const t0 = performance.now();
let settled = "HUNG";
const dec = new OpusDecoder({ channels: 2, preSkip: 312, streamCount: 1, coupledStreamCount: 1 });
await Promise.race([
  dec.ready.then(() => { settled = "resolved"; }, (e: unknown) => { settled = "rejected: " + String(e); }),
  new Promise((r) => setTimeout(r, 6000)),
]);
out.opusReady = settled;
out.opusReadyMs = Math.round(performance.now() - t0);
if (settled === "resolved") {
  // decode a silence frame to prove it works end to end
  try {
    const r = dec.decodeFrame(new Uint8Array([0xfc, 0xff, 0xfe]));
    out.opusDecodeSamples = r.samplesDecoded;
  } catch (e) { out.opusDecode = "THREW: " + String(e); }
}
out.errors = errs;
(window as unknown as { __RESULT__: R }).__RESULT__ = out;
document.getElementById("out")!.textContent = JSON.stringify(out, null, 2);
