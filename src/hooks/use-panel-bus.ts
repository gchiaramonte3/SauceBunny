import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit, type UnlistenFn } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { QueuedClip } from "../types";
import type { TranscriptHistoryEntry } from "../lib/transcript-history";

/**
 * Cross-window state-sync bridge for the floating side-panel (r44.B).
 * Extracted from App.tsx in r52 — App.tsx was 3035 lines and this was
 * one of the largest self-contained blocks.
 *
 * Architecture:
 *   - main → panel:  emits `panel:state` when the snapshot CONTENT changes
 *                    (debounced ~50ms), and mirrors the same payload to
 *                    localStorage for the panel's boot seed + slow
 *                    reconciliation poll. Idle = zero emits, zero writes.
 *   - panel → main:  fires `panel:action:<kind>` for each user action,
 *                    plus `panel:request-state` on mount — main replies
 *                    with an immediate `panel:state` publish. The panel
 *                    registers its listener BEFORE requesting, and main's
 *                    reply listener lives from app start, so the handshake
 *                    can't race (Tauri events are fire-and-forget: anything
 *                    emitted before a webview's listener exists is dropped,
 *                    which is why a fresh panel must pull, not be pushed).
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
  /** Auto-chapters: source identity (main's reviewSourceKey) so the panel's
   *  AI tab persists chapters under the same key main's timeline reads. */
  chapterSourceKey: string | null;
  /** Auto-chapters: source duration in seconds (clamps model timestamps). */
  durationSec: number | null;
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
  /** Panel generated/deleted chapters (already saved to the shared
   *  localStorage) — main re-reads so its timeline markers update. */
  onChaptersChanged: () => void;
};

/** Shared key the main window mirrors the snapshot to on every publish.
 *  localStorage is shared across same-origin webviews; the panel uses it to
 *  seed its FIRST render synchronously (no flash of empty panel) and as the
 *  read target of its slow reconciliation poll. Written only when the
 *  snapshot content actually changed — never on a timer. */
export const PANEL_SNAPSHOT_KEY = "saucebunny.panelSnapshot";

/** Content equality for the publish gate — `queue` by reference (App only
 *  ever replaces it immutably), everything else by value. Runs on every App
 *  render, so it must stay allocation-free. Adding a field to PanelSnapshot?
 *  Compare it here too, or the panel won't hear about changes to it. */
export function panelSnapshotsEqual(a: PanelSnapshot, b: PanelSnapshot): boolean {
  return (
    a.queue === b.queue &&
    a.fps === b.fps &&
    a.running === b.running &&
    a.hasFolder === b.hasFolder &&
    a.transcriptPath === b.transcriptPath &&
    a.transcriptOrigin === b.transcriptOrigin &&
    a.transcriptPlayhead === b.transcriptPlayhead &&
    a.transcriptArrivedTick === b.transcriptArrivedTick &&
    a.regenerateBusy === b.regenerateBusy &&
    a.canRegenerate === b.canRegenerate &&
    a.hasSource === b.hasSource &&
    a.aiModelId === b.aiModelId &&
    a.aiStyle.format === b.aiStyle.format &&
    a.aiStyle.length === b.aiStyle.length &&
    a.chapterSourceKey === b.chapterSourceKey &&
    a.durationSec === b.durationSec
  );
}

/** Debounce window for change-driven publishes. Long enough to coalesce the
 *  per-frame playhead into ~20 events/sec while playing, short enough that a
 *  queue edit feels instant in the floating window. */
const PUBLISH_DEBOUNCE_MS = 50;

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
  chapterSourceKey: null,
  durationSec: null,
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

  // ── Change-driven publish ────────────────────────────────────────
  // One path pushes state to the floating window: when the snapshot CONTENT
  // changes (the object is rebuilt every App render, so identity is
  // meaningless), a trailing 50ms timer flushes the latest snapshot as a
  // `panel:state` event + a localStorage mirror write. At idle nothing is
  // serialized, emitted, or written — this replaced the always-on 120ms
  // localStorage timer + per-render emit + the panel's 400ms poll. Events
  // are the primary channel now: post-registration delivery is reliable in
  // Tauri 2.x (the historical "panel rendered empty" failures were the
  // fresh-webview mount race, which the request/response handshake removes);
  // the mirror stays as the panel's boot seed + 5s reconciliation backstop.
  const lastPublishedRef = useRef<PanelSnapshot | null>(null);
  const publishTimer = useRef<number | null>(null);

  // Write-then-emit so the mirror is never behind the event a consumer is
  // reacting to. Not debounced itself — callers gate it.
  const publishNow = useCallback(() => {
    if (publishTimer.current != null) {
      window.clearTimeout(publishTimer.current);
      publishTimer.current = null;
    }
    const snap = snapshotRef.current;
    lastPublishedRef.current = snap;
    try { localStorage.setItem(PANEL_SNAPSHOT_KEY, JSON.stringify(snap)); } catch { /* quota */ }
    void emit("panel:state", snap);
  }, []);

  useEffect(() => {
    snapshotRef.current = snapshot;
    if (!panelDetached) return;
    if (lastPublishedRef.current && panelSnapshotsEqual(lastPublishedRef.current, snapshot)) return;
    if (publishTimer.current != null) return; // flush already scheduled — it reads the ref
    publishTimer.current = window.setTimeout(() => {
      publishTimer.current = null;
      // Re-check: the snapshot may have settled back to the published value
      // within the debounce window (e.g. a transient render-only flip).
      if (lastPublishedRef.current && panelSnapshotsEqual(lastPublishedRef.current, snapshotRef.current)) return;
      publishNow();
    }, PUBLISH_DEBOUNCE_MS);
  }, [panelDetached, snapshot, publishNow]);

  // The panel window outlives a main-window reload (dev reload, crash
  // recovery): React state resets to docked and publishing would stop
  // forever while the floating window sits open and stale. Re-detect the
  // live panel once at mount and re-adopt it.
  useEffect(() => {
    let cancelled = false;
    void WebviewWindow.getByLabel("panel").then((w) => {
      if (cancelled || !w) return;
      setPanelDetached(true);
      setQueueOpen(false);
      publishNow();
    }).catch(() => { /* window enumeration unavailable — docked is the safe default */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          // Floating window just mounted — publish immediately (event +
          // mirror). This is the response half of the mount handshake.
          publishNow();
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
        listen("panel:action:chaptersChanged",
          () => handlersRef.current.onChaptersChanged()),
      ]);
      if (cancelled) { off.forEach((u) => u()); return; }
      unlistens = off;
    })();
    return () => {
      cancelled = true;
      unlistens.forEach((u) => u());
      if (publishTimer.current != null) {
        window.clearTimeout(publishTimer.current);
        publishTimer.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePopOut = useCallback(() => {
    // Seed the mirror synchronously BEFORE the window exists so the panel's
    // first render (which reads localStorage synchronously) shows current
    // state — the request/response handshake then confirms it via events.
    try { localStorage.setItem(PANEL_SNAPSHOT_KEY, JSON.stringify(snapshotRef.current)); } catch { /* quota */ }
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
