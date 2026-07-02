import { Input, UrlSource, ALL_FORMATS, CanvasSink } from "mediabunny";
import { convertFileSrc } from "@tauri-apps/api/core";

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
  const url = convertFileSrc(localPath);
  // No AudioContext / no playback wiring — just demux + one canvas.
  const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
  try {
    const vt = await input.getPrimaryVideoTrack();
    if (!vt) return null;
    if (!(await vt.canDecode())) return null;
    const sink = new CanvasSink(vt, { poolSize: 1 });
    const wrapped = await sink.getCanvas(Math.max(0, atSeconds));
    if (!wrapped) return null;
    const src = wrapped.canvas;

    // Optionally downscale (used for thumbnails). Keeps aspect ratio.
    let outW = src.width;
    let outH = src.height;
    const maxW = opts?.maxWidth;
    if (maxW && src.width > maxW) {
      outW = maxW;
      outH = Math.round(src.height * (maxW / src.width));
    }

    // Normalise OffscreenCanvas → HTMLCanvasElement so toBlob's surface
    // is consistent across mediabunny's pool implementations.
    const out = document.createElement("canvas");
    out.width = outW;
    out.height = outH;
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(src as CanvasImageSource, 0, 0, outW, outH);

    const mimeType = opts?.mimeType ?? "image/jpeg";
    const quality = opts?.quality ?? 0.95;
    return await new Promise<Blob | null>((resolve) => {
      out.toBlob((b) => resolve(b), mimeType, quality);
    });
  } catch {
    // Any decode/demux failure → null → ffmpeg fallback path takes over.
    return null;
  } finally {
    // Always release decoders + source streams, even on error.
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
  const url = convertFileSrc(localPath);
  const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
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
  const url = convertFileSrc(localPath);
  const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
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
