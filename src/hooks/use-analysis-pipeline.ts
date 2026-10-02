import { useRef, useState } from "react";
import { useTauriListeners } from "./use-tauri-listeners";
import { ANALYSIS_PIPELINE_EVENT, isAnalysisPipelineEvent } from "../lib/scene-analysis/pipeline";
import type { ClientLog } from "../types";

/** Main-window sink for both docked and detached analysis. Existing Pipeline
 * Copy/Export diagnostics consume the same appendLog rows automatically. */
export function useAnalysisPipeline(appendLog: (tag: ClientLog["tag"], source: string, message: string) => void) {
  const runs = useRef(new Map<string, { sequence: number; status: string }>());
  const [status, setStatus] = useState<"analyzing" | "stopping" | undefined>();
  useTauriListeners(on => {
    on<unknown>(ANALYSIS_PIPELINE_EVENT, event => {
      if (!isAnalysisPipelineEvent(event)) return;
      const prior = runs.current.get(event.runId);
      if (prior && (event.sequence <= prior.sequence || prior.status === "finished")) return;
      runs.current.set(event.runId, { sequence: event.sequence, status: event.status });
      // Keep a bounded terminal history so duplicate/late deliveries stay inert.
      if (runs.current.size > 256) {
        const oldest = [...runs.current].find(([, run]) => run.status === "finished");
        if (oldest) runs.current.delete(oldest[0]);
      }
      appendLog(event.tag, "video-ai", event.message);
      const states = [...runs.current.values()];
      setStatus(states.some(run => run.status === "active") ? "analyzing"
        : states.some(run => run.status === "stopping") ? "stopping" : undefined);
    });
  }, [appendLog]);
  return status;
}
