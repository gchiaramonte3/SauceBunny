import { useSyncExternalStore } from "react";
import type { FrameStore } from "../lib/frame-store";

/**
 * The store's frame, or what `select` makes of it: the component re-renders
 * only when that result changes, so a pane that needs the word under the
 * playhead redraws a few times a second rather than on every frame. `select`
 * must return a primitive (a number, a string, null), never a fresh object.
 */
export function useFrame<T extends string | number | boolean | null = number>(store: FrameStore, select?: (frame: number) => T): T {
  return useSyncExternalStore(store.subscribe, () => (select ? select(store.get()) : store.get()) as T);
}
