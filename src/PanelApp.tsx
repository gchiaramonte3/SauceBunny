import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { QueueDrawer } from "./components/QueueDrawer";
import type { QueuedClip } from "./types";
import type { TranscriptHistoryEntry } from "./lib/transcript-history";

/**
 * PanelApp — the React root mounted when main.tsx detects
 * `?window=panel` in the URL. It renders just the right-docked queue/
 * transcript drawer inside a native OS window (spawned from Rust via
 * `open_panel_window`).
 *
 * The component is intentionally state-light: every prop the
 * QueueDrawer needs is mirrored from `panel:state` events emitted by
 * the main window. User interactions (seek, remove from queue, etc.)
 * are sent back as `panel:action:<kind>` events; main routes them
 * into the same handler functions the docked drawer uses.
 *
 * Lifecycle:
 *   - On mount, emit `panel:request-state` so main pushes a fresh
 *     snapshot immediately (otherwise we'd render empty until the
 *     next state change in main).
 *   - On unmount (window destroyed), Rust fires `panel:closed` to
 *     main — handled there to re-show the docked drawer.
 */

type PanelState = {
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

const INITIAL: PanelState = {
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

type ActionKind =
  | "remove"
  | "clearAll"
  | "exportAll"
  | "stop"
  | "seek"
  | "clearTranscript"
  | "loadFromHistory"
  | "regenerate"
  | "importTranscript";

function sendAction(kind: ActionKind, payload?: unknown) {
  // Fire-and-forget: main subscribes once at startup and we don't need
  // a response. Errors here would mean main isn't listening (window
  // closed), which is a moot point — we're about to be destroyed too.
  void emit(`panel:action:${kind}`, payload ?? null);
}

export default function PanelApp() {
  const [state, setState] = useState<PanelState>(INITIAL);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const off = await listen<PanelState>("panel:state", (e) => {
        if (cancelled) return;
        setState(e.payload);
      });
      if (cancelled) { off(); return; }
      unlisten = off;
      // Tell main "I'm alive, send me current state." Main rebroadcasts
      // its last computed snapshot in response (cheap — it already has
      // the values in scope from the effect that emits state on change).
      void emit("panel:request-state");
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return (
    <div className="cp-panel-window-root">
      <QueueDrawer
        // Always open in the floating window — there's no "close panel"
        // affordance inside the panel itself (only "close window").
        open
        embedded
        onClose={() => { void invoke("close_panel_window"); }}
        queue={state.queue}
        fps={state.fps}
        running={state.running}
        hasFolder={state.hasFolder}
        onRemove={(id) => sendAction("remove", { id })}
        onClearAll={() => sendAction("clearAll")}
        onExportAll={() => sendAction("exportAll")}
        onStop={() => sendAction("stop")}
        transcriptPath={state.transcriptPath}
        transcriptOrigin={state.transcriptOrigin}
        transcriptPlayhead={state.transcriptPlayhead}
        onTranscriptSeek={(seconds) => sendAction("seek", { seconds })}
        transcriptArrivedTick={state.transcriptArrivedTick}
        onClearTranscript={() => sendAction("clearTranscript")}
        onLoadFromHistory={(entry: TranscriptHistoryEntry) => sendAction("loadFromHistory", { entry })}
        onRegenerateTranscript={() => sendAction("regenerate")}
        regenerateBusy={state.regenerateBusy}
        canRegenerate={state.canRegenerate}
        onImportTranscript={() => sendAction("importTranscript")}
        /* `onPopOut` intentionally undefined — the pop-out button
           shouldn't appear inside the popped-out window. */
      />
    </div>
  );
}
