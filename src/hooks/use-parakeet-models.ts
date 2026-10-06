import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { PARAKEET_MODELS, PARAKEET_MODELS_CHANGED, type ParakeetModelId } from "../lib/parakeet-models";

export type ParakeetReady = Record<ParakeetModelId, boolean>;
const NONE: ParakeetReady = { "parakeet-ultra": false, "parakeet-tdt-0.6b-v3": false };

/**
 * Which Parakeet models are on disk, for AAF Audio. It never downloads: the
 * owner asked for every model to download in Settings, where the others do,
 * so a missing one is reported with a way there (MultitrackModelPicker).
 * Settings says when it installs or deletes one, and this checks again.
 */
export function useParakeetModels() {
  const [ready, setReady] = useState<ParakeetReady>(NONE);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // Only the newest check may set state: a slow answer from an older one
  // (a focus event racing the first look) must not undo a newer result.
  const revision = useRef(0);
  const check = useCallback(async (): Promise<ParakeetReady> => {
    const mine = ++revision.current;
    const entries = await Promise.all(PARAKEET_MODELS.map(async (model) =>
      [model.id, await invoke<boolean>("parakeet_model_downloaded", { model: model.id }).catch(() => false)] as const));
    const next = Object.fromEntries(entries) as ParakeetReady;
    if (mounted.current && mine === revision.current) setReady(next);
    return next;
  }, []);
  useEffect(() => {
    const onPanelParakeetModelsChanged = () => { void check(); };
    const subscription = listen(PARAKEET_MODELS_CHANGED, onPanelParakeetModelsChanged).catch(() => null);
    return () => { void subscription.then((unlisten) => unlisten?.()); };
  }, [check]);
  return { ready, check };
}
