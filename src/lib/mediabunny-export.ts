import {
  Input, ALL_FORMATS,
  Output, Mp4OutputFormat, Mp3OutputFormat, BufferTarget,
  Conversion,
  type ConversionOptions,
} from "mediabunny";
import { mediabunnySource } from "./mediabunny-source";
import { platformSupports } from "./platform-capabilities";

export type LocalExportFormat = "video-mp4" | "audio-mp3";

export type LocalExportOptions = {
  /** Absolute path of the source file on disk. */
  inputPath: string;
  /** Trim start in seconds, or null for "from the beginning". */
  startSeconds: number | null;
  /** Trim end in seconds, or null for "to the end". */
  endSeconds: number | null;
  /**
   * Output kind. video-mp4 = full A+V passthrough (lossless) or WebCodecs
   * re-encode. audio-mp3 = audio-only via Mp3OutputFormat, whose encoder is
   * loaded on demand by `ensureMp3Encoder` below.
   */
  format: LocalExportFormat;
  /** Called repeatedly with progress 0..1 + the source time we've reached. */
  onProgress?: (progress: number, processedSeconds: number) => void;
};

export type LocalExportResult =
  | { kind: "ok"; bytes: Uint8Array; mimeType: string }
  | { kind: "cancelled" }
  | { kind: "unsupported"; reason: string }
  | { kind: "error"; message: string };

/**
 * Local-file clip export driven entirely by mediabunny — no ffmpeg
 * subprocess. Uses the high-level `Conversion` API which:
 *  • Demuxes the source container.
 *  • Passes compatible streams through as-is (stream copy → lossless cut,
 *    no decode-encode round trip).
 *  • Falls back to WebCodecs re-encode for stream pairs that can't be
 *    passed through (codec mismatch, container constraint, etc.).
 *  • Honours `trim.start`/`trim.end` for the [in, out] range.
 *  • Calls `onProgress` for the pipeline UI.
 *
 * Output is buffered in memory via `BufferTarget` then handed back as
 * raw bytes; caller writes to disk via `write_raw_to_path` (the bytes ARE
 * the IPC body — never the JSON number-array route, which decimal-prints
 * every byte and froze the UI ~2s per 100 MB). For very long clips (>1GB)
 * this would still benefit from a streaming target later.
 *
 * Returns a tagged result so the caller can branch:
 *  • "ok"          → write the bytes, done.
 *  • "cancelled"   → user hit Stop, suppress the error UI.
 *  • "unsupported" → fall back to the ffmpeg pipeline (e.g. WebCodecs
 *                    can't decode the source's codec, or no encoder is
 *                    available for the target container).
 *  • "error"       → real failure; surface it.
 */
/**
 * Load and register the LAME-via-WASM MP3 encoder, once, on first use.
 *
 * WHY IT IS NOT REGISTERED AT STARTUP ANY MORE. `@mediabunny/mp3-encoder`
 * inlines its WASM module as a base64 string inside a worker source: measured
 * in the built bundle, that is a 305,695-character literal wrapping a 297,380-
 * character blob, decoding to a 223 KB WASM module. It was roughly 15% of the
 * entire JS bundle, parsed on every single launch, for a format most sessions
 * never export. Nothing else in the app can pull it in, because
 * `Mp3OutputFormat` is constructed in exactly one place — the function below.
 *
 * THE CAPABILITY GATE IS NOT OPTIONAL (r150). Registering a WASM-backed
 * extension the platform cannot actually run does not fail loudly, it HANGS:
 * mediabunny queues work behind an init promise that never settles and the
 * feature goes silent with no error anywhere. That is exactly how a CSP
 * missing 'wasm-unsafe-eval' produced a perfect video with no audio in the
 * packaged app while `tauri dev` was fine. So the gate that used to live in
 * main.tsx moves here with the import, unchanged. When it fails we simply do
 * not register, and mediabunny's own "no encoder available" surfaces through
 * the existing `unsupported` path rather than hanging.
 */
let mp3EncoderReady: Promise<void> | null = null;
function ensureMp3Encoder(): Promise<void> {
  mp3EncoderReady ??= (async () => {
    const platform = platformSupports();
    if (!platform.wasm || !platform.blobWorker) return;
    const m = await import("@mediabunny/mp3-encoder");
    m.registerMp3Encoder();
  })();
  return mp3EncoderReady;
}

export async function exportLocalClipViaMediabunny(
  opts: LocalExportOptions,
  cancelToken: { cancelled: boolean } = { cancelled: false },
): Promise<LocalExportResult> {
  // Shared range-reader, not asset:// — see the note in waveform.ts: the asset
  // handler is synchronous on the main thread and caps responses at 1 MiB, so
  // reading a whole source through it fragments into a scheme task per MiB.
  // Before the Output is built, because registration is a global side effect
  // on mediabunny's encoder registry and Conversion resolves encoders when it
  // initialises.
  if (opts.format === "audio-mp3") await ensureMp3Encoder();

  const input = new Input({ source: mediabunnySource(opts.inputPath), formats: ALL_FORMATS });
  const target = new BufferTarget();
  // Output container picks based on requested format.
  const outputFormat = opts.format === "audio-mp3"
    ? new Mp3OutputFormat()
    : new Mp4OutputFormat({ fastStart: "in-memory" });
  const output = new Output({ format: outputFormat, target });

  const conversionOpts: ConversionOptions = {
    input,
    output,
    // Trim is the lossless-cut primitive. start defaults to track start,
    // end to track end — pass undefined for "open-ended" semantics.
    trim: (opts.startSeconds != null || opts.endSeconds != null)
      ? {
          start: opts.startSeconds ?? undefined,
          end:   opts.endSeconds ?? undefined,
        }
      : undefined,
    // For MP3 output: explicitly discard the video track. Without this,
    // Conversion.init() would mark the conversion invalid because
    // Mp3OutputFormat doesn't accept video tracks. discard=true tells
    // mediabunny "yes I know, just drop it" so isValid stays true.
    ...(opts.format === "audio-mp3"
      ? { video: { discard: true } as const }
      : {}),
  };

  let conversion: Conversion;
  try {
    conversion = await Conversion.init(conversionOpts);
  } catch (err) {
    void input.dispose();
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }

  // Hook progress reporting AFTER init so it's wired before execute().
  if (opts.onProgress) {
    conversion.onProgress = (p, t) => opts.onProgress?.(p, t);
  }

  // If the configured conversion is invalid (e.g. no compatible output
  // tracks because WebCodecs can't encode the source codec and there's
  // no passthrough path), bail to the ffmpeg fallback.
  if (!conversion.isValid) {
    const reasons = conversion.discardedTracks.map((d) => `${d.track.type}:${d.reason}`).join(", ");
    void input.dispose();
    return {
      kind: "unsupported",
      reason: `mediabunny can't produce a valid output: ${reasons || "unknown"}`,
    };
  }

  // Cancel-poll: mediabunny's cancel() is async and we want to support
  // the Stop button. Poll the token on a tight interval and forward.
  let pollId: number | null = null;
  const cancelWatcher = new Promise<void>((resolve) => {
    pollId = window.setInterval(() => {
      if (cancelToken.cancelled) {
        if (pollId != null) window.clearInterval(pollId);
        pollId = null;
        void conversion.cancel().finally(() => resolve());
      }
    }, 150);
  });
  void cancelWatcher; // run for side-effects; we don't await it

  try {
    await conversion.execute();
    if (pollId != null) window.clearInterval(pollId);
    if (cancelToken.cancelled) return { kind: "cancelled" };
    const bytes = target.buffer;
    if (!bytes) return { kind: "error", message: "BufferTarget produced no bytes" };
    return {
      kind: "ok",
      bytes: new Uint8Array(bytes),
      mimeType: opts.format === "audio-mp3" ? "audio/mpeg" : "video/mp4",
    };
  } catch (err) {
    if (pollId != null) window.clearInterval(pollId);
    // ConversionCanceledError is the explicit cancel signal.
    if (err && (err as Error).name === "ConversionCanceledError") {
      return { kind: "cancelled" };
    }
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  } finally {
    void input.dispose();
  }
}
