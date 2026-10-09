import { useFrame } from "../hooks/use-frame";
import type { FrameStore } from "../lib/frame-store";

type Props = { frames: FrameStore; viewStart: number; viewEnd: number; span: number };

/**
 * The playhead line in one AAF Audio lane. It reads the frame itself, so a
 * frame of playback redraws this line and not the lane around it.
 */
export function MultitrackPlayhead({ frames, viewStart, viewEnd, span }: Props) {
  const frame = useFrame(frames);
  if (frame < viewStart || frame >= viewEnd) return null;
  return <span className="cp-multitrack-playhead" style={{ left: `${(frame - viewStart) / span * 100}%` }} />;
}
