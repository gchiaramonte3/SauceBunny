import { useState } from "react";
import { loadCutMarkers, saveCutMarkers } from "../lib/cut-markers";
import { sceneCutMarkers, type SceneEvidence } from "../lib/scene-analysis/evidence";

/** Explicit adoption into the existing timeline, never an analysis side effect. */
export function ShotCutAction({ evidence, sourceKey, onCutMarkersChanged }: {
  evidence: SceneEvidence; sourceKey: string; onCutMarkersChanged?: () => void;
}) {
  const [message, setMessage] = useState("");
  function add() {
    // Read at click time so another panel's saved cuts are not overwritten.
    const existing = loadCutMarkers(sourceKey);
    const occupied = new Set(existing.map(marker => Math.round(marker.time * 1_000_000)));
    const additions = sceneCutMarkers(evidence).filter(marker => !occupied.has(Math.round(marker.time * 1_000_000)));
    if (!additions.length) { setMessage("Cut markers are already on the timeline."); return; }
    const next = [...existing, ...additions].sort((a, b) => a.time - b.time);
    if (!saveCutMarkers(sourceKey, next)) {
      setMessage("Couldn't save cut markers. Check available storage and try again.");
      return;
    }
    onCutMarkersChanged?.();
    setMessage(`Added ${additions.length} cut ${additions.length === 1 ? "marker" : "markers"}.`);
  }
  return <>
    <button type="button" className="btn btn-ghost cp-shot-cut-action" onClick={add}
      disabled={evidence.shots.length < 2} title="Add cut markers">Add cut markers</button>
    {message && <span role="status" className="cp-muted cp-shot-cut-status">{message}</span>}
  </>;
}
