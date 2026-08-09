import { useCallback, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { parseSrt } from "../lib/srt";
import {
  groupHits, indexTranscript, searchTranscripts,
  type IndexedTranscript, type SearchHit,
} from "../lib/transcript-search";
import { loadTranscriptLibrary, type LibraryTranscript } from "../lib/transcript-library";
import type { TranscriptText } from "../bindings/TranscriptText";

/**
 * The library-wide transcript search: read every .srt once, then answer from
 * memory.
 *
 * BUILT ON DEMAND, ON FIRST SEARCH. Not at boot, because most sessions never
 * search and a startup that reads the whole transcript library to prepare for
 * something the user may not do is a startup that feels slow for no reason.
 * The first query pays the read; every one after it is a substring scan over
 * memory and lands in a frame.
 *
 * REFRESHED BY MTIME, not by a timer or a watcher. A transcript that gets
 * re-run overwrites its own .srt, which is the ordinary case here, so the
 * index has to notice. Comparing modification times on a rebuild is cheap and
 * has no staleness window to reason about, which a background watcher would.
 */

export type SearchState = {
  status: "idle" | "indexing" | "ready" | "error";
  /** How many transcripts are in the index. */
  count: number;
  error: string | null;
};

export function useTranscriptSearch() {
  const [state, setState] = useState<SearchState>({ status: "idle", count: 0, error: null });
  const [query, setQuery] = useState("");
  // STATE, not a ref. The search memo has to re-run when the index is rebuilt,
  // and a ref gives it nothing to depend on: a rebuild that happened to produce
  // the same transcript count would leave stale results on screen. React's own
  // lint caught this as an "unnecessary dependency" on the count I had been
  // using as a proxy, which was the tell.
  const [indexes, setIndexes] = useState<IndexedTranscript[]>([]);
  /** path → mtime the index was built from, so a rebuild only re-parses what
   *  actually changed. */
  const stampsRef = useRef<Map<string, number>>(new Map());
  const buildingRef = useRef(false);

  const build = useCallback(async () => {
    if (buildingRef.current) return;
    buildingRef.current = true;
    setState((s) => ({ ...s, status: "indexing", error: null }));
    try {
      const libPath = await invoke<string>("default_transcript_library_path");
      const files: LibraryTranscript[] = await loadTranscriptLibrary(libPath);
      const texts = await invoke<TranscriptText[]>("read_transcripts_bulk", {
        paths: files.map((f) => f.path),
      });
      const titleOf = new Map(files.map((f) => [f.path, f.title]));
      const next: IndexedTranscript[] = [];
      const stamps = new Map<string, number>();
      const prev = new Map(indexes.map((i) => [i.path, i]));
      for (const t of texts) {
        stamps.set(t.path, t.modified_ms);
        // Re-parsing an untouched transcript is the expensive half, so skip it.
        const cached = stampsRef.current.get(t.path) === t.modified_ms
          ? prev.get(t.path) : undefined;
        next.push(cached ?? indexTranscript(
          t.path, titleOf.get(t.path) ?? t.path, parseSrt(t.text),
        ));
      }
      // Newest first: the caller's order is the result order, and the cut you
      // are working on now is nearly always the one you are looking for.
      next.sort((a, b) => (stamps.get(b.path) ?? 0) - (stamps.get(a.path) ?? 0));
      setIndexes(next);
      stampsRef.current = stamps;
      setState({ status: "ready", count: next.length, error: null });
    } catch (err) {
      setState({ status: "error", count: 0, error: String(err) });
    } finally {
      buildingRef.current = false;
    }
  }, [indexes]);

  const hits = useMemo(
    () => searchTranscripts(indexes, query),
    [indexes, query],
  );
  const groups = useMemo(() => groupHits(hits), [hits]);

  return { state, query, setQuery, build, hits, groups } as {
    state: SearchState; query: string; setQuery: (q: string) => void;
    build: () => Promise<void>; hits: SearchHit[];
    groups: { path: string; title: string; hits: SearchHit[] }[];
  };
}
