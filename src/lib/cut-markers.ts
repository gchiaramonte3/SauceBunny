import { loadJson, saveJson } from "./storage";
import { pathKey } from "./repath";

/** Source-relative cut positions, separate from editorial/YouTube chapters. */
export type CutMarker = { time: number };
export type CutMarkerChange = { sourceKey: string; addedCount?: number };
export const CUT_MARKERS_CHANGED_EVENT = "saucebunny:cut-markers-changed";
const key = (sourceKey: string) => `saucebunny.cutMarkers.${pathKey(sourceKey)}`;

export function loadCutMarkers(sourceKey: string): CutMarker[] {
  const raw = loadJson<unknown>(key(sourceKey), []);
  if (!Array.isArray(raw)) return [];
  const times = raw.flatMap(marker => marker && typeof marker === "object" && "time" in marker
    && typeof marker.time === "number" && Number.isFinite(marker.time) && marker.time > 0
    ? [Math.round(marker.time * 1e6)] : []).filter(time => Number.isSafeInteger(time) && time > 0);
  return [...new Set(times)].sort((a, b) => a - b).map(time => ({ time: time / 1e6 }));
}

/** Also forwards already-present confirmations from a detached analysis panel. */
export function announceCutMarkers(change: CutMarkerChange) {
  try { window.dispatchEvent(new CustomEvent(CUT_MARKERS_CHANGED_EVENT, { detail: change })); }
  catch { /* non-DOM context */ }
}

/** Read-back verifies quota errors before notifying either timeline window. */
export function saveCutMarkers(sourceKey: string, markers: CutMarker[], addedCount?: number): boolean {
  saveJson(key(sourceKey), markers);
  if (JSON.stringify(loadCutMarkers(sourceKey)) !== JSON.stringify(markers)) return false;
  announceCutMarkers({ sourceKey, ...(addedCount === undefined ? {} : { addedCount }) });
  return true;
}
