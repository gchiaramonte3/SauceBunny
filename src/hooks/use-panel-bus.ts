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
  /** True when a media source is loaded — gates the transcript empty-state's
   *  "Generate transcript" button in the popped-out panel. */
  hasSource: boolean;
  /** AI Summary: chosen model + output style, mirrored so the popped-out
   *  panel's AI tab uses the same model/style as the docked view. */
  aiModelId: string;
  aiStyle: {
    format: "bullets" | "numbered" | "prose";
    length: "brief" | "standard" | "detailed";
  };
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
  /** Panel edited a cue in place (the panel writes the file itself) — main
   *  bumps the arrived tick so captions / AI summary / speaker lanes re-read. */
  onTranscriptEdited: () => void;
  /** Panel asked to manage AI models — main opens Settings → AI Summary. */
  onOpenAiSettings: () => void;
};

/** Shared key the main window writes the live snapshot to and the popped-out
 *  panel reads. localStorage is shared across same-origin webviews, which makes
 *  it a reliable channel even when cross-window Tauri events don't arrive. */
export const PANEL_SNAPSHOT_KEY = "saucebunny.panelSnapshot";

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
  hasSource: false,
  aiModelId: "qwen3-4b-instruct",
  aiStyle: { format: "bullets", length: "standard" },
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

  // Authoritative cross-window channel: mirror the snapshot to localStorage so
  // the popped-out panel (a separate same-origin webview) can READ it directly
  // — Tauri events to that window proved unreliable (it kept rendering the
  // initial empty snapshot). Throttled with a leading timer so the per-frame
  // playhead doesn't hammer storage; the timer always flushes the LATEST.
  const lsTimer = useRef<number | null>(null);
  useEffect(() => {
    if (lsTimer.current != null) return;
    lsTimer.current = window.setTimeout(() => {
      lsTimer.current = null;
      try { localStorage.setItem(PANEL_SNAPSHOT_KEY, JSON.stringify(snapshotRef.current)); } catch { /* quota */ }
    }, 120);
  }, [snapshot]);

  // Just popped out: the brand-new panel webview may not have its
  // `panel:state` listener wired when the emit above fires, so its
  // `panel:request-state` is the only thing that delivers the initial
  // snapshot — and if THAT races too, the window renders empty. Re-push a few
  // times over the first ~600ms so a fresh window reliably gets populated.
  useEffect(() => {
    if (!panelDetached) return;
    const timers = [120, 350, 650].map((ms) =>
      window.setTimeout(() => { void emit("panel:state", snapshotRef.current); }, ms),
    );
    return () => { timers.forEach((t) => window.clearTimeout(t)); };
  }, [panelDetached]);

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
        listen("panel:action:transcriptEdited",
          () => handlersRef.current.onTranscriptEdited()),
        listen("panel:action:openAiSettings",
          () => handlersRef.current.onOpenAiSettings()),
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
