import { Input, ALL_FORMATS, CanvasSink, EncodedPacketSink } from "mediabunny";
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
/**
 * Does this decoded frame read as pure black?
 *
 * The failure it detects: a decoder can succeed while the platform cannot
 * WRAP the result for painting (a >8-bit sample on a WebCodecs build with no
 * matching VideoFrame format). Nothing throws — the canvas is simply black.
 * Callers use it to route to the ffmpeg path instead of shipping a black
 * poster or playing a black picture.
 *
 * Threshold 2/255 mean luma: a real frame, even a dark one, carries sensor
 * noise and compression dither well above this; a failed wrap is exactly 0.
 * Callers must still sample MORE THAN ONE timestamp before concluding the
 * source is unpaintable — a deliberate black frame (fade in/out, slate) is
 * ordinary footage.
 */
export function canvasLooksBlank(src: HTMLCanvasElement | OffscreenCanvas): boolean {
  const scratch = document.createElement("canvas");
  scratch.width = 16;
  scratch.height = 9;
  const ctx = scratch.getContext("2d", { willReadFrequently: true });
  if (!ctx) return false; // can't tell → assume paintable, never false-positive
  return meanLuma(ctx, src) < 2;
}

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
    // NOTE (r148): there is deliberately NO ProRes short-circuit here.
    // turbores is the FASTER decoder for ProRes — ~310 fps vs ffmpeg's ~107
    // at 4K 422 HQ multithreaded — so bailing to ffmpeg on sight of ProRes
    // would trade a 3x speed win for a subprocess. The old 10-bit black-
    // canvas hazard is handled by @mediabunny/prores itself: it probes which
    // VideoFrame formats this platform can actually construct and passes
    // them to turbores as allowedOutputFormats, so it never hands WKWebView
    // a sample it cannot wrap. The empirical canvasLooksBlank guard below is
    // the backstop if that ever fails, on any codec, rather than a blanket
    // ban on one.
    // One shared sink reused across every candidate decode (poolSize 1).
    const sink = new CanvasSink(vt, { poolSize: 1 });
    const maxWidth = opts?.maxWidth;
    const quality = opts?.quality ?? 0.8;

    // ── Chosen frame: decode that one, no luma test. ──
    if (typeof opts?.atSeconds === "number" && Number.isFinite(opts.atSeconds)) {
      const wrapped = await sink.getCanvas(Math.max(0, opts.atSeconds));
      if (!wrapped) return null;
      // Unpaintable-sample guard for the chosen frame too: a canvas that
      // reads pure black is a failed wrap, not the user's frame. ffmpeg
      // re-grabs the SAME exact timestamp (poster_vf's chosen path), so a
      // genuinely dark chosen frame still comes back correct.
      if (canvasLooksBlank(wrapped.canvas)) return null;
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

    // Posters need a REPRESENTATIVE frame, not an exact one: snap every
    // candidate to the keyframe at-or-before it, so each try decodes ONE
    // frame instead of walking a whole GOP (the difference between seconds
    // and ~100ms per poster on long-GOP 4K — this was the slow-thumbnails
    // report). The chosen-frame path above stays exact: the user picked
    // that specific frame.
    const keySink = new EncodedPacketSink(vt);
    const snap = async (t: number): Promise<number> => {
      try {
        const pkt = await keySink.getKeyPacket(t, { verifyKeyPackets: false });
        return pkt ? pkt.timestamp : t;
      } catch {
        return t;
      }
    };

    // Tiny scratch canvas for the mean-luma read (see meanLuma).
    const scratch = document.createElement("canvas");
    scratch.width = 16;
    scratch.height = 9;
    const sctx = scratch.getContext("2d", { willReadFrequently: true });

    const LUMA_OK = 16; // below this the frame reads as effectively black
    let bestOffset: number | null = null;
    let bestLuma = -1;
    for (const raw of candidates) {
      const t = await snap(clamp(raw));
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
    // Every candidate painted essentially BLACK. A real video is never pure
    // black at five spread offsets — this is the unpaintable-sample
    // signature (a codec that decodes but paints black in WKWebView).
    // Return null so the ffmpeg fallback makes the poster instead of a
    // black JPEG being shown AND persisted to the disk cache.
    if (bestLuma < 2) return null;
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
export type TrackDecode = "ok" | "undecodable" | "absent";
export type DecodeProbe = { video: TrackDecode; audio: TrackDecode };

/**
 * WHICH track mediabunny cannot decode, not merely whether one exists.
 *
 * This used to collapse to a single boolean, and that cost real minutes. The
 * probe is an AND - video must decode and audio must decode - so a file with
 * perfectly good H.264 video and one audio track WebCodecs cannot handle
 * failed the whole check and was sent to a full `h264_videotoolbox` re-encode
 * of EVERY FRAME to fix the sound. The comment above the caller names that as
 * the common case (AAC in WKWebView, which has no AudioDecoder before Safari
 * 26), so the expensive path was the usual one.
 *
 * Knowing which side failed lets the fallback copy the video stream instead of
 * re-encoding it, which turns a transcode into a remux.
 */
export async function probeMediabunnyDecode(localPath: string): Promise<DecodeProbe> {
  const input = new Input({ source: mediabunnySource(localPath), formats: ALL_FORMATS });
  try {
    const [vt, at] = await Promise.all([
      input.getPrimaryVideoTrack(),
      input.getPrimaryAudioTrack(),
    ]);
    const video: TrackDecode = !vt ? "absent" : (await vt.canDecode()) ? "ok" : "undecodable";
    const audio: TrackDecode = !at ? "absent" : (await at.canDecode()) ? "ok" : "undecodable";
    return { video, audio };
  } catch {
    // A file we cannot even open is not a file we can claim anything about.
    return { video: "undecodable", audio: "undecodable" };
  } finally {
    void input.dispose();
  }
}

export async function canMediabunnyDecode(localPath: string): Promise<boolean> {
  const { video, audio } = await probeMediabunnyDecode(localPath);
  // No tracks at all: mediabunny cannot help us play anything.
  if (video === "absent" && audio === "absent") return false;
  return video !== "undecodable" && audio !== "undecodable";
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
