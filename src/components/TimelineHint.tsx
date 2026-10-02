import { useEffect, useRef, useState, type ReactNode } from "react";
import { CUT_MARKERS_CHANGED_EVENT, type CutMarkerChange } from "../lib/cut-markers";

/** A confirmation borrows the existing hint line; it never resizes the timeline. */
export function TimelineHint({ sourceKey, children }: { sourceKey: string | null; children: ReactNode }) {
  const [notice, setNotice] = useState<{ sourceKey: string; id: number; addedCount: number } | null>(null);
  const sequence = useRef(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    setNotice(null);
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<CutMarkerChange | null>).detail;
      if (!sourceKey || detail?.sourceKey !== sourceKey || typeof detail.addedCount !== "number"
        || !Number.isSafeInteger(detail.addedCount) || detail.addedCount < 0) return;
      clearTimeout(timer);
      setNotice({ sourceKey, id: ++sequence.current, addedCount: detail.addedCount });
      // Display lifetime only, never a readiness delay. CSS fades the last 300ms;
      // the timer also expires the message when reduced motion disables animation.
      timer = setTimeout(() => setNotice(null), 3000);
    };
    window.addEventListener(CUT_MARKERS_CHANGED_EVENT, changed);
    return () => { clearTimeout(timer); window.removeEventListener(CUT_MARKERS_CHANGED_EVENT, changed); };
  }, [sourceKey]);
  const active = notice?.sourceKey === sourceKey ? notice : null;
  return <div className={`cp-timeline-hint${active ? " cp-timeline-hint--confirming" : ""}`} aria-hidden={!children && !active}>
    <span className="cp-timeline-hint-default" aria-hidden={!!active || !children}>{children}</span>
    <span className="cp-timeline-hint-status" role="status" aria-live="polite" aria-atomic="true">
      {active && <span key={active.id} className="cp-timeline-confirmation">{active.addedCount
        ? `Added ${active.addedCount} cut ${active.addedCount === 1 ? "marker" : "markers"}`
        : "Cut markers already added"}</span>}
    </span>
  </div>;
}
