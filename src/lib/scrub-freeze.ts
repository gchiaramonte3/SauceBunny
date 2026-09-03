/**
 * Should a pipeline rebuild freeze the outgoing video frame into the scrub
 * overlay?
 *
 * THE PROBLEM IT SOLVES. An out-of-buffer seek on a web source rebuilds the
 * whole ffmpeg pipeline, and the rebuild assigns `video.src` for a fresh
 * MediaSource. That runs the media load algorithm, which DISCARDS the frame
 * the element was presenting - so it paints nothing, and what the viewer sees
 * is the monitor's own black for the length of the rebuild.
 *
 * THE PROBLEM IT CAUSED, WHICH WAS WORSE. The first version froze the frame
 * on every rebuild, unconditionally. But on an out-of-buffer drag the <video>
 * never moves: it stays parked at the position it held BEFORE the gesture,
 * because the seek it was given cannot land until the pipeline is rebuilt.
 * The frame-accurate picture during that drag comes from somewhere else - the
 * mediabunny decoder painting the target frame straight into the overlay.
 *
 * So freezing the <video> drew the frame the user STARTED from over the frame
 * they had just scrubbed to. Releasing the playhead snapped the picture back
 * to the beginning of the gesture, where it sat for the whole rebuild. That
 * is the "it was frame-accurate before and now it is ruined" report, and it
 * was a regression introduced by the fix for the black one.
 *
 * THE RULE, therefore: the freeze is a LAST RESORT for an overlay holding
 * nothing. A decoded frame is always a better thing to look at than the
 * outgoing one, and is never overwritten. That leaves the freeze doing its
 * job exactly where the decoder cannot help - a peer stream, where the
 * preview decoder is deliberately off because the raw route has no random
 * access, and the moments before the decoder's first paint on any source.
 */
export function shouldFreezeOutgoingFrame(i: {
  /** Is the overlay already holding a real, decoded frame? */
  previewPainted: boolean;
  /** HTMLMediaElement.readyState - >= 2 (HAVE_CURRENT_DATA) is drawable. */
  readyState: number;
  /** 0 before metadata; drawImage of a zero-width video throws. */
  videoWidth: number;
}): boolean {
  if (i.previewPainted) return false;
  return i.readyState >= 2 && i.videoWidth > 0;
}
