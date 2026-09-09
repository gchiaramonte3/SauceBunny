/**
 * rVFC waits for a NEW compositor frame, not simply a decoded seek result.
 * A paused/covered presentation layer may never deliver that callback. Prefer
 * its precise timestamp, but accept an already-decoded, settled current frame
 * in the current event turn. Never infer readiness from elapsed time.
 */
export function confirmDecodedFrame(
  media: HTMLMediaElement,
  isCurrent: () => boolean,
  confirm: (seconds: number) => void,
): () => void {
  const video = media as HTMLVideoElement;
  let finished = false;
  let frameId: number | undefined;
  const cancel = () => {
    finished = true;
    if (frameId !== undefined) video.cancelVideoFrameCallback?.(frameId);
  };
  const finish = (seconds: number) => {
    if (finished || !isCurrent() || media.seeking || media.readyState < 2) return;
    if ("videoWidth" in media && video.videoWidth <= 0) return;
    cancel();
    confirm(seconds);
  };
  if (typeof video.requestVideoFrameCallback === "function") {
    frameId = video.requestVideoFrameCallback((_now, frame) => finish(frame.mediaTime));
  }
  // Callers run after seeked/loadeddata or a zero-distance assignment. This
  // microtask lets that event finish; readiness itself is checked above.
  queueMicrotask(() => finish(media.currentTime));
  return cancel;
}
