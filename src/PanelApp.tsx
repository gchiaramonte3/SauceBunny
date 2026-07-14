import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { QueueDrawer } from "./components/QueueDrawer";
import { PANEL_SNAPSHOT_KEY, type PanelSnapshot } from "./hooks/use-panel-bus";
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
 *   - On mount, seed the first render synchronously from the localStorage
 *     mirror, register the `panel:state` listener, THEN emit
 *     `panel:request-state` — main replies with a fresh publish. Listener-
 *     before-request is what makes the handshake race-free (Tauri events
 *     are dropped, not queued, when no listener exists yet).
 *   - On unmount (window destroyed), Rust fires `panel:closed` to
 *     main — handled there to re-show the docked drawer.
 */

/** Mirror of the main window's published snapshot (single shared type). */
type PanelState = PanelSnapshot;

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

/** How long event silence must last before the reconciliation poll bothers
 *  reading the mirror. Also the poll period itself. */
const RECONCILE_MS = 5000;

export default function PanelApp() {
  const [boot] = useState(readSnapshotSync);
  const [state, setState] = useState<PanelState>(boot.state);

  // PRIMARY channel: `panel:state` Tauri events, pushed by main on every
  // actual state change (debounced ~50ms). The listener is registered before
  // `panel:request-state` goes out, so main's reply can't be dropped.
  const lastEventAtRef = useRef(0);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const off = await listen<PanelState>("panel:state", (e) => {
        if (cancelled) return;
        lastEventAtRef.current = Date.now();
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

  // SAFETY NET: a slow reconciliation poll against the localStorage mirror
  // (written by main on every publish). Only consulted after RECONCILE_MS of
  // event silence, so while events flow it does nothing; if they ever prove
  // flaky the panel converges within ~5s instead of freezing. getItem + string
  // compare — no JSON work unless the mirror actually advanced.
  const lastRawRef = useRef<string | null>(boot.raw);
  useEffect(() => {
    const reconcile = () => {
      if (Date.now() - lastEventAtRef.current < RECONCILE_MS) return;
      try {
        const raw = localStorage.getItem(PANEL_SNAPSHOT_KEY);
        if (raw && raw !== lastRawRef.current) {
          lastRawRef.current = raw;
          setState(JSON.parse(raw) as PanelState);
        }
      } catch { /* ignore parse/quota */ }
    };
    const poll = window.setInterval(reconcile, RECONCILE_MS);
    return () => window.clearInterval(poll);
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
