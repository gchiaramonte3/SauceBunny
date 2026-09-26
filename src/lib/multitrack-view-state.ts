import { loadJson, saveJson } from "./storage";

/**
 * How an AAF Audio sequence was last left: the mix (solo, mute, per-mic gain)
 * and the view (zoom, track size, open groups, checked mics, overlays). One
 * localStorage key holds every sequence, capped to the most recently used, so
 * reopening a sequence restores the room without the store growing for ever.
 * It is a preference, not work product: losing it costs a few clicks.
 */
export const VIEW_STATE_KEY = "saucebunny.aafAudioView";
export const VIEW_STATE_LIMIT = 50;

export type MultitrackViewState = {
  solo?: string[]; mute?: string[]; levels?: Record<string, number>;
  zoom?: number; density?: string; text?: string[]; expanded?: string[]; selected?: string[]; waveforms?: boolean;
  updatedAt?: number;
};
type Store = Record<string, MultitrackViewState>;

const ids = (value: unknown, known: Set<string>) => Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && known.has(id)) : undefined;

/** Saved state for one sequence, with any track the current import no longer has dropped. */
export function loadViewState(documentId: string, trackIds: string[]): MultitrackViewState | null {
  const saved = loadJson<Store>(VIEW_STATE_KEY, {})[documentId];
  if (!saved || typeof saved !== "object") return null;
  const known = new Set(trackIds);
  const levels = saved.levels && typeof saved.levels === "object"
    ? Object.fromEntries(Object.entries(saved.levels).filter(([id, level]) => known.has(id) && Number.isFinite(level))) : undefined;
  return {
    solo: ids(saved.solo, known), mute: ids(saved.mute, known), levels,
    // The timeline zooms in powers of two from 1x to 1024x and has three track sizes.
    zoom: typeof saved.zoom === "number" && saved.zoom >= 1 && saved.zoom <= 1024 && Number.isInteger(Math.log2(saved.zoom)) ? saved.zoom : undefined,
    density: saved.density === "small" || saved.density === "medium" || saved.density === "large" ? saved.density : undefined,
    text: ids(saved.text, known), expanded: ids(saved.expanded, known), selected: ids(saved.selected, known),
    waveforms: typeof saved.waveforms === "boolean" ? saved.waveforms : undefined,
  };
}

/** Merge part of a sequence's state; several components each own a few fields. */
export function saveViewState(documentId: string, patch: MultitrackViewState, now = Date.now()) {
  const store = loadJson<Store>(VIEW_STATE_KEY, {});
  store[documentId] = { ...store[documentId], ...patch, updatedAt: now };
  const kept = Object.entries(store).sort(([, a], [, b]) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, VIEW_STATE_LIMIT);
  saveJson(VIEW_STATE_KEY, Object.fromEntries(kept));
}
