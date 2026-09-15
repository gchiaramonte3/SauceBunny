import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import type { ObsEditSource } from "../bindings/ObsEditSource";
import type { NdiProgramSnapshot } from "../lib/ndi-program-coordinator";
import { isDisplayCapture } from "../lib/ndi-program-source";

export type CaptureEditRequest = { sourceId: string; serial: number };

/** Native Edit is a request to open a draft, not permission to recrop, start,
 * stop or publish. Both native and renderer reject obsolete capture owners. */
export function useObsRegionEdit(snapshot: NdiProgramSnapshot, onEdit: (request: CaptureEditRequest) => void) {
  const current = useRef({ snapshot, onEdit }); current.current = { snapshot, onEdit };
  const serial = useRef(0);
  useEffect(() => {
    let disposed = false;
    const unlisten = listen<ObsEditSource>("obs:edit-source", ({ payload }) => {
      if (disposed || !payload || typeof payload.sourceId !== "string") return;
      const { snapshot: state, onEdit: edit } = current.current;
      if (state.busy === "publishing" || state.busy === "stopping") return;
      const owner = [state.candidate, state.published].find(source => source?.id === payload.sourceId);
      if (!owner || owner.retired || owner.telemetry.phase === "off" || owner.telemetry.phase === "error"
        || owner.telemetry.connectionCount === 0 || !owner.capture || !isDisplayCapture(owner.capture)) return;
      // Full Screen also owns the native Edit control. Opening its full-size
      // Region draft does not change capture until the user presses Preview.
      edit({ sourceId: owner.id, serial: ++serial.current });
    });
    // Event registration failure must not become an unhandled rejection or
    // trigger capture retries. The existing Source settings gear still works.
    void unlisten.catch(() => {});
    return () => { disposed = true; void unlisten.then(remove => remove()).catch(() => {}); };
  }, []);
}
