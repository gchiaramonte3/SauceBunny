import { useEffect, useRef, useState } from "react";
import { inertWhen } from "../lib/inert";
import { dropIndexAt, moveItem } from "../lib/reorder";
import { invoke } from "@tauri-apps/api/core";
import {
  IconAiSummary, IconAlert, IconCheck, IconRefresh, IconReveal, IconReview, IconStack, IconTranscript, IconTrash,
  IconChevronDown,
} from "./Icons";
import type { QueuedClip , ReviewRangeDraft } from "../types";
import { secondsToHms } from "../lib/timecode";
import { TranscriptViewer } from "./TranscriptViewer";
import { AiSummary, type SummaryStyle } from "./AiSummary";
import { ReviewPanel } from "./ReviewPanel";
import type { AnnotationStrokes } from "../lib/review";
import type { TranscriptHistoryEntry } from "../lib/transcript-history";
import {
  type TabId, loadActiveTab, saveActiveTab, loadTabOrder, saveTabOrder,
} from "../lib/tab-state";

/**
 * Tab system for the right-docked panel. Adding a new tab is one row
 * in the TABS array + one body case below (ids live in lib/tab-state).
 * We deliberately avoid shipping "Soon" placeholder tabs (UI bloat).
 *
 * Tab STATE (active tab + order) persists via lib/tab-state, which is what
 * keeps the docked drawer and the floating panel window in step: exactly one
 * drawer is mounted at a time, so restoring persisted state on mount carries
 * the user's tab across pop-out / re-dock / relaunch.
 */
type TabDef = {
  id: TabId;
  label: string;
  icon: (props: { size?: number; stroke?: string }) => React.ReactElement;
  badge?: number;
  disabled?: boolean;
};

type Props = {
  open: boolean;
  /**
   * Is the view hosting this drawer actually on screen? Keep-alive views stay
   * MOUNTED when inactive, so without this the transcript's unvirtualized
   * per-turn render and the review list both keep rebuilding at source-fps
   * against a `display:none` subtree, competing with the audio decode loop for
   * the main thread. Defaults true for the popped-out panel window, which has
   * no view concept and is always visible when it exists.
   */
  viewActive?: boolean;
  onClose: () => void;
  queue: QueuedClip[];
  fps: number;
  running: boolean;
  hasFolder: boolean;
  onRemove: (id: string) => void;
  /** Put a failed row back in the queue, marks and all. */
  onRetry: (id: string) => void;
  /** Turn a transcript selection into in/out marks, or a queued clip. */
  onMarkRange: (startSeconds: number, endSeconds: number) => void;
  onQueueRange: (startSeconds: number, endSeconds: number) => void;
  onClearAll: () => void;
  /** Drop only the finished rows (and their timeline bands). */
  onClearDone?: () => void;
  onExportAll: () => void;
  onStop: () => void;
  /** Path to the currently-loaded transcript SRT, or null. */
  transcriptPath: string | null;
  /** Where the transcript came from — drives the origin badge. */
  transcriptOrigin: "captions" | "whisper" | "unknown";
  /** True when a playable source is loaded — combined with the active tab to
   *  tell the transcript/review children to track the live playhead (they
   *  subscribe to the playhead store themselves; no per-frame prop). */
  playheadAvailable: boolean;
  /** Source frame rate, so transcript timestamps render as SMPTE. */
  transcriptFps?: number;
  /** Source start timecode for the Avid export offset (Tools ▸ Set source start TC). */
  sourceStartTimecode?: string;
  /** Persist/clear the loaded source's start timecode. */
  onSetSourceTimecode?: (tc: string | null) => void;
  /** Capture the frame on screen as a cast member's face. Absent in the panel
   *  window, which has no player — the roster hides the control rather than
   *  offering one that cannot work. */
  onGrabFace?: () => Promise<string | null>;
  /** Click-to-seek callback — receives seconds. */
  onTranscriptSeek: (seconds: number) => void;
  /**
   * Monotonic counter that bumps each time a fresh transcript lands.
   * When this changes we auto-switch to the Transcript tab so the user
   * doesn't have to hunt for the result of the action they just took.
   */
  transcriptArrivedTick: number;
  /**
   * Bump to jump to the Review tab, the way `transcriptArrivedTick` jumps to
   * Transcript. Exists so the marker export is reachable from the command
   * palette: it lived behind an unlabelled 14px glyph, inside a tab, inside a
   * drawer, and was in neither the palette, the File menu nor the shortcut
   * sheet - so an editor looking for Premiere markers concluded the app did
   * not do it and retyped timecodes by hand.
   */
  reviewRequestTick?: number;
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
  /** Re-run ONLY speaker detection on the current transcript (no re-transcribe). */
  onRedetectSpeakers?: () => void;
  /** True when re-detecting speakers is possible (a transcript + a source). */
  canRedetect?: boolean;
  /** Open a .srt / .vtt from disk (file picker). */
  onImportTranscript: () => void;
  /** r84: source kind — gates the "fix caption timing" banner to web sources. */
  sourceKind?: "youtube" | "file";
  /** r84: re-time loose YouTube captions with Whisper. Optional (omitted in the
   *  popped-out panel, where the banner is hidden rather than wired over the bus). */
  onFixCaptionTiming?: () => void;
  /** True when a media source is loaded — gates the transcript empty-state's
   *  "Generate transcript" button. */
  transcriptHasSource?: boolean;
  /** Inline cue editing rewrote the SRT in place — App bumps the arrived tick
   *  so the caption overlay / AI summary / speaker lanes re-read the file. */
  onTranscriptEdited?: () => void;
  /** AI Summary: the summarization model + output style chosen in Settings. */
  aiModelId?: string | null;
  aiStyle?: SummaryStyle;
  /** Open Settings → AI Summary (manage/download/switch the model). */
  onOpenAiSettings?: () => void;
  /** Auto-chapters: source identity to persist under (main's reviewSourceKey —
   *  the panel receives it through the bus snapshot). */
  chapterSourceKey?: string | null;
  /** The source's own description, for the AI tab's context. */
  sourceDescription?: string | null;
  /** Auto-chapters: source duration in seconds (clamps model timestamps). */
  chapterDurationSec?: number | null;
  /** Auto-chapters changed (generate/delete) — the popped-out panel forwards
   *  this over the bus so main's timeline markers re-read. Omit when docked
   *  (the same-window CHAPTERS_CHANGED_EVENT already covers it). */
  onChaptersChanged?: () => void;
  /** Review tab: stable id for the current source (local path / URL), or null. */
  reviewSourceKey?: string | null;
  /** Review tab: human label for the source (title/filename). */
  reviewSourceTitle?: string | null;
  /** Review drawing: true while draw mode is on (overlay captures input). */
  reviewDrawActive?: boolean;
  /** Review drawing: the live draft strokes drawn over the frame. */
  reviewDraft?: AnnotationStrokes | null;
  /** Toggle draw mode on/off. */
  onToggleReviewDraw?: () => void;
  /** Review labels: true while the text-label tool is active in draw mode. */
  reviewLabelActive?: boolean;
  /** Toggle the label tool (App enters draw mode first when needed). */
  onToggleReviewLabel?: () => void;
  /** Called once the draft has been attached to a comment (clears + exits draw). */
  onReviewDraftConsumed?: () => void;
  /** Show a saved annotation read-only over the frame (null to hide).
   *  `color` = the note author's reviewer colour, for the label chips. */
  onShowAnnotation?: (a: AnnotationStrokes | null, color?: string, time?: number) => void;
  /** Re-open a past-review source (local path or URL) from the history popover. */
  onOpenReviewSource?: (path: string) => void;
  /** Version stacks: absorb the open source into an older cut's review doc. */
  onReviewLinkAsVersion?: (oldKey: string) => void;
  /** Version stacks: take the open source back out of a wrongly-linked stack. */
  onReviewUnlinkVersion?: () => void;
  /** Path of the file open in the player, so the panel can tell which version
   *  in a stack is the one unlink would actually act on. */
  reviewSourcePath?: string | null;
  /** Live review-comment range being set → previewed on the App's timeline.
   *  `live` = an end still follows the playhead; false = both marks locked. */
  onReviewRangeDraft?: (r: ReviewRangeDraft | null) => void;
  /** App's undo/redo, forwarded to the transcript toolbar so its buttons and
   *  ⌘Z are the same action. */
  onUndo?: () => void;
  onRedo?: () => void;
  /** Co-review: true while a session is active (may precede the doc snapshot
   *  arriving — the panel shows "Connecting…" and blocks posting until then). */
  reviewSessionActive?: boolean;
  /** Co-review: the shared session doc (non-null once the snapshot lands) + the
   *  op sink. When active, the Review panel shows this doc and routes every
   *  mutation as an op instead of writing to local storage. */
  reviewSessionDoc?: import("../lib/review").ReviewDoc | null;
  onReviewSessionOp?: (op: import("../lib/review").ReviewOp) => void;
  /** ReviewPanel registers its ⇧I/⇧O range-mark handlers with App through
   *  this (null on unmount) — see App's review-range keyboard dispatch. */
  onRegisterRangeHotkeys?: (h: { markIn: () => void; markOut: () => void } | null) => void;
  /** Rename one queued clip (double-click its name). Docked drawer only for
   *  now — the floating panel's action bus doesn't carry these yet. */
  onRenameClip?: (id: string, name: string) => void;
  /** Bulk rename: every QUEUED item becomes base-1..N in queue order. */
  onRenameAll?: (base: string) => void;
  /**
   * Put the QUEUED clips in this order.
   *
   * Docked drawer only, exactly as onRenameClip is: the floating panel talks
   * to main through `panel:action:<kind>`, whose union carries no reorder, so
   * without the prop the panel would show a drag that looks like it works and
   * silently does nothing.
   */
  onReorderQueue?: (orderedIds: readonly string[]) => void;
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
  /** Session-room dressing: tab strip and queue chrome hidden, the
   *  Review tab forced (same mounted panel, just the room's face). */
  roomFace?: boolean;
  /** Timeline range click: switch to the Queue tab and flash the item. */
  focusItem?: { id: string; tick: number } | null;
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
// Floor raised 280 → 320 so the Review tab's toolbar (filter + icon cluster +
// avatar) and composer row always have room to lay out without clipping.
// Stored widths are deliberately NOT cleared/migrated — returning users keep
// their chosen width; loadDrawerWidth only clamps a stored value below the
// new floor up to it on read.
const DRAWER_WIDTH_MIN = 320;
const DRAWER_WIDTH_MAX = 720;
// First-run default (no stored value). Wide enough that the transcript
// toolbar's primary actions + the Tools menu fit without clipping, the Review
// toolbar stays on one row, and the AI Summary reads comfortably. Users can
// still drag-resize (persisted) or double-click the handle to reset to this.
const DRAWER_WIDTH_DEFAULT = 440;
// Width at which the Review tab's toolbar (filter segments + icon cluster +
// avatar) fits on one row; below it the toolbar wraps onto two lines.
const REVIEW_COMFORT_WIDTH = 520;

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
  open, viewActive = true, onClose, queue, fps, running, hasFolder,
  onRemove, onRetry, onMarkRange, onQueueRange, onClearAll, onClearDone, onExportAll, onStop,
  transcriptPath, transcriptOrigin, playheadAvailable, transcriptFps,
  sourceStartTimecode, onSetSourceTimecode, onGrabFace,
  onTranscriptSeek, transcriptArrivedTick, reviewRequestTick = 0,
  onClearTranscript, onLoadFromHistory,
  onRegenerateTranscript, regenerateBusy, canRegenerate,
  onRedetectSpeakers, canRedetect,
  onImportTranscript, sourceKind, onFixCaptionTiming,
  transcriptHasSource, onTranscriptEdited,
  aiModelId, aiStyle, onOpenAiSettings,
  chapterSourceKey, chapterDurationSec, onChaptersChanged, sourceDescription,
  reviewSourceKey, reviewSourceTitle,
  reviewDrawActive, reviewDraft, onToggleReviewDraw, reviewLabelActive, onToggleReviewLabel, onReviewDraftConsumed, onShowAnnotation,
  onOpenReviewSource, onReviewLinkAsVersion, onReviewUnlinkVersion, reviewSourcePath, onReviewRangeDraft, onRegisterRangeHotkeys, onUndo, onRedo,
  reviewSessionActive, reviewSessionDoc, onReviewSessionOp,
  onRenameClip, onRenameAll, onReorderQueue,
  onPopOut, embedded = false, roomFace = false, focusItem = null,
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
  // Drives the shared handle's `.dragging` bright state (resize.css).
  const [resizing, setResizing] = useState(false);
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const onResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    dragStateRef.current = { startX: e.clientX, startWidth: drawerWidth };
    setResizing(true);
    document.body.classList.add("cp-resizing-ew");
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
      setResizing(false);
      document.body.classList.remove("cp-resizing-ew");
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

  // ── Renaming (double-click a queued row's name; bulk via the foot) ──
  // Enter commits, Esc/blur cancels. Only "queued" items rename — a running/
  // done item's file may already exist on disk under the old name.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameAllOpen, setRenameAllOpen] = useState(false);
  const [renameAllBase, setRenameAllBase] = useState("");
  const commitRename = (id: string) => {
    if (renameDraft.trim()) onRenameClip?.(id, renameDraft);
    setRenamingId(null);
  };
  const commitRenameAll = () => {
    if (renameAllBase.trim()) onRenameAll?.(renameAllBase);
    setRenameAllOpen(false);
  };

  // Restore the last active tab on mount (pop-out, re-dock, and relaunch all
  // land on the tab the user was on) and write every change straight through.
  const [activeTab, setActiveTab] = useState<TabId>(() => loadActiveTab());
  // Focus request from the timeline (8a): jump to Queue, scroll + flash.
  useEffect(() => {
    if (!focusItem) return;
    setActiveTab("queue");
    const t = window.setTimeout(() => {
      const el = document.querySelector(`[data-queue-item="${focusItem.id}"]`);
      el?.scrollIntoView({ block: "nearest" });
      el?.classList.add("flash");
      window.setTimeout(() => el?.classList.remove("flash"), 1200);
    }, 60);
    return () => window.clearTimeout(t);
  }, [focusItem]);
  // The room forces the Review face without touching the persisted tab
  // choice - leaving the room lands back on whatever was active before.
  // A tab persisted from the main window (or from before Review was hidden
  // here) must not strand the panel on a face it cannot render.
  const availableTab: TabId = embedded && activeTab === "review" ? "transcript" : activeTab;
  const shownTab: TabId = roomFace ? "review" : availableTab;
  useEffect(() => { saveActiveTab(activeTab); }, [activeTab]);
  // Review-tab comfort width. Below ~520px the review toolbar wraps onto two
  // rows (filters row + icons row), which reads as clutter. When the user
  // SWITCHES to the Review tab in a narrower drawer, nudge the width up once
  // through the normal setDrawerWidth path (the settle-effect above persists
  // it, exactly like a drag). Deliberately a one-time nudge per switch — NOT a
  // clamp — so a user who consciously re-narrows afterward isn't fought within
  // the session. Skipped in embedded (floating-window) mode, where drawerWidth
  // isn't applied and nudging would only mutate the docked drawer's persisted
  // width invisibly.
  const prevTabRef = useRef<TabId>(activeTab);
  useEffect(() => {
    const prev = prevTabRef.current;
    prevTabRef.current = activeTab;
    if (embedded || activeTab !== "review" || prev === "review") return;
    setDrawerWidth((w) => (w < REVIEW_COMFORT_WIDTH ? REVIEW_COMFORT_WIDTH : w));
  }, [activeTab, embedded]);
  // Keep-alive: a tab body mounts on first visit and stays mounted (hidden)
  // afterward, so per-tab state — transcript search + scroll, an in-progress
  // AI chat, a running dictation in Review — survives tab switches. Lazy so
  // never-visited tabs cost nothing at drawer mount.
  // Seeded and grown from availableTab, NOT activeTab. activeTab is restored
  // from localStorage, which the MAIN window also writes - so popping the
  // panel out while main sat on Review used to seed visited with "review" and
  // mount a hidden ReviewPanel in a window whose tab strip does not offer it.
  // availableTab is the same value with the embedded redirect applied, so the
  // review body genuinely cannot mount here. (In the main window the two are
  // always equal, so this changes nothing there.) The shownTab effect still
  // covers the roomFace override, which is main-window-only.
  const [visited, setVisited] = useState<ReadonlySet<TabId>>(
    () => new Set([embedded && activeTab === "review" ? "transcript" : activeTab]),
  );
  useEffect(() => {
    setVisited((prev) => (prev.has(shownTab) ? prev : new Set(prev).add(shownTab)));
  }, [shownTab]);
  useEffect(() => {
    setVisited((prev) => (prev.has(availableTab) ? prev : new Set(prev).add(availableTab)));
  }, [availableTab]);
  // Seed with the MOUNT-TIME tick so a remount (pop-out, or re-dock after
  // closing the panel) doesn't re-fire the auto-switch for a transcript that
  // arrived long ago — only a NEW arrival (tick actually advancing while
  // mounted) should yank the user to the Transcript tab. The tick reaches the
  // floating panel through the panel-bus snapshot, so this one effect covers
  // BOTH windows; the old embedded-only "switch once a transcript path exists"
  // fallback is gone — it overrode the restored tab on every pop-out.
  const lastReviewTickRef = useRef(reviewRequestTick);
  useEffect(() => {
    if (reviewRequestTick === lastReviewTickRef.current) return;
    lastReviewTickRef.current = reviewRequestTick;
    setActiveTab("review");
  }, [reviewRequestTick]);

  const lastArrivedTickRef = useRef(transcriptArrivedTick);
  useEffect(() => {
    if (transcriptArrivedTick === lastArrivedTickRef.current) return;
    lastArrivedTickRef.current = transcriptArrivedTick;
    // A new transcript arrived → show it. App opens the drawer on the first
    // arrival, but that open() lands a render AFTER this effect, so the old
    // `if (open)` gate saw open===false and left the drawer on Queue. Switch
    // to the Transcript tab UNCONDITIONALLY — when the drawer then opens (or is
    // already open / reopened) it's on the right tab.
    if (activeTab !== "transcript") setActiveTab("transcript");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcriptArrivedTick]);

  // Review is unavailable in the POPPED-OUT panel: that window mirrors a
  // curated `panel:state` snapshot and is never handed a review source key,
  // so the tab rendered permanently empty and a persisted tab choice could
  // boot the panel straight into it (r151). A tab that cannot work is worse
  // than a missing one; it comes back if and when the panel bus carries the
  // review doc.
  const TABS: TabDef[] = [
    { id: "queue", label: "Queue", icon: IconStack, badge: queue.length },
    { id: "transcript", label: "Transcript", icon: IconTranscript },
    { id: "ai", label: "AI Summary", icon: IconAiSummary },
    ...(embedded ? [] : [{ id: "review" as const, label: "Review", icon: IconReview }]),
  ];

  // ── Reordering the export queue ────────────────────────────────
  // The order the export actually runs in, and until now the one thing on
  // this panel nobody could change. Only WAITING clips move: a running one
  // is mid-subprocess, a finished one is a receipt.
  //
  // The index arithmetic lives in lib/reorder.ts, because "dropped between
  // these two rows" is a boundary counted BEFORE the dragged row leaves its
  // slot, and committing that naively is off by one in exactly one direction.
  const canReorder = !!onReorderQueue && !running;
  const queuedIds = queue.filter((c) => c.status === "queued").map((c) => c.id);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const midsRef = useRef<number[]>([]);

  const commitOrder = (from: number, to: number) => {
    const next = moveItem(queuedIds, from, to);
    if (next.join("\u0000") !== queuedIds.join("\u0000")) onReorderQueue?.(next);
  };

  const pressRef = useRef<{ id: string; y: number } | null>(null);

  const onRowPointerDown = (id: string) => (e: React.PointerEvent) => {
    if (!canReorder || e.button !== 0) return;
    if (!queuedIds.includes(id)) return;
    // A press that lands on a control is that control's press. Without this
    // the row swallows its own buttons: capturing the pointer below retargets
    // the click that follows, so Move earlier / Remove never fire.
    if (e.target instanceof Element && e.target.closest("button, input")) return;
    // Measure once, at press: the rows do not move until we move them, and a
    // getBoundingClientRect per row per pointermove is a layout thrash.
    midsRef.current = queuedIds.map((qid) => {
      const el = document.querySelector(`[data-queue-item="${qid}"]`);
      const r = el?.getBoundingClientRect();
      return r ? r.top + r.height / 2 : Number.POSITIVE_INFINITY;
    });
    pressRef.current = { id, y: e.clientY };
  };

  const onRowPointerMove = (e: React.PointerEvent) => {
    const press = pressRef.current;
    if (!press) return;
    if (!dragId) {
      // A PRESS IS NOT YET A DRAG. Below the threshold this is still a click,
      // and the row has to stay clickable; capturing sooner would retarget
      // that click to the row.
      if (Math.abs(e.clientY - press.y) < 6) return;
      setDragId(press.id);
      try { (e.currentTarget as Element).setPointerCapture(e.pointerId); }
      catch { /* pointer already gone; up/cancel still resets */ }
    }
    setDropAt(dropIndexAt(midsRef.current, e.clientY));
  };

  const endRowDrag = () => {
    const id = dragId;
    const to = dropAt;
    pressRef.current = null;
    setDragId(null);
    setDropAt(null);
    if (!id || to == null) return;
    const from = queuedIds.indexOf(id);
    if (from >= 0) commitOrder(from, to);
  };

  // ── User-reorderable tab order ─────────────────────────────────
  // Drag a tab onto another to swap. Order persists per-machine via
  // lib/tab-state (stale ids dropped, brand-new tab ids appended, so a
  // code-level addition can't be hidden by an old localStorage entry).
  const [tabOrder, setTabOrderState] = useState<TabId[]>(() => loadTabOrder(TABS.map((t) => t.id)));
  const setTabOrder = (next: TabId[]) => {
    setTabOrderState(next);
    saveTabOrder(next);
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
      className={"cp-queue-drawer" + (open ? " open" : "") + (embedded ? " embedded" : "") + (roomFace ? " room" : "") + (resizing ? " resizing" : "")}
      // See Sidebar: aria-hidden alone left ~40 controls focusable behind a
      // zero-width panel, "Export N clips" among them.
      aria-hidden={!open}
      {...inertWhen(!open)}
      aria-label="Queue and tools"
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
          className={"cp-queue-resize cp-resize-handle vertical" + (resizing ? " dragging" : "")}
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
          const isActive = shownTab === t.id && !t.disabled;
          const isDragSrc = drag?.tabId === t.id;
          return (
            <button
              key={t.id}
              id={"cp-tab-" + t.id}
              role="tab"
              aria-selected={isActive}
              aria-controls={"cp-tabpanel-" + t.id}
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
              title={t.disabled ? `${t.label} (coming soon)` : `${t.label} · drag to reorder`}
              onPointerDown={(e) => onTabPointerDown(e, t.id, idx)}
              onPointerMove={onTabPointerMove}
              onPointerUp={onTabPointerUp}
              onPointerCancel={onTabPointerUp}
            >
              {/* The icon brightens with the label rather than turning green - see
                  the note on .cp-tab.active. */}
              <Icon size={13} stroke={isActive ? "var(--fg-1)" : "var(--fg-3)"} />
              <span>{t.label}</span>
              {t.badge != null && t.badge > 0 && (
                <span className="cp-tab-badge">{t.badge}</span>
              )}
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
            {/* "Open in new window" glyph (Feather external-link): a window
                with an arrow leaving the top-right corner — the universally
                recognized pop-out-to-its-own-window affordance. The old
                diagonal double-arrow read as fullscreen/expand, not pop-out. */}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
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

      {/* Active-tab bodies — keep-alive wrappers: `visited` gates the mount,
          `hidden` gates visibility, and per-tick props (playhead) are gated to
          the ACTIVE tab so hidden bodies do no karaoke/timecode work while
          keeping all their internal state. Add a case here for a new tab. */}
      {visited.has("queue") && (
        <div className="cp-tab-keep" role="tabpanel" id="cp-tabpanel-queue" aria-labelledby="cp-tab-queue" hidden={shownTab !== "queue"}>
        {/* === existing queue body kept untouched below === */}

      <div className="cp-queue-list">
        {queue.length === 0 ? (
          <div className="cp-pane-empty cp-queue-empty">
            <IconStack size={28} stroke="var(--fg-4)" />
            <div className="cp-queue-empty-title">No clips queued</div>
            <div className="cp-queue-empty-body">
              Mark a section in the timeline, then click <strong>+ Add to queue</strong> in the sidebar.
              Repeat for as many sections as you need, then export them all at once.
            </div>
          </div>
        ) : queue.map((c, i) => {
          // Compact display — HH:MM:SS only (drop frames) so the meta line
          // never wraps inside the 340px drawer. Each item carries the fps it
          // was marked at — the live player fps may belong to another source.
          const r = Math.max(1, Math.round(c.fps));
          const inS  = c.inFrames  / r;
          const outS = c.outFrames / r;
          const durS = Math.max(0, outS - inS);
          const inTc  = secondsToHms(inS);
          const outTc = secondsToHms(outS);
          const dur   = secondsToHms(durS);
          const Icon = c.status === "done" ? IconCheck : c.status === "error" ? IconAlert : null;
          return (
            <div
              key={c.id}
              data-queue-item={c.id}
              className={"cp-queue-item " + c.status
                + (dragId === c.id ? " dragging" : "")
                + (dropAt != null && queuedIds[dropAt] === c.id ? " drop-before" : "")}
              onPointerDown={onRowPointerDown(c.id)}
              onPointerMove={onRowPointerMove}
              onPointerUp={endRowDrag}
              onPointerCancel={endRowDrag}
            >
              {/* The position the export will actually use. It doubles as the
                  drag handle for a queued row, which is why it carries the
                  grab cursor rather than the whole row: the row's own body
                  holds a rename field and a remove button. */}
              <div className={"cp-queue-num" + (canReorder && c.status === "queued" ? " grab" : "")}>
                {i + 1}
              </div>
              <div className="cp-queue-body">
                <div className="cp-queue-row">
                  {renamingId === c.id ? (
                    <input
                      className="cp-queue-rename"
                      autoFocus
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(c.id);
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      onBlur={() => setRenamingId(null)}
                      aria-label="Rename queued clip"
                    />
                  ) : (
                    <div
                      className="cp-queue-name"
                      title={onRenameClip && c.status === "queued" ? `${c.filename} · double-click to rename` : c.filename}
                      onDoubleClick={() => {
                        if (!onRenameClip || c.status !== "queued") return;
                        setRenameDraft(c.filename);
                        setRenamingId(c.id);
                      }}
                    >
                      {c.filename}
                    </div>
                  )}
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
                  {/* Local items export source-resolution MP4 — the web
                      quality caps (4K/1080/720) don't apply, so say "MP4". */}
                  <span className="fmt">{c.format === "audio" ? "MP3" : c.source.kind === "file" ? "MP4" : c.format.toUpperCase()}</span>
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
                    aria-label={`Reveal ${c.filename} in Finder`}
                    onClick={() => invoke("reveal_in_finder", { path: c.path }).catch(() => {})}
                  >
                    <IconReveal size={13} />
                  </button>
                )}
                {c.status === "error" && (
                  <button
                    className="cp-queue-iconbtn"
                    title="Try again"
                    aria-label={`Try ${c.filename} again`}
                    onClick={() => onRetry(c.id)}
                  >
                    <IconRefresh size={13} />
                  </button>
                )}
                {/* The keyboard route to the same thing the drag does. A
                    reorder that exists only as a pointer gesture is
                    unreachable without one, and this list decides the order
                    the export actually runs in. */}
                {canReorder && c.status === "queued" && (() => {
                  const at = queuedIds.indexOf(c.id);
                  return (
                    <>
                      <button
                        className="cp-queue-iconbtn"
                        title="Move earlier in the queue"
                        aria-label={`Move ${c.filename} earlier in the queue`}
                        disabled={at <= 0}
                        onClick={() => commitOrder(at, at - 1)}
                      >
                        <IconChevronDown size={13} className="cp-queue-up" />
                      </button>
                      <button
                        className="cp-queue-iconbtn"
                        title="Move later in the queue"
                        aria-label={`Move ${c.filename} later in the queue`}
                        disabled={at < 0 || at >= queuedIds.length - 1}
                        onClick={() => commitOrder(at, at + 2)}
                      >
                        <IconChevronDown size={13} />
                      </button>
                    </>
                  );
                })()}
                {c.status !== "running" && (
                  <button
                    className="cp-queue-iconbtn danger"
                    title="Remove from queue"
                    aria-label={`Remove ${c.filename} from queue`}
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
        {renameAllOpen && (
          <div className="cp-queue-renameall">
            <input
              autoFocus
              value={renameAllBase}
              onChange={(e) => setRenameAllBase(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRenameAll();
                if (e.key === "Escape") setRenameAllOpen(false);
              }}
              placeholder={`Base name (clips become name-1 … name-${queuedCount})`}
              aria-label="Bulk rename base"
            />
            <button className="btn btn-ghost" onClick={commitRenameAll} disabled={!renameAllBase.trim()}>
              Apply
            </button>
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
          {onClearDone && (
            <button
              className="btn btn-ghost"
              onClick={onClearDone}
              // Safe while the queue RUNS: it touches only finished rows, so
              // it never reaches the one in flight or anything still owed.
              disabled={doneCount === 0}
              title="Remove the exported clips from the queue, and their bands from the timeline"
            >
              Clear completed
            </button>
          )}
          {onRenameAll && (
            <button
              className="btn btn-ghost"
              onClick={() => { setRenameAllBase(""); setRenameAllOpen((o) => !o); }}
              disabled={queuedCount === 0 || running}
              title="Rename every queued clip to base-1 … base-N"
            >
              Rename…
            </button>
          )}
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
        </div>
      )}
      {visited.has("transcript") && (
        <div className="cp-tab-keep" role="tabpanel" id="cp-tabpanel-transcript" aria-labelledby="cp-tab-transcript" hidden={shownTab !== "transcript"}>
        <TranscriptViewer
          onUndo={onUndo}
          onRedo={onRedo}
          path={transcriptPath}
          /* Same-path overwrites (Regenerate / Fix-timing) re-read via the tick. */
          reloadToken={transcriptArrivedTick}
          /* Playhead only while ACTIVE — a hidden transcript's karaoke
             highlight + autoscroll stay frozen, then snap to the current
             position when the tab re-shows. */
          playheadActive={playheadAvailable && viewActive && shownTab === "transcript"}
          fps={transcriptFps}
          startTimecode={sourceStartTimecode}
          onSetSourceTimecode={onSetSourceTimecode}
          onGrabFace={onGrabFace}
          onSeek={onTranscriptSeek}
          onMarkRange={onMarkRange}
          onQueueRange={onQueueRange}
          origin={transcriptOrigin}
          onClearTranscript={onClearTranscript}
          onLoadFromHistory={onLoadFromHistory}
          onRegenerate={onRegenerateTranscript}
          regenerateBusy={regenerateBusy}
          canRegenerate={canRegenerate}
          onRedetectSpeakers={onRedetectSpeakers}
          canRedetect={canRedetect}
          onImportTranscript={onImportTranscript}
          sourceKind={sourceKind}
          onFixCaptionTiming={onFixCaptionTiming}
          hasSource={transcriptHasSource}
          onTranscriptEdited={onTranscriptEdited}
        />
        </div>
      )}
      {visited.has("ai") && (
        <div className="cp-tab-keep" role="tabpanel" id="cp-tabpanel-ai" aria-labelledby="cp-tab-ai" hidden={shownTab !== "ai"}>
        <AiSummary
          transcriptPath={transcriptPath}
          reloadToken={transcriptArrivedTick}
          /* Pre-warm only while the tab is actually on screen. `visited` is
             seeded from localStorage and this <aside> renders whether or not
             the drawer is open, so mounting alone would load a multi-GB model
             at boot for a user who did nothing. */
          warmable={open && shownTab === "ai"}
          selectedModelId={aiModelId}
          style={aiStyle}
          onOpenSettings={onOpenAiSettings}
          onSeek={onTranscriptSeek}
          sourceKey={chapterSourceKey ?? null}
          sourceDescription={sourceDescription ?? null}
          durationSec={chapterDurationSec ?? null}
          onChaptersChanged={onChaptersChanged}
        />
        </div>
      )}
      {visited.has("review") && (
        <div className="cp-tab-keep" role="tabpanel" id="cp-tabpanel-review" aria-labelledby="cp-tab-review" hidden={shownTab !== "review"}>
        <ReviewPanel
          sourceKey={reviewSourceKey ?? null}
          sourceTitle={reviewSourceTitle}
          /* Playhead only while ACTIVE — see the transcript note above. */
          playheadActive={playheadAvailable && viewActive && shownTab === "review"}
          fps={fps}
          durationSec={chapterDurationSec ?? null}
          onSeek={onTranscriptSeek}
          drawActive={!!reviewDrawActive}
          draft={reviewDraft ?? null}
          onToggleDraw={onToggleReviewDraw}
          labelActive={!!reviewLabelActive}
          onToggleLabel={onToggleReviewLabel}
          onDraftConsumed={onReviewDraftConsumed}
          onShowAnnotation={onShowAnnotation}
          onOpenReview={onOpenReviewSource}
          onLinkAsVersion={onReviewLinkAsVersion}
          onUnlinkVersion={onReviewUnlinkVersion}
          sourcePath={reviewSourcePath ?? null}
          onRangeDraft={onReviewRangeDraft}
          onRegisterRangeHotkeys={onRegisterRangeHotkeys}
          sessionActive={!!reviewSessionActive}
          sessionDoc={reviewSessionDoc ?? null}
          onSessionOp={onReviewSessionOp}
          /* The two verbs this drawer has been handing TranscriptViewer all
             along, finally reaching the panel where a shared range lives. */
          onMarkRange={onMarkRange}
          onQueueRange={onQueueRange}
        />
        </div>
      )}
    </aside>
  );
}
