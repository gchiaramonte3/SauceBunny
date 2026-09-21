import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ShotCutAction } from "../../src/components/ShotCutAction";
import { Timeline } from "../../src/components/Timeline";
import { loadChapters, saveChapters } from "../../src/lib/chapters";
import { CUT_MARKERS_CHANGED_EVENT, loadCutMarkers } from "../../src/lib/cut-markers";
import type { SceneEvidence } from "../../src/lib/scene-analysis/evidence";
import "../../src/styles/app.css";

// Isolated production-component fixture. No app boot, native IPC or models.
const evidence = { shots: [{ start_us: 0 }, { start_us: 1_500_002 }] } as unknown as SceneEvidence;
saveChapters("fixture-source", [{ time: 1.500002, title: "Creator chapter", origin: "creator" }]);
function Fixture() {
  const [cuts, setCuts] = useState(() => loadCutMarkers("fixture-source"));
  useEffect(() => {
    const reload = () => setCuts(loadCutMarkers("fixture-source"));
    window.addEventListener(CUT_MARKERS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(CUT_MARKERS_CHANGED_EVENT, reload);
  }, []);
  return <main style={{ padding: 16 }}>
    <section className="cp-shot-analysis">
      <div className="cp-shot-summary">
        <span className="cp-shot-count">2 shots · 1 cut</span>
        <ShotCutAction evidence={evidence} sourceKey="fixture-source" onCutMarkersChanged={() => {
          document.documentElement.dataset.notifications = String(Number(document.documentElement.dataset.notifications ?? 0) + 1);
        }} />
        <span className="cp-muted cp-shot-cut-help">Cuts mark shot changes along the bottom of the timeline. Chapters stay at the top.</span>
      </div>
    </section>
    <Timeline status="loaded" durationFrames={72} fps={24000 / 1001} inFrames={null} outFrames={null}
      chapterMarkers={loadChapters("fixture-source")} cutMarkers={cuts}
      onSeek={frame => { document.documentElement.dataset.frameSeek = String(frame); }}
      onCutSeek={seconds => { document.documentElement.dataset.cutSeek = String(seconds); }} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
