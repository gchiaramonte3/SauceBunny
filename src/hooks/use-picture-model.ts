import { useCallback, useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import type { VideoModel } from "../bindings/VideoModel";
import { isPictureModel, PICTURE_MODEL_KEY, savedPictureModel, type PictureModelId } from "../lib/picture-model";
import { useVideoIntelligence } from "./use-video-intelligence";

const PREFERENCE_CHANGED = "panel:picture-model-changed";

/** Settings and Clip share the existing remembered choice. This hook only
 * reads/writes the preference; it never loads or downloads a model. */
export function usePictureModelPreference() {
  const [id, setId] = useState(savedPictureModel);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false, unlisten: (() => void) | undefined;
    const refresh = () => { if (!disposed) setId(savedPictureModel()); };
    const storage = (event: StorageEvent) => { if (event.key === PICTURE_MODEL_KEY || event.key === null) refresh(); };
    window.addEventListener(PREFERENCE_CHANGED, refresh);
    window.addEventListener("storage", storage);
    window.addEventListener("focus", refresh);
    void listen(PREFERENCE_CHANGED, refresh).then(stop => {
      if (disposed) stop(); else { unlisten = stop; refresh(); }
    }).catch(() => { /* Storage events and focus also reconcile the saved choice. */ });
    return () => { disposed = true; unlisten?.(); window.removeEventListener(PREFERENCE_CHANGED, refresh);
      window.removeEventListener("storage", storage); window.removeEventListener("focus", refresh); };
  }, []);
  const select = useCallback((next: PictureModelId) => {
    if (!isPictureModel(next)) return;
    try { localStorage.setItem(PICTURE_MODEL_KEY, next); }
    catch { setError("Could not save the default picture model. Try again."); return; }
    setId(next); setError("");
    window.dispatchEvent(new Event(PREFERENCE_CHANGED));
    void emit(PREFERENCE_CHANGED).catch(() => { /* Other windows also reconcile on focus. */ });
  }, []);
  return { id, select, error };
}

export function usePictureModel() {
  const preference = usePictureModelPreference();
  const [models, setModels] = useState<VideoModel[] | null>(null);
  const { run, error } = useVideoIntelligence();
  useEffect(() => {
    let disposed = false, unlisten: (() => void) | undefined;
    let refreshing = false, requested = false;
    const refresh = async (invalidate = false) => {
      if (disposed) return;
      requested = true;
      // Window activation must not swallow the click that brought us back.
      // Keep the last verified list during focus revalidation; an explicit
      // install/remove event invalidates it immediately. Analyze also checks
      // the selected installation natively before loading a model.
      if (invalidate) setModels(null);
      if (refreshing) return;
      refreshing = true;
      try {
        do {
          requested = false;
          const result = await run({ operation: "models" });
          if (!disposed && !requested) setModels(result?.models ?? null);
        } while (requested && !disposed);
      } finally { refreshing = false; }
    };
    void listen("panel:video-models-changed", () => refresh(true)).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(() => { /* Focus also refreshes installations. */ });
    // StrictMode's throwaway mount must not occupy the run owned by the real mount.
    void Promise.resolve().then(() => { if (!disposed) void refresh(); });
    const refreshOnFocus = () => { void refresh(); };
    window.addEventListener("focus", refreshOnFocus);
    return () => { disposed = true; unlisten?.(); window.removeEventListener("focus", refreshOnFocus); };
  }, [run]);
  return { ...preference, models, error, preferenceError: preference.error,
    ready: models?.some(model => model.id === preference.id && model.ready) ?? false };
}
