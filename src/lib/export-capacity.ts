/**
 * Whether the in-memory export target can hold this job, and how to react
 * when it turns out it could not.
 *
 * `mediabunny-export` builds its output in a `BufferTarget`, and mediabunny
 * caps that at `2 ** 32` bytes — a hard ArrayBuffer limit, not a soft one.
 * Past it the Conversion throws "ArrayBuffer exceeded maximum size of
 * 4294967296 bytes", which the export used to hand back as `kind: "error"`.
 * The user saw that sentence, verbatim, after waiting through the conversion.
 *
 * What makes that the wrong answer is that the app already has a pipeline
 * which handles the job perfectly: the ffmpeg fallback, which streams and has
 * no such ceiling and is doing a lossless stream copy anyway. The size ceiling
 * is a reason to use the OTHER path, exactly like a codec WebCodecs cannot
 * decode — so it belongs on the `unsupported` branch, not the error one.
 *
 * A streaming target would remove the ceiling altogether, and that stays the
 * better long-term answer; it needs an incremental write command on the Rust
 * side and changes the MP4 `fastStart` bargain, so it is its own piece of work
 * rather than a bug fix.
 */

/** mediabunny's BufferTarget ceiling, from its own `ARRAY_BUFFER_MAX_SIZE`. */
export const BUFFER_TARGET_MAX_BYTES = 2 ** 32;

/**
 * Leave room for container overhead and the growth doubling BufferTarget does
 * on its way up — it fails when the NEXT doubling would cross the cap, not on
 * the byte that crosses it.
 */
const HEADROOM = 0.9;

/** Does this look like the buffer ceiling rather than a real failure? */
export function isBufferCeilingError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /ArrayBuffer exceeded maximum size/i.test(msg)
    // Chromium/WebKit phrase an allocation failure differently when the
    // machine simply cannot back the buffer; same practical meaning here.
    || /Array buffer allocation failed/i.test(msg)
    || /Invalid (array buffer|typed array) length/i.test(msg);
}

/**
 * Predict, before converting, whether the output will not fit.
 *
 * Worth doing because the catch path only fires after the whole conversion has
 * run: on a long ProRes clip that is minutes of work discarded. A lossless cut
 * copies its streams, so output size tracks the trimmed fraction of the input
 * closely enough to decide which pipeline to use.
 *
 * Returns false whenever it cannot tell — a wrong "too big" would push work to
 * ffmpeg that mediabunny does faster, and the catch is there to cover a miss.
 */
export function willExceedBufferTarget(args: {
  inputBytes: number;
  durationSeconds: number | null;
  startSeconds: number | null;
  endSeconds: number | null;
}): boolean {
  const { inputBytes, durationSeconds } = args;
  if (!(inputBytes > 0)) return false;
  // Without a duration the trimmed fraction is unknowable, and assuming the
  // whole file would send a 30-second cut off a 6 GB source to ffmpeg — which
  // works, but throws away the ~3x mediabunny is faster on ProRes. Declining
  // to guess is the cheaper mistake: the catch still routes a real overflow.
  if (!durationSeconds || durationSeconds <= 0) return false;
  const start = args.startSeconds ?? 0;
  const end = args.endSeconds ?? durationSeconds;
  const span = end - start;
  const fraction = span > 0 ? Math.min(1, span / durationSeconds) : 1;
  return inputBytes * fraction > BUFFER_TARGET_MAX_BYTES * HEADROOM;
}
