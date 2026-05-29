import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit, type UnlistenFn } from "@tauri-apps/api/event";
import type { QueuedClip } from "../types";
import type { TranscriptHistoryEntry } from "../lib/transcript-history";

/**
 * Cross-window state-sync bridge for the floating side-panel (r44.B).
 * Extracted from App.tsx in r52 — App.tsx was 3035 lines and this was
 * one of the largest self-contained blocks.
 *
 * Architecture:
 *   - main → panel:  emits `panel:state` whenever the snapshot changes.
 *   - panel → main:  fires `panel:action:<kind>` for each user action.
 *   - rust → main:   fires `panel:closed` / `panel:popped-out` to flip
 *                    the `panelDetached` state.
 *
 * Handlers come in via a ref so the listeners can be registered ONCE
 * at mount and pick up handler-identity changes without re-binding.
 *
 * Consumer pattern:
 * ```ts
 * const { handlePopOut, panelDetached, setPanelDetached } = usePanelBus({
 *   queueOpen, setQueueOpen,
 *   snapshot: { queue, fps, ... },          // computed every render
 *   handlers: { onRemove, onSeek, ... },    // fresh each render
 * });
 * ```
 */

export type PanelSnapshot = {
  queue: QueuedClip[];
  fps: number;
  running: boolean;
  hasFolder: boolean;
  transcriptPath: string | null;
  transcriptOrigin: "captions" | "whisper" | "unknown";
  transcriptPlayhead: number | null;
  transcriptArrivedTick: number;
  regenerateBusy: boolean;
  canRegenerate: boolean;
};

export type PanelHandlers = {
  onRemove: (id: string) => void;
  onClearAll: () => void;
  onExportAll: () => void;
  onStop: () => void;
  onSeek: (seconds: number) => void;
  onClearTranscript: () => void;
  onLoadFromHistory: (entry: TranscriptHistoryEntry) => void;
  onRegenerate: () => void;
  onImportTranscript: () => void;
};

const INITIAL_SNAPSHOT: PanelSnapshot = {
  queue: [],
  fps: 30,
  running: false,
  hasFolder: false,
  transcriptPath: null,
  transcriptOrigin: "unknown",
  transcriptPlayhead: null,
  transcriptArrivedTick: 0,
  regenerateBusy: false,
  canRegenerate: false,
};

type Args = {
  panelDetached: boolean;
  setPanelDetached: (v: boolean) => void;
  setQueueOpen: (v: boolean) => void;
  snapshot: PanelSnapshot;
  handlers: PanelHandlers;
};

export function usePanelBus({
  panelDetached, setPanelDetached, setQueueOpen,
  snapshot, handlers,
}: Args): { handlePopOut: () => void } {
  const snapshotRef = useRef<PanelSnapshot>(INITIAL_SNAPSHOT);
  const handlersRef = useRef<PanelHandlers>(handlers);

  // Push the current snapshot to the floating window whenever any
  // tracked piece of state changes. Also keep snapshotRef fresh for
  // the `panel:request-state` reply path. The single coalesced effect
  // (vs per-field events) keeps the payload small + the wire simple.
  useEffect(() => {
    snapshotRef.current = snapshot;
    if (!panelDetached) return;
    void emit("panel:state", snapshot);
  }, [panelDetached, snapshot]);

  // Pin latest handlers into the ref so the listeners (registered
  // once below) always invoke fresh closures. Single ref assignment
  // per render — cheap.
  useEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);

  // Register cross-window listeners ONCE at mount. Subsequent state
  // changes flow through the refs so the listeners never tear down +
  // recreate (which would race with in-flight events).
  useEffect(() => {
    let unlistens: UnlistenFn[] = [];
    let cancelled = false;
    (async () => {
      const off = await Promise.all([
        listen("panel:closed", () => {
          setPanelDetached(false);
          // Re-open the docked drawer so the user immediately sees the
          // panel come back. Without this it would silently re-mount
          // closed, which feels like the close did nothing in main.
          setQueueOpen(true);
        }),
        listen("panel:popped-out", () => {
          setPanelDetached(true);
          setQueueOpen(false);
        }),
        listen("panel:request-state", () => {
          // Floating window just mounted — re-emit our last snapshot.
          void emit("panel:state", snapshotRef.current);
        }),
        listen<{ id: string }>("panel:action:remove",
          (e) => handlersRef.current.onRemove(e.payload.id)),
        listen("panel:action:clearAll",
          () => handlersRef.current.onClearAll()),
        listen("panel:action:exportAll",
          () => handlersRef.current.onExportAll()),
        listen("panel:action:stop",
          () => handlersRef.current.onStop()),
        listen<{ seconds: number }>("panel:action:seek",
          (e) => handlersRef.current.onSeek(e.payload.seconds)),
        listen("panel:action:clearTranscript",
          () => handlersRef.current.onClearTranscript()),
        listen<{ entry: TranscriptHistoryEntry }>("panel:action:loadFromHistory",
          (e) => handlersRef.current.onLoadFromHistory(e.payload.entry)),
        listen("panel:action:regenerate",
          () => handlersRef.current.onRegenerate()),
        listen("panel:action:importTranscript",
          () => handlersRef.current.onImportTranscript()),
      ]);
      if (cancelled) { off.forEach((u) => u()); return; }
      unlistens = off;
    })();
    return () => { cancelled = true; unlistens.forEach((u) => u()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePopOut = useCallback(() => {
    // Optimistic: hide the docked drawer immediately so there's no
    // moment of "both visible". Rust will also fire `panel:popped-out`
    // shortly which idempotently sets the same state.
    setPanelDetached(true);
    setQueueOpen(false);
    invoke("open_panel_window").catch((e) => {
      console.error("open_panel_window failed:", e);
      setPanelDetached(false);
      setQueueOpen(true);
    });
  }, [setPanelDetached, setQueueOpen]);

  return { handlePopOut };
}
