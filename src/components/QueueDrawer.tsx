import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  IconStack, IconReveal, IconTrash, IconCheck, IconAlert, IconSparkles,
} from "./Icons";
import type { QueuedClip } from "../types";
import { secondsToHms } from "../lib/timecode";
import { TranscriptViewer } from "./TranscriptViewer";
import type { TranscriptHistoryEntry } from "../lib/transcript-history";

/**
 * Tab system for the right-docked panel. Adding a new tab is one row
 * in the TABS array + one body case below. We deliberately avoid
 * shipping "Soon" placeholder tabs (UI bloat).
 */
type TabId = "queue" | "transcript";
type TabDef = {
  id: TabId;
  label: string;
  icon: (props: { size?: number; stroke?: string }) => React.ReactElement;
  badge?: number;
  /** Tiny dot next to the icon — used to signal "new content arrived". */
  pulse?: boolean;
  disabled?: boolean;
};

type Props = {
  open: boolean;
  onClose: () => void;
  queue: QueuedClip[];
  fps: number;
  running: boolean;
  hasFolder: boolean;
  onRemove: (id: string) => void;
  onClearAll: () => void;
  onExportAll: () => void;
  onStop: () => void;
  /** Path to the currently-loaded transcript SRT, or null. */
  transcriptPath: string | null;
  /** Where the transcript came from — drives the origin badge. */
  transcriptOrigin: "captions" | "whisper" | "unknown";
  /** Playhead seconds for the karaoke highlight, or null. */
  transcriptPlayhead: number | null;
  /** Click-to-seek callback — receives seconds. */
  onTranscriptSeek: (seconds: number) => void;
  /**
   * Monotonic counter that bumps each time a fresh transcript lands.
   * When this changes we auto-switch to the Transcript tab so the user
   * doesn't have to hunt for the result of the action they just took.
   */
  transcriptArrivedTick: number;
  /** Dismiss the active transcript (App clears the path). */
  onClearTranscript: () => void;
  /** Load a previous transcript (from the History popover). */
  onLoadFromHistory: (entry: TranscriptHistoryEntry) => void;
  /** Re-run transcription against the loaded source (current Settings). */
  onRegenerateTranscript: () => void;
  /** True while the regenerate run is in flight. */
  regenerateBusy: boolean;
  /** True if there's a source loaded that we COULD regenerate against. */
  canRegenerate: boolean;
  /** Open a .srt / .vtt from disk (file picker). */
  onImportTranscript: () => void;
  /**
   * Pop the drawer out into its own native OS window (r44.B). When
   * undefined, the pop-out button doesn't render — the floating window
   * itself sets this to undefined so it can't infinitely pop-itself-out.
   */
  onPopOut?: () => void;
  /**
   * True when rendering inside the floating window. Disables the resize
   * handle (the OS window IS the size), ignores the persisted drawer
   * width (always fills its parent), and removes the close button's
   * "hide panel" affordance — close in floating mode means "close the
   * OS window", which is bound to the drawer's × button explicitly by
   * PanelApp.
   */
  embedded?: boolean;
};

function statusLabel(s: QueuedClip["status"]): string {
  switch (s) {
    case "queued":  return "Queued";
    case "running": return "Exporting…";
    case "done":    return "Done";
    case "error":   return "Failed";
  }
}

// Drawer width persistence — kept here rather than App.tsx because the
// drawer owns the resize gesture and the width is purely presentation
// state (nothing else in the app cares how wide it is).
const DRAWER_WIDTH_KEY = "saucebunny.queueDrawerWidth";
const TAB_ORDER_KEY    = "saucebunny.queueDrawerTabOrder";
const DRAWER_WIDTH_MIN = 280;
const DRAWER_WIDTH_MAX = 720;
const DRAWER_WIDTH_DEFAULT = 360;

function loadDrawerWidth(): number {
  try {
    const raw = localStorage.getItem(DRAWER_WIDTH_KEY);
    if (!raw) return DRAWER_WIDTH_DEFAULT;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return DRAWER_WIDTH_DEFAULT;
    return Math.max(DRAWER_WIDTH_MIN, Math.min(DRAWER_WIDTH_MAX, n));
  } catch { return DRAWER_WIDTH_DEFAULT; }
}

export function QueueDrawer({
  open, onClose, queue, fps, running, hasFolder,
  onRemove, onClearAll, onExportAll, onStop,
  transcriptPath, transcriptOrigin, transcriptPlayhead,
  onTranscriptSeek, transcriptArrivedTick,
  onClearTranscript, onLoadFromHistory,
  onRegenerateTranscript, regenerateBusy, canRegenerate,
  onImportTranscript,
  onPopOut, embedded = false,
}: Props) {
  const counts = queue.reduce(
    (acc, c) => ((acc[c.status] = (acc[c.status] ?? 0) + 1), acc),
    {} as Record<QueuedClip["status"], number>
  );

  // ── Resizable drawer ─────────────────────────────────────────────
  // Drag the 4px handle on the left edge to widen/narrow. Width
  // persists across sessions via localStorage. While dragging we set
  // a body-class so global cursors and pointer-events apply uniformly
  // (without that, hovering over an <iframe> would interrupt the drag).
  const [drawerWidth, setDrawerWidth] = useState<number>(loadDrawerWidth);
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const onResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    dragStateRef.current = { startX: e.clientX, startWidth: drawerWidth };
    document.body.classList.add("cp-resizing-drawer");
    function onMove(ev: MouseEvent) {
      const st = dragStateRef.current;
      if (!st) return;
      // Drawer grows when you drag LEFT (toward the canvas) and shrinks
      // when you drag right — opposite of the cursor delta sign.
      const dx = st.startX - ev.clientX;
      const next = Math.max(
        DRAWER_WIDTH_MIN,
        Math.min(DRAWER_WIDTH_MAX, st.startWidth + dx),
      );
      setDrawerWidth(next);
    }
    function onUp() {
      const st = dragStateRef.current;
      dragStateRef.current = null;
      document.body.classList.remove("cp-resizing-drawer");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      // Commit to localStorage once on release rather than on every
      // mousemove tick — saves dozens of writes during a typical drag.
      if (st) {
        try { localStorage.setItem(DRAWER_WIDTH_KEY, String(loadDrawerWidth())); } catch { /* quota */ }
      }
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };
  // Persist whenever width settles (after a re-render).
  useEffect(() => {
    try { localStorage.setItem(DRAWER_WIDTH_KEY, String(drawerWidth)); } catch { /* quota */ }
  }, [drawerWidth]);
  const queuedCount = counts.queued ?? 0;
  const doneCount = counts.done ?? 0;
  const errorCount = counts.error ?? 0;

  const [activeTab, setActiveTab] = useState<TabId>("queue");
  // Pulse the Transcript tab title when a NEW transcript arrives but
  // the user is looking at another tab — drops the moment they switch in.
  const [transcriptUnread, setTranscriptUnread] = useState(false);
  useEffect(() => {
    if (transcriptArrivedTick === 0) return; // ignore the boot value
    if (activeTab !== "transcript") {
      setTranscriptUnread(true);
      // Also auto-switch when the panel is already open — the user
      // explicitly asked for that flow ("the result appears here").
      if (open) setActiveTab("transcript");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcriptArrivedTick]);
  useEffect(() => {
    if (activeTab === "transcript") setTranscriptUnread(false);
  }, [activeTab]);

  const TABS: TabDef[] = [
    { id: "queue", label: "Queue", icon: IconStack, badge: queue.length },
    { id: "transcript", label: "Transcript", icon: IconSparkles, pulse: transcriptUnread },
  ];

  // ── User-reorderable tab order ─────────────────────────────────
  // Drag a tab onto another to swap. Order persists per-machine via
  // localStorage; new tabs added in future TABS rows automatically
  // append to the end (we union the stored order with the current
  // TABS list so a code-level addition can't be hidden by a stale
  // localStorage entry).
  const [tabOrder, setTabOrderState] = useState<TabId[]>(() => {
    try {
      const raw = localStorage.getItem(TAB_ORDER_KEY);
      const stored: unknown = raw ? JSON.parse(raw) : null;
      if (Array.isArray(stored)) {
        const valid = stored.filter((x): x is TabId => x === "queue" || x === "transcript");
        const defaults: TabId[] = TABS.map((t) => t.id);
        // Drop any stored ids that no longer exist + append any
        // brand-new tab ids that weren't in storage.
        const merged: TabId[] = [];
        for (const id of valid)    if (defaults.includes(id) && !merged.includes(id)) merged.push(id);
        for (const id of defaults) if (!merged.includes(id)) merged.push(id);
        return merged;
      }
    } catch { /* fall through */ }
    return TABS.map((t) => t.id);
  });
  const setTabOrder = (next: TabId[]) => {
    setTabOrderState(next);
    try { localStorage.setItem(TAB_ORDER_KEY, JSON.stringify(next)); } catch { /* quota */ }
  };
  // Render order = persisted order, with tab defs looked up by id so
  // a stale order entry can't show wrong props.
  const orderedTabs: TabDef[] = tabOrder
    .map((id) => TABS.find((t) => t.id === id))
    .filter((t): t is TabDef => !!t);

  // ── Pointer-based drag with FLIP-style live shift (r44.A) ───────
  // Replaces the HTML5 drag-and-drop implementation, which only updated
  // on drop. Zoom's chat does it this way: the dragged tab follows the
  // cursor, the other tabs slide out of the way in real time, and the
  // drop position is committed without a flash on release.
  //
  // Mechanics:
  //   1. pointerdown on a tab measures every tab's bounding rect and
  //      stores them in a ref (cheap — there are only 2-3 tabs).
  //   2. setPointerCapture routes all subsequent move/up to the same
  //      element, so dragging past the strip edges doesn't drop the
  //      gesture mid-stride.
  //   3. pointermove derives:
  //        - deltaX: how far the cursor has travelled (applied as the
  //          dragged tab's transform, no transition so it tracks 1:1).
  //        - dropIdx: the slot the cursor is currently over (used to
  //          shift the OTHER tabs left/right by one slot via CSS
  //          transition).
  //   4. pointerup commits the new order via splice and clears the
  //      transient state — React re-renders with the new tabOrder and
  //      the CSS transitions handle the final settle.
  const tabStripRef = useRef<HTMLDivElement>(null);
  type DragRef = {
    tabId: TabId;
    pointerId: number;
    srcIdx: number;
    dropIdx: number;
    /** Cached rects for every tab AT THE START of the drag. */
    rects: { id: TabId; left: number; width: number }[];
    startClientX: number;
  };
  const dragRef = useRef<DragRef | null>(null);
  // Mirror of dragRef for rendering — refs don't trigger re-render.
  // We only update this on state changes that should reflect in the DOM
  // (deltaX, dropIdx).
  const [drag, setDrag] = useState<{ tabId: TabId; deltaX: number; srcIdx: number; dropIdx: number } | null>(null);

  function onTabPointerDown(e: React.PointerEvent<HTMLButtonElement>, tabId: TabId, idx: number) {
    if (e.button !== 0) return;
    const t = orderedTabs[idx];
    if (t?.disabled) return;
    const strip = tabStripRef.current;
    if (!strip) return;
    // Measure once. The drag handlers all read from this snapshot so
    // that mid-drag re-renders (which shift the live DOM rects) don't
    // confuse the hit-test math.
    const tabEls = strip.querySelectorAll<HTMLElement>(".cp-tab");
    const rects = orderedTabs.map((t, i) => {
      const r = tabEls[i].getBoundingClientRect();
      return { id: t.id, left: r.left, width: r.width };
    });
    dragRef.current = {
      tabId,
      pointerId: e.pointerId,
      srcIdx: idx,
      dropIdx: idx,
      rects,
      startClientX: e.clientX,
    };
    setDrag({ tabId, deltaX: 0, srcIdx: idx, dropIdx: idx });
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* not all targets capture */ }
    document.body.classList.add("cp-tab-dragging");
  }

  function onTabPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const deltaX = e.clientX - d.startClientX;
    // Figure out which slot the dragged tab's CENTER is over. Walk left
    // and right from src; pick the furthest slot whose center we've
    // crossed past.
    const srcRect = d.rects[d.srcIdx];
    const draggedCenter = srcRect.left + srcRect.width / 2 + deltaX;
    let dropIdx = d.srcIdx;
    // Going left
    for (let i = d.srcIdx - 1; i >= 0; i--) {
      const r = d.rects[i];
      if (draggedCenter < r.left + r.width / 2) dropIdx = i;
      else break;
    }
    // Going right
    if (dropIdx === d.srcIdx) {
      for (let i = d.srcIdx + 1; i < d.rects.length; i++) {
        const r = d.rects[i];
        if (draggedCenter > r.left + r.width / 2) dropIdx = i;
        else break;
      }
    }
    d.dropIdx = dropIdx;
    setDrag({ tabId: d.tabId, deltaX, srcIdx: d.srcIdx, dropIdx });
  }

  function onTabPointerUp(e: React.PointerEvent<HTMLButtonElement>) {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const { srcIdx, dropIdx } = d;
    dragRef.current = null;
    setDrag(null);
    document.body.classList.remove("cp-tab-dragging");
    if (dropIdx !== srcIdx) {
      const next = [...tabOrder];
      const [moved] = next.splice(srcIdx, 1);
      next.splice(dropIdx, 0, moved);
      setTabOrder(next);
    }
  }

  /**
   * Per-tab transform for the live-shift effect. Called inline in the
   * render loop.
   *
   *   - The dragged tab moves by deltaX with no transition (1:1 follow).
   *   - Other tabs in the affected range shift by ±srcWidth with a
   *     transition (smooth slide).
   *   - All other tabs stay put with the same transition so they
   *     animate back to 0 when the drag pivot crosses them.
   */
  function tabTransformStyle(idx: number): React.CSSProperties {
    if (!drag) return { transform: "translateX(0)", transition: "transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1)" };
    if (idx === drag.srcIdx) {
      return {
        transform: `translateX(${drag.deltaX}px)`,
        transition: "none",
        zIndex: 2,
      };
    }
    const srcRect = dragRef.current?.rects[drag.srcIdx];
    if (!srcRect) return {};
    let shift = 0;
    if (drag.srcIdx < drag.dropIdx && idx > drag.srcIdx && idx <= drag.dropIdx) {
      shift = -srcRect.width;
    } else if (drag.srcIdx > drag.dropIdx && idx >= drag.dropIdx && idx < drag.srcIdx) {
      shift = srcRect.width;
    }
    return {
      transform: `translateX(${shift}px)`,
      transition: "transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1)",
    };
  }

  return (
    <aside
      className={"cp-queue-drawer" + (open ? " open" : "") + (embedded ? " embedded" : "")}
      aria-hidden={!open}
      // Inline width only when docked + open. In embedded (floating) mode
      // the parent layout dictates size — let it fill the OS window.
      style={!embedded && open ? { width: drawerWidth } : undefined}
    >
      {/* Drag handle — 4px wide strip on the left edge. Pointer-events
          off when closed so it can't catch clicks meant for the canvas.
          Hidden in embedded mode (the OS window itself is the resize
          handle in that case). */}
      {open && !embedded && (
        <div
          className="cp-queue-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize transcript panel"
          onMouseDown={onResizeMouseDown}
          // Double-click resets to default width — a small kindness
          // for anyone who drags the drawer to a useless size.
          onDoubleClick={() => setDrawerWidth(DRAWER_WIDTH_DEFAULT)}
          title="Drag to resize · double-click to reset"
        />
      )}
      {/* Tab strip — single-source-of-truth iteration over TABS so a new
          tab is one row of config + one case in the body switch below.
          Disabled tabs render with a "Soon" pill so the user can see the
          system in advance of the features shipping. */}
      <div className="cp-queue-head" role="tablist" aria-label="Right panel sections" ref={tabStripRef}>
        {orderedTabs.map((t, idx) => {
          const Icon = t.icon;
          const isActive = activeTab === t.id && !t.disabled;
          const isDragSrc = drag?.tabId === t.id;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={isActive}
              aria-disabled={t.disabled}
              className={
                "cp-tab" +
                (isActive ? " active" : "") +
                (t.disabled ? " disabled" : "") +
                (isDragSrc ? " dragging" : "")
              }
              style={tabTransformStyle(idx)}
              /* Click only fires when there was no drag (default browser
                 behaviour — pointerdown/up at ~0 delta still emits
                 click). If the drag moved the tab, the click target is
                 still where pointerup landed, so we treat any same-tab
                 release as a click and any cross-tab release as a reorder
                 (handled in pointerup). */
              onClick={() => { if (!t.disabled && (!drag || drag.srcIdx === drag.dropIdx)) setActiveTab(t.id); }}
              title={t.disabled ? `${t.label} — coming soon` : `${t.label} · drag to reorder`}
              onPointerDown={(e) => onTabPointerDown(e, t.id, idx)}
              onPointerMove={onTabPointerMove}
              onPointerUp={onTabPointerUp}
              onPointerCancel={onTabPointerUp}
            >
              <Icon size={13} stroke={isActive ? "var(--color-accent-green)" : "var(--fg-3)"} />
              <span>{t.label}</span>
              {t.badge != null && t.badge > 0 && (
                <span className="cp-tab-badge">{t.badge}</span>
              )}
              {t.pulse && <span className="cp-tab-pulse" aria-label="new content" />}
              {t.disabled && <span className="cp-tab-soon">Soon</span>}
            </button>
          );
        })}
        <div className="cp-tab-filler" />
        {/* Pop-out — opens the side panel in its own native OS window
            (r44.B). Hidden when this drawer IS the floating window
            (would just stack windows endlessly). */}
        {!embedded && onPopOut && (
          <button
            type="button"
            className="cp-tab-close cp-tab-popout"
            onClick={onPopOut}
            title="Pop out into its own window"
            aria-label="Pop out"
          >
            {/* Diagonal-arrow glyph: ⤢ Unicode would work but the
                outlined SVG matches the visual weight of the other
                tab-strip icons. */}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          </button>
        )}
        <button
          type="button"
          className="cp-tab-close"
          onClick={onClose}
          title={embedded ? "Close panel window" : "Hide panel"}
          aria-label={embedded ? "Close panel window" : "Hide panel"}
        >
          ×
        </button>
      </div>

      {/* Active-tab body. Add a case here when wiring a new tab. */}
      {activeTab === "queue" && (
        <>
        {/* === existing queue body kept untouched below === */}

      <div className="cp-queue-list">
        {queue.length === 0 ? (
          <div className="cp-queue-empty">
            <IconStack size={28} stroke="var(--fg-5)" />
            <div className="cp-queue-empty-title">No clips queued</div>
            <div className="cp-queue-empty-body">
              Mark a section in the timeline, then click <strong>+ Add to queue</strong> in the sidebar.
              Repeat for as many sections as you need, then export them all at once.
            </div>
          </div>
        ) : queue.map((c, i) => {
          // Compact display — HH:MM:SS only (drop frames) so the meta line
          // never wraps inside the 340px drawer.
          const r = Math.max(1, Math.round(fps));
          const inS  = c.inFrames  / r;
          const outS = c.outFrames / r;
          const durS = Math.max(0, outS - inS);
          const inTc  = secondsToHms(inS);
          const outTc = secondsToHms(outS);
          const dur   = secondsToHms(durS);
          const Icon = c.status === "done" ? IconCheck : c.status === "error" ? IconAlert : null;
          return (
            <div key={c.id} className={"cp-queue-item " + c.status}>
              <div className="cp-queue-num">{i + 1}</div>
              <div className="cp-queue-body">
                <div className="cp-queue-row">
                  <div className="cp-queue-name" title={c.filename}>{c.filename}</div>
                  <div className={"cp-queue-status " + c.status}>
                    {Icon ? <Icon size={11} /> : null}
                    <span>{statusLabel(c.status)}</span>
                  </div>
                </div>
                <div className="cp-queue-meta">
                  <span className="tc">{inTc}</span>
                  <span className="arrow">→</span>
                  <span className="tc">{outTc}</span>
                  <span className="sep">·</span>
                  <span className="dur">{dur}</span>
                  <span className="sep">·</span>
                  <span className="fmt">{c.format === "audio" ? "MP3" : c.format.toUpperCase()}</span>
                </div>
                {c.status === "error" && c.error && (
                  <div className="cp-queue-error">{c.error}</div>
                )}
              </div>
              <div className="cp-queue-actions">
                {c.status === "done" && c.path && (
                  <button
                    className="cp-queue-iconbtn"
                    title="Reveal in Finder"
                    onClick={() => invoke("reveal_in_finder", { path: c.path }).catch(() => {})}
                  >
                    <IconReveal size={13} />
                  </button>
                )}
                {c.status !== "running" && (
                  <button
                    className="cp-queue-iconbtn danger"
                    title="Remove from queue"
                    onClick={() => onRemove(c.id)}
                  >
                    <IconTrash size={13} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="cp-queue-foot">
        {(queuedCount > 0 || doneCount > 0 || errorCount > 0) && (
          <div className="cp-queue-summary">
            {queuedCount > 0 && <span>{queuedCount} queued</span>}
            {doneCount > 0 && <span className="ok">{doneCount} done</span>}
            {errorCount > 0 && <span className="err">{errorCount} failed</span>}
          </div>
        )}
        <div className="cp-queue-foot-row">
          <button
            className="btn btn-ghost"
            onClick={onClearAll}
            disabled={queue.length === 0 || running}
          >
            Clear all
          </button>
          {running ? (
            <button className="btn cp-queue-stop" onClick={onStop}>
              Stop
            </button>
          ) : (
            <button
              className="btn btn-primary cp-queue-export"
              onClick={onExportAll}
              disabled={queuedCount === 0 || !hasFolder}
              title={!hasFolder ? "Choose an output folder in the sidebar first" : undefined}
            >
              Export {queuedCount} {queuedCount === 1 ? "clip" : "clips"}
            </button>
          )}
        </div>
      </div>
      </>
      )}
      {activeTab === "transcript" && (
        <TranscriptViewer
          path={transcriptPath}
          playheadSeconds={transcriptPlayhead}
          onSeek={onTranscriptSeek}
          origin={transcriptOrigin}
          onClearTranscript={onClearTranscript}
          onLoadFromHistory={onLoadFromHistory}
          onRegenerate={onRegenerateTranscript}
          regenerateBusy={regenerateBusy}
          canRegenerate={canRegenerate}
          onImportTranscript={onImportTranscript}
        />
      )}
    </aside>
  );
}
