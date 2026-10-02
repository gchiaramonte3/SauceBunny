import { useState } from "react";
import { announceCutMarkers, loadCutMarkers, saveCutMarkers, type CutMarker, type CutMarkerChange } from "../lib/cut-markers";
import { sceneCutMarkers, type SceneEvidence } from "../lib/scene-analysis/evidence";

/** Explicit adoption into the existing timeline, never an analysis side effect. */
export function ShotCutAction({ evidence, markers, sourceKey, onCutMarkersChanged }: {
  evidence?: SceneEvidence; markers?: CutMarker[]; sourceKey: string; onCutMarkersChanged?: (change: CutMarkerChange) => void;
}) {
  const [error, setError] = useState("");
  const candidates = markers ?? (evidence ? sceneCutMarkers(evidence) : []);
  function add() {
    setError("");
    // Read at click time so another panel's saved cuts are not overwritten.
    const existing = loadCutMarkers(sourceKey);
    const occupied = new Set(existing.map(marker => Math.round(marker.time * 1_000_000)));
    const additions = candidates.filter(marker => {
      const time = Math.round(marker.time * 1_000_000);
      if (!Number.isSafeInteger(time) || time <= 0 || occupied.has(time)) return false;
      occupied.add(time); return true;
    });
    const change = { sourceKey, addedCount: additions.length };
    if (!additions.length) {
      announceCutMarkers(change);
      onCutMarkersChanged?.(change);
      return;
    }
    const next = [...existing, ...additions].sort((a, b) => a.time - b.time);
    if (!saveCutMarkers(sourceKey, next, additions.length)) {
      setError("Couldn't save cut markers. Check available storage and try again.");
      return;
    }
    onCutMarkersChanged?.(change);
  }
  return <>
    <button type="button" className="btn btn-ghost cp-shot-cut-action" onClick={add}
      disabled={candidates.length === 0} title="Add cut markers">Add cut markers</button>
    {error && <span role="alert" className="cp-muted cp-shot-cut-error">{error}</span>}
  </>;
}
