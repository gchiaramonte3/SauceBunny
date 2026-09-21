import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { VideoModel } from "../bindings/VideoModel";
import { PICTURE_MODEL_KEY, savedPictureModel, type PictureModelId } from "../lib/picture-model";
import { useVideoIntelligence } from "./use-video-intelligence";

export function usePictureModel() {
  const [id, setId] = useState(savedPictureModel);
  const [models, setModels] = useState<VideoModel[] | null>(null);
  const { run, error } = useVideoIntelligence();
  useEffect(() => {
    let disposed = false, unlisten: (() => void) | undefined;
    let refreshing = false, requested = false;
    const refresh = async () => {
      requested = true;
      if (refreshing || disposed) return;
      refreshing = true; setModels(null);
      try {
        do {
          requested = false;
          const result = await run({ operation: "models" });
          if (!disposed && result) setModels(result.models);
        } while (requested && !disposed);
      } finally { refreshing = false; }
    };
    void listen("panel:video-models-changed", () => refresh()).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(() => { /* Focus also refreshes installations. */ });
    // StrictMode's throwaway mount must not occupy the run owned by the real mount.
    void Promise.resolve().then(() => { if (!disposed) void refresh(); });
    window.addEventListener("focus", refresh);
    return () => { disposed = true; unlisten?.(); window.removeEventListener("focus", refresh); };
  }, [run]);
  return { id, models, error, ready: models?.some(model => model.id === id && model.ready) ?? false,
    select: (next: PictureModelId) => { setId(next); try { localStorage.setItem(PICTURE_MODEL_KEY, next); } catch { /* Session selection remains usable. */ } } };
}
