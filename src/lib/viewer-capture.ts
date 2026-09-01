/**
 * Turn whatever the monitor is currently painting into a MediaStream.
 *
 * This is the "show them what I am watching" primitive. The app has three
 * playback engines and they render into two different kinds of element - a
 * <video> for the native and MSE paths, a <canvas> for the mediabunny path -
 * so the capture lives here rather than three times over. The same
 * `captureStream()` call already carries screen share in share-stream.ts, so
 * it is proven in this WKWebView, not assumed.
 *
 * WHY THIS EXISTS AT ALL: a guest who does not have the file waits on a
 * transfer. This gets a picture in front of them in about a second, at
 * whatever the mesh will carry, so the two people can talk about the same
 * frame while the real bytes are still moving.
 *
 * IT IS A REAL-TIME ENCODE, and CLAUDE.md is explicit that playback must come
 * from a local copy or a fixed, known-quality stream because a reviewer
 * judging a grade has to see compression that is in the source rather than in
 * the transport. So this is a BRIDGE and must be labelled as one wherever it
 * is shown. It is not a delivery mechanism and it must never be the thing
 * somebody approves from.
 */

/** Frames per second for a canvas capture. Not for a media element: those
 *  capture at their own rate and take no argument. 30 is enough for a
 *  conversation about a shot and cheap enough not to fight the encoder. */
const CANVAS_FPS = 30;

type CapturableMedia = HTMLMediaElement & { captureStream?: () => MediaStream;
  mozCaptureStream?: () => MediaStream };
type CapturableCanvas = HTMLCanvasElement & { captureStream?: (fps?: number) => MediaStream };

export type ViewerCapture = {
  stream: MediaStream;
  video: MediaStreamTrack | null;
  /** Null for the canvas path: a canvas carries no audio, and the mediabunny
   *  engine schedules its sound through Web Audio rather than an element. */
  audio: MediaStreamTrack | null;
};

/**
 * Capture an element, or null when this engine cannot produce a stream.
 *
 * Null rather than throwing: every caller's honest response is the same -
 * offer the file instead - and a capture that is merely unavailable is not an
 * error worth a dialog.
 */
export function captureElement(el: HTMLMediaElement | HTMLCanvasElement | null): ViewerCapture | null {
  if (!el) return null;
  try {
    let stream: MediaStream | undefined;
    if (el instanceof HTMLCanvasElement) {
      stream = (el as CapturableCanvas).captureStream?.(CANVAS_FPS);
    } else {
      const v = el as CapturableMedia;
      stream = v.captureStream?.() ?? v.mozCaptureStream?.();
    }
    if (!stream) return null;
    const video = stream.getVideoTracks()[0] ?? null;
    const audio = stream.getAudioTracks()[0] ?? null;
    // A stream with nothing in it is not a capture. A <video> that has not
    // started yet answers exactly this way, and handing the mesh an empty
    // stream shows the guest a black tile that never resolves - which reads
    // as the feature being broken rather than as "not ready".
    if (!video && !audio) return null;
    return { stream, video, audio };
  } catch {
    // Engines refuse for reasons that are not worth distinguishing here:
    // a tainted canvas, a media element with no decoded data yet.
    return null;
  }
}

/**
 * Whether a capture is worth offering for this element yet.
 *
 * Kept apart from captureElement so the UI can enable a button without
 * actually starting a capture on every render.
 */
export function canCapture(el: HTMLMediaElement | HTMLCanvasElement | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLCanvasElement) {
    return typeof (el as CapturableCanvas).captureStream === "function"
      // A canvas that has never been drawn into captures black frames.
      && el.width > 0 && el.height > 0;
  }
  const v = el as CapturableMedia;
  if (typeof v.captureStream !== "function" && typeof v.mozCaptureStream !== "function") return false;
  // HAVE_CURRENT_DATA. Below this the element has no frame to hand over.
  return v.readyState >= 2;
}
