import { useEffect, useRef } from "react";
import { PATHS_MOVED_EVENT, type PathsMoved } from "../lib/relink";

/**
 * Follow a folder that moved (relink.ts `moveStoredPaths`). For records a
 * component holds in state: writing their storage from outside would be
 * overwritten by the component's next save, so the owner moves its own.
 */
export function usePathsMoved(onMoved: (moved: PathsMoved) => void): void {
  const handler = useRef(onMoved);
  handler.current = onMoved;
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<PathsMoved>).detail;
      if (detail && typeof detail.from === "string" && typeof detail.to === "string") handler.current(detail);
    };
    window.addEventListener(PATHS_MOVED_EVENT, listener);
    return () => window.removeEventListener(PATHS_MOVED_EVENT, listener);
  }, []);
}
