import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AnalysisEditDocument } from "../bindings/AnalysisEditDocument";
import type { AnalysisRowCorrection } from "../bindings/AnalysisRowCorrection";
import { formatError } from "../lib/error-format";

/** Native row-level compare-and-save is shared by every webview. The in-flight
 * invoke survives navigation; only its visible response is source-scoped. */
export function useAnalysisCorrections(path: string | null, live: AnalysisEditDocument | null, sourceRevision = "") {
  const key = JSON.stringify([path, sourceRevision]);
  const [state, setState] = useState<{ key: string; doc: AnalysisEditDocument | null; loading: boolean; error: string }>({ key, doc: null, loading: !!path, error: "" });
  const identity = useRef({ key, hash: live?.source.sha256 });
  identity.current = { key, hash: live?.source.sha256 ?? (state.key === key ? state.doc?.source.sha256 : undefined) };
  useEffect(() => {
    let disposed = false;
    if (!path) return;
    const accept = (doc: AnalysisEditDocument | null | undefined) => {
      if (disposed) return;
      setState(old => ({ key, doc: doc && (!old.doc || old.key !== key || old.doc.source.sha256 !== doc.source.sha256 || doc.revision >= old.doc.revision) ? doc : old.key === key ? old.doc : null, loading: false, error: "" }));
    };
    const subscription = listen<AnalysisEditDocument>("analysis-corrections-saved", event => {
      if (event.payload.source.sha256 === identity.current.hash) accept(event.payload);
    }).catch(() => () => {});
    void invoke<AnalysisEditDocument | null>("load_analysis_corrections", { path }).then(accept).catch(cause => {
      if (!disposed) setState(old => ({ key, doc: old.key === key ? old.doc : null, loading: false, error: formatError(cause) }));
    });
    return () => { disposed = true; void subscription.then(unlisten => unlisten()).catch(() => {}); };
  }, [path, key]);
  const stored = state.key === key ? state.doc : null;
  const doc = stored && (!live || (stored.source.sha256 === live.source.sha256 && stored.source.origin_us === live.source.origin_us && stored.source.duration_us === live.source.duration_us)) ? stored : null;
  const save = useCallback(async (snapshot: AnalysisEditDocument, rowKey: string, edit: AnalysisRowCorrection) => {
    const requestPath = path;
    const adopt = (result: AnalysisEditDocument) => {
      if (identity.current.key === key && identity.current.hash === result.source.sha256) setState(old => old.key === key && old.doc && old.doc.source.sha256 === result.source.sha256 && old.doc.revision > result.revision ? old : { key, doc: result, loading: false, error: "" });
    };
    try {
      const result = await invoke<AnalysisEditDocument>("save_analysis_correction", { snapshot, key: rowKey, expectedRevision: edit.revision, edit });
      if (!result || result.source.sha256 !== snapshot.source.sha256 || result.revision < 1) throw new Error("The analysis correction was not confirmed saved.");
      adopt(result);
    } catch (cause) {
      // Events are advisory, not the authority. Recover the latest revision
      // even if a detached window missed its notification; retain the draft.
      if (requestPath) {
        try {
          const latest = await invoke<AnalysisEditDocument | null>("load_analysis_corrections", { path: requestPath });
          if (latest?.source.sha256 === snapshot.source.sha256) adopt(latest);
        } catch { /* Keep the last known saved view; the editor reports failure. */ }
      }
      throw cause;
    }
  }, [path, key]);
  return { doc, save, loading: !!path && (state.key !== key || state.loading), error: state.key === key ? state.error : "" };
}
