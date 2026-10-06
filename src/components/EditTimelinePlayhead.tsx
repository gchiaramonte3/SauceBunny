import { useEffect } from "react";
import { useFrame } from "../hooks/use-frame";
import type { FrameStore } from "../lib/frame-store";

/**
 * The timeline's playhead line, the one part of it that moves while playing.
 * It reads the frame itself so the lanes, words and marks around it are not
 * drawn again on every frame; following turns the page when it runs off.
 */
export function EditTimelinePlayhead({ frames, fps, start, span, follow, onRunOff }: {
  frames: FrameStore; fps: number; start: number; span: number;
  /** Zoomed in with Follow on: a playhead that leaves the view brings the view to it. */
  follow: boolean; onRunOff: (seconds: number) => void;
}) {
  const playhead = useFrame(frames) / fps;
  useEffect(() => { if (follow && (playhead < start || playhead > start + span)) onRunOff(playhead); }, [follow, playhead, start, span, onRunOff]);
  return <span className="cp-te-tl-playhead" style={{ left: `${((playhead - start) / span) * 100}%` }} />;
}
