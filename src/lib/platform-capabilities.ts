// What this WebView can actually do — probed once at startup, before anything
// is registered that depends on it.
//
// Why this exists (r150). The app registered a WASM Opus decoder and a WASM
// ProRes decoder unconditionally, on the reasonable-sounding basis that
// WKWebView cannot decode those codecs natively. Two things were wrong with
// that, and together they produced a bug that survived two fixes and three
// reports:
//
//   1. The shipped Content-Security-Policy omitted 'wasm-unsafe-eval', so
//      WKWebView REFUSED WebAssembly instantiation in the packaged app. It was
//      never refused in `tauri dev`, which loads over plain http with no CSP
//      at all — so the failure existed only in the .dmg.
//   2. The decoder's bootstrap promise resolves or hangs; it never rejects.
//      So a blocked instantiate did not throw, it PARKED. mediabunny queued
//      every decode behind that pending init, the audio loop awaited a
//      generator that never yielded, and the file played with a perfect
//      picture and no sound. No error, anywhere, on any layer.
//
// The CSP is fixed. This module is the belt to that braces: capability is
// MEASURED rather than assumed, so if a future policy, platform, or packaging
// change takes WebAssembly away again, the app degrades to the native decoder
// (or to the ffmpeg path) instead of hanging, and says so in the log.

export type PlatformCapabilities = {
  /** WebAssembly can be INSTANTIATED (not merely compiled — see below). */
  wasm: boolean;
  /** A Worker can be created from a blob: URL (mediabunny's decoders do this). */
  blobWorker: boolean;
  /** The platform's own WebCodecs can decode Opus, making our polyfill moot. */
  nativeOpus: boolean;
  /** Why wasm/blobWorker failed, for the log line. Empty when all is well. */
  detail: string;
};

/**
 * The smallest valid WebAssembly module: the 8-byte header alone. Enough to
 * ask the engine whether instantiation is permitted.
 */
const EMPTY_WASM = Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00);

/**
 * CRITICAL: this must INSTANTIATE, not compile.
 *
 * Under the blocking CSP, `WebAssembly.compile()` and `new WebAssembly.Module()`
 * both SUCCEED — WebKit enforces the policy at instance creation. A probe built
 * on compile reports a cheerful `wasm: true` on precisely the broken
 * configuration, which is worse than no probe at all.
 */
function probeWasm(): { ok: boolean; detail: string } {
  try {
    new WebAssembly.Instance(new WebAssembly.Module(EMPTY_WASM));
    return { ok: true, detail: "" };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

function probeBlobWorker(): { ok: boolean; detail: string } {
  let url: string | null = null;
  try {
    url = URL.createObjectURL(new Blob(["self.close()"], { type: "text/javascript" }));
    const w = new Worker(url);
    w.terminate();
    return { ok: true, detail: "" };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

/** Synchronous half — everything registration decisions depend on. */
let sync: Omit<PlatformCapabilities, "nativeOpus"> | null = null;

export function platformSupports(): Omit<PlatformCapabilities, "nativeOpus"> {
  if (sync) return sync;
  const wasm = probeWasm();
  const worker = probeBlobWorker();
  const notes = [
    wasm.ok ? "" : `WebAssembly blocked: ${wasm.detail}`,
    worker.ok ? "" : `blob: Worker blocked: ${worker.detail}`,
  ].filter(Boolean);
  sync = { wasm: wasm.ok, blobWorker: worker.ok, detail: notes.join(" | ") };
  return sync;
}

/**
 * Full picture including the async native-codec probe. Used for the startup
 * log line; never blocks registration (that reads `platformSupports()`).
 */
export async function probePlatformCapabilities(): Promise<PlatformCapabilities> {
  const base = platformSupports();
  let nativeOpus = false;
  try {
    const AD = (globalThis as { AudioDecoder?: { isConfigSupported(c: unknown): Promise<{ supported?: boolean }> } }).AudioDecoder;
    if (AD) {
      const res = await AD.isConfigSupported({ codec: "opus", sampleRate: 48000, numberOfChannels: 2 });
      nativeOpus = !!res?.supported;
    }
  } catch { /* no AudioDecoder, or it rejected: treat as unsupported */ }
  return { ...base, nativeOpus };
}

/** One line for the Pipeline log. The whole silent-audio investigation would
 *  have been a single glance at this. */
export function capabilitySummary(c: PlatformCapabilities): string {
  return `Platform: wasm=${c.wasm} blobWorker=${c.blobWorker} nativeOpus=${c.nativeOpus}`
    + (c.detail ? `. ${c.detail}` : "");
}
