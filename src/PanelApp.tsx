import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { QueueDrawer } from "./components/QueueDrawer";
import { PANEL_SNAPSHOT_KEY } from "./hooks/use-panel-bus";
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
  hasSource: boolean;
  aiModelId: string;
  aiStyle: {
    format: "bullets" | "numbered" | "prose";
    length: "brief" | "standard" | "detailed";
  };
  chapterSourceKey: string | null;
  durationSec: number | null;
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
  hasSource: false,
  aiModelId: "qwen3-4b-instruct",
  aiStyle: { format: "bullets", length: "standard" },
  chapterSourceKey: null,
  durationSec: null,
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
  | "importTranscript"
  | "transcriptEdited"
  | "openAiSettings"
  | "chaptersChanged";

function sendAction(kind: ActionKind, payload?: unknown) {
  // Fire-and-forget: main subscribes once at startup and we don't need
  // a response. Errors here would mean main isn't listening (window
  // closed), which is a moot point — we're about to be destroyed too.
  void emit(`panel:action:${kind}`, payload ?? null);
}

/** Read the mirrored snapshot synchronously. Seeding the FIRST render with the
 *  real state matters beyond avoiding a flash of empty panel: QueueDrawer's
 *  auto-switch seeds a ref with the mount-time `transcriptArrivedTick`, so if
 *  the first render carried INITIAL's tick 0 and the snapshot landed a beat
 *  later, the tick would "advance" and spuriously yank the panel to the
 *  Transcript tab on every pop-out. */
function readSnapshotSync(): { raw: string | null; state: PanelState } {
  try {
    const raw = localStorage.getItem(PANEL_SNAPSHOT_KEY);
    if (raw) return { raw, state: JSON.parse(raw) as PanelState };
  } catch { /* corrupt/unavailable — fall through to INITIAL */ }
  return { raw: null, state: INITIAL };
}

export default function PanelApp() {
  const [boot] = useState(readSnapshotSync);
  const [state, setState] = useState<PanelState>(boot.state);

  // PRIMARY channel: read the snapshot the main window mirrors to localStorage
  // (shared across same-origin webviews). Seeded synchronously above; then
  // re-read on the `storage` event + a slow poll backstop (in case WKWebView
  // doesn't fire cross-window storage events). This is what makes the
  // popped-out transcript actually populate and track main.
  const lastRawRef = useRef<string | null>(boot.raw);
  useEffect(() => {
    const read = () => {
      try {
        const raw = localStorage.getItem(PANEL_SNAPSHOT_KEY);
        if (raw && raw !== lastRawRef.current) {
          lastRawRef.current = raw;
          setState(JSON.parse(raw) as PanelState);
        }
      } catch { /* ignore parse/quota */ }
    };
    read();
    const onStorage = (e: StorageEvent) => { if (e.key === PANEL_SNAPSHOT_KEY) read(); };
    window.addEventListener("storage", onStorage);
    const poll = window.setInterval(read, 400);
    return () => { window.removeEventListener("storage", onStorage); window.clearInterval(poll); };
  }, []);

  // Secondary (fast-path) channel: Tauri events, if they arrive.
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
        transcriptFps={state.fps}
        onTranscriptSeek={(seconds) => sendAction("seek", { seconds })}
        transcriptArrivedTick={state.transcriptArrivedTick}
        onClearTranscript={() => sendAction("clearTranscript")}
        onLoadFromHistory={(entry: TranscriptHistoryEntry) => sendAction("loadFromHistory", { entry })}
        onRegenerateTranscript={() => sendAction("regenerate")}
        regenerateBusy={state.regenerateBusy}
        canRegenerate={state.canRegenerate}
        onImportTranscript={() => sendAction("importTranscript")}
        transcriptHasSource={state.hasSource}
        /* The panel's viewer writes the SRT itself (invoke works in any
           window); main only needs the tick bump so ITS readers re-read. */
        onTranscriptEdited={() => sendAction("transcriptEdited")}
        aiModelId={state.aiModelId}
        aiStyle={state.aiStyle}
        onOpenAiSettings={() => sendAction("openAiSettings")}
        /* Auto-chapters: the panel's AI tab saves to the SHARED localStorage
           itself; this action only tells main to re-read for its timeline. */
        chapterSourceKey={state.chapterSourceKey}
        chapterDurationSec={state.durationSec}
        onChaptersChanged={() => sendAction("chaptersChanged")}
        /* `onPopOut` intentionally undefined — the pop-out button
           shouldn't appear inside the popped-out window. */
      />
    </div>
  );
}
