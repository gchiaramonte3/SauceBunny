import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { RfSource } from "./review-fullscreen-fixture";
import { fitPicture, frameTimecode } from "./review-fullscreen-model";
import { FrameScene, WindowScene } from "./RfScenes";

/**
 * The stage: the picture at its own shape, as large as its area allows, and
 * what the room puts on it (reactions, the drawing hint). The control bar is
 * passed in and floats over the bottom of the same area.
 */
export function RfStage({ source, frame, drawing, reactions, children }: {
  source: RfSource; frame: number; drawing: boolean; reactions: { id: number; emoji: string }[]; children?: ReactNode;
}) {
  const area = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = area.current;
    if (!element) return;
    const measure = () => setBox(fitPicture({ width: element.clientWidth, height: element.clientHeight }, source.aspect));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [source.aspect]);
  return <div ref={area} className={`cp-rf-stage${drawing ? " is-drawing" : ""}`} data-testid="rf-stage">
    <div className="cp-rf-picture" style={{ width: box.width, height: box.height }} role="img" aria-label={`${source.title}, ${source.detail}`} data-testid="rf-picture">
      {source.kind === "window" ? <WindowScene /> : <FrameScene label={source.kind === "program" ? "PROGRAM" : "CUT 3 · REEL 2"} timecode={source.live ? "01:02:14:08" : frameTimecode(frame)} />}
      {reactions.map((reaction) => <span key={reaction.id} className="cp-rf-reaction" aria-hidden="true">{reaction.emoji}<span>You</span></span>)}
      {drawing && <span className="cp-rf-draw-hint">Drawing for the room · Esc stops</span>}
    </div>
    {children}
  </div>;
}
