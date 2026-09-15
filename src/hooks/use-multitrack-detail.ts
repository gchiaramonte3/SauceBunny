import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AafDocument } from "../bindings/AafDocument";
import type { AafWaveform } from "../bindings/AafWaveform";
import { newJobId } from "../lib/job-id";

/** Refine only a settled, zoomed view. Overview remains visible during extraction. */
export function useMultitrackDetail(document: AafDocument, start: number, span: number, enabled: boolean) {
  const [detail, setDetail] = useState<{ key: string; peaks: Record<string, number[][]> }>({ key: "", peaks: {} });
  const cache = useRef(new Map<string, Record<string, number[][]>>());
  const key = `${document.id}:${start}:${span}`, tracks = document.manifest.tracks.map((track) => track.id).join("|");
  const documentId = document.id;
  useEffect(() => { cache.current.clear(); }, [documentId]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false; const jobs = new Set<string>();
    const timer = window.setTimeout(() => {
      const ids = tracks.split("|"); let index = 0;
      const saved = cache.current.get(key) ?? {};
      cache.current.delete(key); cache.current.set(key, saved);
      while (cache.current.size > 8) cache.current.delete(cache.current.keys().next().value!);
      setDetail({ key, peaks: saved });
      const worker = async () => {
        while (!cancelled && index < ids.length) {
          const trackId = ids[index++], jobId = newJobId(); jobs.add(jobId);
          if (saved[trackId]) { jobs.delete(jobId); continue; }
          try {
            const result = await invoke<AafWaveform>("aaf_waveform", { documentId, trackId, startFrame: start, durationFrames: span, jobId });
            if (!cancelled) { saved[trackId] = result.peaks; setDetail({ key, peaks: { ...saved } }); }
          } catch { /* Keep the valid overview; detail is an optional refinement. */ }
          finally { jobs.delete(jobId); }
        }
      };
      void worker(); void worker();
    }, cache.current.has(key) ? 0 : 80);
    return () => { cancelled = true; clearTimeout(timer); for (const jobId of jobs) void invoke("cancel_job", { jobId }).catch(() => {}); };
  }, [documentId, enabled, key, span, start, tracks]);
  return detail.key === key ? detail.peaks : {};
}
