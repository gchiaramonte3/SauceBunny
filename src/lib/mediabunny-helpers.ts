import { Input, ALL_FORMATS, CanvasSink } from "mediabunny";
import { mediabunnySource } from "./mediabunny-source";

/**
 * Opens a local file via mediabunny just long enough to grab one frame
 * at the requested timestamp, returns a Blob (default: JPEG @ 0.95). The
 * Input is disposed before resolving, so this is safe to call repeatedly
 * (no leaked decoders, no AudioContexts, no canvases retained).
 *
 * Returns `null` if:
 *  - WebCodecs can't decode the file's video codec on this platform
 *  - The file has no video track
 *  - The timestamp is past EOF and nothing decodes
 *
 * Caller is responsible for the ffmpeg fallback when `null` comes back.
 *
 * Typical wall-clock cost on M-series Macs for a 1080p h264 file:
 *  - first frame (t=0): ~20ms (sink warmup + decode)
 *  - mid-file frame:    ~80ms (must demux + decode a GOP up to the target)
 * Either way: cheaper than a `ffmpeg -ss -i path -frames:v 1` subprocess
 * spinup (~200ms minimum even for a single frame, often 400ms+ cold).
 */
export async function extractFrameAsBlob(
  localPath: string,
  atSeconds: number,
  opts?: { mimeType?: string; quality?: number; maxWidth?: number },
): Promise<Blob | null> {
  // No AudioContext / no playback wiring — just demux + one canvas.
  const input = new Input({ source: mediabunnySource(localPath), formats: ALL_FORMATS });
  try {
    const vt = await input.getPrimaryVideoTrack();
    if (!vt) return null;
    if (!(await vt.canDecode())) return null;
    const sink = new CanvasSink(vt, { poolSize: 1 });
    const wrapped = await sink.getCanvas(Math.max(0, atSeconds));
    if (!wrapped) return null;
    const mimeType = opts?.mimeType ?? "image/jpeg";
    const quality = opts?.quality ?? 0.95;
    return await canvasToBlob(wrapped.canvas, opts?.maxWidth, mimeType, quality);
  } catch {
    // Any decode/demux failure → null → ffmpeg fallback path takes over.
    return null;
  } finally {
    // Always release decoders + source streams, even on error.
    void input.dispose();
  }
}

/**
 * A frame grabber that HOLDS its Input + CanvasSink open across many grabs —
 * for callers that decode a burst of frames from one file (the thumbnail
 * picker's scrub preview). `extractFrameAsBlob` opens and disposes per call,
 * which is right for one-shots but brutal in a loop: every open re-requests
 * and re-parses the whole moov (cost scales with FILE length, this app's
 * content profile), re-runs canDecode's isConfigSupported round-trip, and
 * mints a fresh 64 MiB read cache that never gets to help the next call.
 *
 * `open` resolves null when the file has no decodable video track — same
 * contract as extractFrameAsBlob, caller keeps its fallback. Always call
 * `dispose()` when done; grabs after dispose resolve null.
 */
export type FrameGrabber = {
  grab: (atSeconds: number, opts?: { mimeType?: string; quality?: number; maxWidth?: number }) => Promise<Blob | null>;
  dispose: () => void;
};

export async function openFrameGrabber(localPath: string): Promise<FrameGrabber | null> {
  const input = new Input({ source: mediabunnySource(localPath), formats: ALL_FORMATS });
  try {
    const vt = await input.getPrimaryVideoTrack();
    if (!vt || !(await vt.canDecode())) {
      void input.dispose();
      return null;
    }
    const sink = new CanvasSink(vt, { poolSize: 1 });
    let disposed = false;
    return {
      async grab(atSeconds, opts) {
        if (disposed) return null;
        try {
          const wrapped = await sink.getCanvas(Math.max(0, atSeconds));
          if (!wrapped) return null;
          return await canvasToBlob(
            wrapped.canvas, opts?.maxWidth, opts?.mimeType ?? "image/jpeg", opts?.quality ?? 0.95,
          );
        } catch {
          return null;
        }
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        void input.dispose();
      },
    };
  } catch {
    void input.dispose();
    return null;
  }
}

/**
 * Normalise a (possibly Offscreen) decode canvas → an HTMLCanvasElement JPEG
 * Blob, optionally downscaled to `maxWidth` (aspect kept). Shared by
 * extractFrameAsBlob and extractPosterBlob so the toBlob surface is consistent
 * across mediabunny's pool implementations. Null when a 2D context can't be
 * acquired (headless / lost context).
 */
async function canvasToBlob(
  src: HTMLCanvasElement | OffscreenCanvas,
  maxWidth: number | undefined,
  mimeType: string,
  quality: number,
): Promise<Blob | null> {
  let outW = src.width;
  let outH = src.height;
  if (maxWidth && src.width > maxWidth) {
    outW = maxWidth;
    outH = Math.round(src.height * (maxWidth / src.width));
  }
  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(src as CanvasImageSource, 0, 0, outW, outH);
  return await new Promise<Blob | null>((resolve) => {
    out.toBlob((b) => resolve(b), mimeType, quality);
  });
}

/**
 * Mean luma (0-255) of a decoded frame, sampled through a tiny 16×9 canvas so
 * the read is a fixed ~144-pixel cost regardless of source resolution. Used by
 * extractPosterBlob to reject black intro/fade frames. Rec. 601 coefficients.
 */
function meanLuma(
  scratch: CanvasRenderingContext2D,
  src: HTMLCanvasElement | OffscreenCanvas,
): number {
  const w = scratch.canvas.width;
  const h = scratch.canvas.height;
  scratch.drawImage(src as CanvasImageSource, 0, 0, w, h);
  const { data } = scratch.getImageData(0, 0, w, h);
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return sum / (w * h);
}

/**
 * Probe just the playback duration of a local file via mediabunny — one Input,
 * `computeDuration()`, disposed immediately. Returns seconds, or `null` when
 * the file has no measurable duration (NaN / ≤0) or can't be opened. Used by
 * the poster picker to bound its scrub slider.
 */
export async function probeVideoDuration(localPath: string): Promise<number | null> {
  const input = new Input({ source: mediabunnySource(localPath), formats: ALL_FORMATS });
  try {
    const dur = await input.computeDuration();
    return Number.isFinite(dur) && dur > 0 ? dur : null;
  } catch {
    return null;
  } finally {
    void input.dispose();
  }
}

/**
 * Extract a *representative* poster frame — the auto-thumbnail that never lands
 * on a black fade-in. Two modes:
 *
 *  - `atSeconds` given → decode exactly that frame (a user-chosen poster; no
 *    luma test — the user picked it deliberately).
 *  - otherwise → probe a handful of offsets spread across the file, measure
 *    each frame's mean luma, and accept the FIRST that clears a black-frame
 *    threshold; if none clears it, fall back to the brightest one seen.
 *
 * Returns `null` when mediabunny can't decode the file's video (no track /
 * unsupported codec) — the caller then drops to the ffmpeg fallback. Disposes
 * the Input in every path.
 */
export async function extractPosterBlob(
  localPath: string,
  opts?: { atSeconds?: number; maxWidth?: number; quality?: number },
): Promise<Blob | null> {
  const input = new Input({ source: mediabunnySource(localPath), formats: ALL_FORMATS });
  try {
    const vt = await input.getPrimaryVideoTrack();
    if (!vt) return null;
    if (!(await vt.canDecode())) return null;
    // One shared sink reused across every candidate decode (poolSize 1).
    const sink = new CanvasSink(vt, { poolSize: 1 });
    const maxWidth = opts?.maxWidth;
    const quality = opts?.quality ?? 0.8;

    // ── Chosen frame: decode that one, no luma test. ──
    if (typeof opts?.atSeconds === "number" && Number.isFinite(opts.atSeconds)) {
      const wrapped = await sink.getCanvas(Math.max(0, opts.atSeconds));
      if (!wrapped) return null;
      return await canvasToBlob(wrapped.canvas, maxWidth, "image/jpeg", quality);
    }

    // ── Representative: scan candidate offsets for the first non-black frame. ──
    let dur = 0;
    try {
      const d = await input.computeDuration();
      if (Number.isFinite(d) && d > 0) dur = d;
    } catch {
      /* unknown duration → fixed-second fallback offsets below */
    }
    const hi = Math.max(0, dur - 0.05);
    const clamp = (t: number) => (dur > 0 ? Math.min(Math.max(0, t), hi) : Math.max(0, t));
    const candidates = dur > 0
      ? [0.2, 0.45, 0.1, 0.65, 0.03].map((f) => f * dur)
      : [2, 5, 0];

    // Tiny scratch canvas for the mean-luma read (see meanLuma).
    const scratch = document.createElement("canvas");
    scratch.width = 16;
    scratch.height = 9;
    const sctx = scratch.getContext("2d", { willReadFrequently: true });

    const LUMA_OK = 16; // below this the frame reads as effectively black
    let bestOffset: number | null = null;
    let bestLuma = -1;
    for (const raw of candidates) {
      const t = clamp(raw);
      const wrapped = await sink.getCanvas(t);
      if (!wrapped) continue;
      // No 2D scratch context (headless) → can't luma-test; take the first frame.
      const luma = sctx ? meanLuma(sctx, wrapped.canvas) : 255;
      if (luma >= LUMA_OK) {
        // Accept now — the pooled canvas is still valid (no getCanvas since).
        return await canvasToBlob(wrapped.canvas, maxWidth, "image/jpeg", quality);
      }
      if (luma > bestLuma) {
        bestLuma = luma;
        bestOffset = t;
      }
    }
    // Everything was dim — re-decode the brightest candidate (a fresh getCanvas,
    // so we never hold a poolSize-1 canvas across another decode).
    if (bestOffset == null) return null;
    const wrapped = await sink.getCanvas(bestOffset);
    if (!wrapped) return null;
    return await canvasToBlob(wrapped.canvas, maxWidth, "image/jpeg", quality);
  } catch {
    return null;
  } finally {
    void input.dispose();
  }
}

/**
 * Probes just the codec metadata of a local file via mediabunny — used
 * by the smart-path-selection logic to ask "will mediabunny be able to
 * decode this without help?" without committing to a full player mount.
 * Cheaper than opening a full Input+CanvasSink+AudioBufferSink.
 */
export async function canMediabunnyDecode(localPath: string): Promise<boolean> {
  const input = new Input({ source: mediabunnySource(localPath), formats: ALL_FORMATS });
  try {
    const [vt, at] = await Promise.all([
      input.getPrimaryVideoTrack(),
      input.getPrimaryAudioTrack(),
    ]);
    // If no tracks at all, mediabunny can't help us play anything.
    if (!vt && !at) return false;
    // Video track present → must be decodable.
    if (vt && !(await vt.canDecode())) return false;
    // Audio track present → must be decodable too (otherwise silent
    // playback would be worse than the ffmpeg fallback's transcode).
    if (at && !(await at.canDecode())) return false;
    return true;
  } catch {
    return false;
  } finally {
    void input.dispose();
  }
}

/**
 * Decode a strip of thumbnail frames from a local file for the timeline
 * filmstrip scrubber. One `CanvasSink` + `canvasesAtTimestamps` decodes the
 * whole (sorted) set in a single optimized pass — each packet at most once —
 * far cheaper than N `getCanvas` calls or N `ffmpeg -ss` spawns. Rotation is
 * applied from file metadata by the sink, so phone-shot verticals come out
 * upright. Works on any codec mediabunny can decode here (now incl. ProRes via
 * the registered decoder).
 *
 * Returns a JPEG data URL per input timestamp (index-aligned), `null` for a
 * timestamp with no frame, or `[]` when mediabunny can't decode the file (the
 * caller then just shows no filmstrip). Honours `signal` so an in-flight strip
 * is abandoned when the source or track width changes.
 */
export async function extractFilmstrip(
  localPath: string,
  timestamps: number[],
  opts?: { height?: number; quality?: number; signal?: AbortSignal },
): Promise<(string | null)[]> {
  if (timestamps.length === 0) return [];
  const input = new Input({ source: mediabunnySource(localPath), formats: ALL_FORMATS });
  const out: (string | null)[] = [];
  try {
    const vt = await input.getPrimaryVideoTrack();
    if (!vt || !(await vt.canDecode())) return [];
    const height = Math.max(16, Math.round(opts?.height ?? 88));
    const quality = opts?.quality ?? 0.68;
    const sink = new CanvasSink(vt, { height, poolSize: 2 });
    const tmp = document.createElement("canvas");
    const ctx = tmp.getContext("2d");
    if (!ctx) return [];
    for await (const wrapped of sink.canvasesAtTimestamps(timestamps)) {
      if (opts?.signal?.aborted) break;
      if (!wrapped) { out.push(null); continue; }
      const c = wrapped.canvas;
      // Copy each pooled canvas out synchronously before the iterator reuses it.
      tmp.width = c.width;
      tmp.height = c.height;
      ctx.drawImage(c as CanvasImageSource, 0, 0);
      out.push(tmp.toDataURL("image/jpeg", quality));
    }
    return out;
  } catch {
    return out; // a partial strip on a mid-decode failure is fine
  } finally {
    void input.dispose();
  }
}
