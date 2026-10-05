import { useEffect, useSyncExternalStore } from "react";
import { bleedHidden, loadBleedHidden, subscribeBleedHidden } from "../lib/bleed-hidden";

/** The Hide bleed switch (lib/bleed-hidden), read by AAF Audio, String Outs and Settings alike. */
export function useBleedHidden(): boolean {
  useEffect(() => { void loadBleedHidden(); }, []);
  return useSyncExternalStore(subscribeBleedHidden, bleedHidden);
}
