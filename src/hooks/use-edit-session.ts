import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EditDocument } from "../bindings/EditDocument";
import type { EditHead } from "../bindings/EditHead";
import type { EditHistory } from "../bindings/EditHistory";
import { fromDocument, toDocument, type OpenEdit, type TimelineMarker } from "../lib/edit-document";
import type { Timeline } from "../lib/edit-model";
import { editStore } from "../lib/edit-store";
import { formatError } from "../lib/error-format";

/** What a change produces: a new model state, new markers, or a new frame (sources and lanes). */
export type EditChange = { timeline?: Timeline; markers?: TimelineMarker[]; document?: EditDocument } | null;

/**
 * The open edit, as the undo log holds it. Every change is a round trip to the
 * log (src-tauri/src/edit_log.rs), which answers with the new head, so what
 * the editor shows is always something the history contains. Operations run
 * one at a time in the order they were asked for; a second ⌘Z pressed before
 * the first returns waits for it rather than racing it.
 */
export function useEditSession(editId: string | null) {
  const [head, setHead] = useState<EditHead | null>(null);
  const [history, setHistory] = useState<EditHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const current = useRef<{ id: string | null; head: EditHead | null }>({ id: editId, head });
  current.current = { id: editId, head };

  const refreshHistory = useCallback((id: string) => editStore.history(id).then((next) => {
    if (current.current.id === id) setHistory(next);
  }), []);

  // One at a time, in order. A failure reports and leaves the head as it was.
  // Resolves true only when the log took a new head, so a caller can tell a
  // step that happened from one that failed or had nothing to do.
  const run = useCallback((work: (id: string) => Promise<EditHead | null>): Promise<boolean> => {
    const id = current.current.id;
    if (!id) return Promise.resolve(false);
    const next = queue.current.then(async () => {
      try {
        const result = await work(id);
        if (result && current.current.id === id) { setHead(result); setError(null); await refreshHistory(id); }
        return !!result;
      } catch (cause) {
        if (current.current.id === id) setError(formatError(cause));
        return false;
      }
    });
    queue.current = next;
    return next;
  }, [refreshHistory]);

  useEffect(() => {
    setHead(null); setHistory(null); setError(null);
    if (editId) void run(() => editStore.head(editId));
  }, [editId, run]);

  const open: OpenEdit | null = useMemo(() => head ? fromDocument(head.document) : null, [head]);

  /** Apply a change to the CURRENT head (not the one this render saw) and record it. */
  const commit = useCallback((label: string, change: (open: OpenEdit) => EditChange, group: string | null = null) => run(async (id) => {
    const latest = current.current.head;
    if (!latest) return null;
    const state = fromDocument(latest.document);
    const result = change(state);
    if (!result) return null;
    const document = toDocument(result.document ?? latest.document, result.timeline ?? state.timeline, result.markers ?? state.markers);
    return editStore.commit(id, label, document, group);
  }), [run]);

  return {
    head, open, history, error,
    commit,
    undo: useCallback(() => run((id) => editStore.undo(id)), [run]),
    redo: useCallback(() => run((id) => editStore.redo(id)), [run]),
    jump: useCallback((state: number) => run((id) => editStore.jump(id, state)), [run]),
    pin: useCallback((state: number, name: string | null) => run(async (id) => { await editStore.pin(id, state, name); await refreshHistory(id); return null; }), [run, refreshHistory]),
  };
}
