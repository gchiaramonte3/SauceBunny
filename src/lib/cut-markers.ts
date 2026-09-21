import { loadJson, saveJson } from "./storage";
import { pathKey } from "./repath";

/** Source-relative cut positions, separate from editorial/YouTube chapters. */
export type CutMarker = { time: number };
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

/** Read-back verifies quota errors before notifying either timeline window. */
export function saveCutMarkers(sourceKey: string, markers: CutMarker[]): boolean {
  saveJson(key(sourceKey), markers);
  if (JSON.stringify(loadCutMarkers(sourceKey)) !== JSON.stringify(markers)) return false;
  try { window.dispatchEvent(new CustomEvent(CUT_MARKERS_CHANGED_EVENT, { detail: { sourceKey } })); }
  catch { /* non-DOM context */ }
  return true;
}
