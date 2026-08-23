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
 * CRITICAL: this must do BOTH steps, compile and instantiate.
 *
 * Which one a blocking CSP rejects is engine-specific, so the probe must not
 * bet on either. Measured in Chromium against a `default-src 'self'` policy,
 * `new WebAssembly.Module()` itself throws CompileError — the opposite of what
 * this comment used to assert about WebKit, and unverifiable here either way
 * because the app's real engine is WKWebView. Doing both in one expression
 * makes the question moot: a throw from either step is caught, so the probe is
 * right on every engine rather than on the one we guessed about.
 */
function probeWasm(): { ok: boolean; detail: string } {
  try {
    new WebAssembly.Instance(new WebAssembly.Module(EMPTY_WASM));
    return { ok: true, detail: "" };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * OPTIMISTIC, and it cannot be otherwise.
 *
 * A CSP-blocked blob: Worker does NOT throw from the constructor. Measured:
 * under `default-src 'self'` the console logs "Creating a worker from
 * 'blob:...' violates the following CSP", the constructor returns a Worker
 * object anyway, and the failure arrives later as an `error` event with no
 * message. So this function - which constructs, terminates and returns in one
 * synchronous breath - reports `ok: true` on exactly the configuration the
 * module exists to detect.
 *
 * That is the same shape as the bug in this file's header: the failure did not
 * throw, it arrived late or not at all. Registration decisions need a
 * synchronous answer, so the optimistic one stays here; `confirmBlobWorker`
 * below is the async half that can actually see a rejection, and
 * `probePlatformCapabilities` uses it to correct this cache.
 */
function probeBlobWorkerSync(): { ok: boolean; detail: string } {
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

/**
 * The half that can observe a rejection: wait for the worker to speak or fail.
 *
 * Only ever corrects a false POSITIVE, and only on positive evidence. A
 * timeout resolves `ok: true`, because the sync probe already said so and
 * disabling a working decoder because a loaded machine was slow would trade
 * this bug for a worse one. Nothing here can introduce a false negative.
 */
async function confirmBlobWorker(timeoutMs = 1000): Promise<{ ok: boolean; detail: string }> {
  if (typeof Worker === "undefined" || typeof URL.createObjectURL !== "function") {
    return { ok: false, detail: "no Worker or createObjectURL" };
  }
  let url: string | null = null;
  let w: Worker | null = null;
  try {
    url = URL.createObjectURL(new Blob(["postMessage(1)"], { type: "text/javascript" }));
    w = new Worker(url);
  } catch (e) {
    if (url) URL.revokeObjectURL(url);
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
  const worker = w;
  try {
    return await new Promise<{ ok: boolean; detail: string }>((resolve) => {
      const t = setTimeout(() => resolve({ ok: true, detail: "" }), timeoutMs);
      worker.onmessage = () => { clearTimeout(t); resolve({ ok: true, detail: "" }); };
      worker.onerror = (e: ErrorEvent) => {
        clearTimeout(t);
        // A CSP rejection arrives with an empty message, so name it ourselves
        // rather than logging a blank reason.
        resolve({ ok: false, detail: e?.message || "blocked before it could run (likely CSP)" });
      };
    });
  } finally {
    worker.terminate();
    if (url) URL.revokeObjectURL(url);
  }
}

/** Synchronous half — everything registration decisions depend on. */
let sync: Omit<PlatformCapabilities, "nativeOpus"> | null = null;

export function platformSupports(): Omit<PlatformCapabilities, "nativeOpus"> {
  if (sync) return sync;
  const wasm = probeWasm();
  const worker = probeBlobWorkerSync();
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
  // Correct the optimistic sync answer now that we can actually wait for a
  // rejection. This matters beyond the log line: mediabunny-export.ts reads
  // platformSupports() at EXPORT time, long after startup, so a corrected
  // cache makes that path degrade properly instead of parking. Startup
  // registration in main.tsx has already run on the optimistic value and
  // cannot be rescued from here - see docs/DECISIONS.md.
  const confirmed = await confirmBlobWorker();
  if (base.blobWorker && !confirmed.ok && sync) {
    sync = {
      ...sync,
      blobWorker: false,
      detail: [sync.detail, `blob: Worker blocked: ${confirmed.detail}`].filter(Boolean).join(" | "),
    };
  }
  const corrected = platformSupports();
  let nativeOpus = false;
  try {
    const AD = (globalThis as { AudioDecoder?: { isConfigSupported(c: unknown): Promise<{ supported?: boolean }> } }).AudioDecoder;
    if (AD) {
      const res = await AD.isConfigSupported({ codec: "opus", sampleRate: 48000, numberOfChannels: 2 });
      nativeOpus = !!res?.supported;
    }
  } catch { /* no AudioDecoder, or it rejected: treat as unsupported */ }
  return { ...corrected, nativeOpus };
}

/** One line for the Pipeline log. The whole silent-audio investigation would
 *  have been a single glance at this. */
export function capabilitySummary(c: PlatformCapabilities): string {
  return `Platform: wasm=${c.wasm} blobWorker=${c.blobWorker} nativeOpus=${c.nativeOpus}`
    + (c.detail ? `. ${c.detail}` : "");
}
