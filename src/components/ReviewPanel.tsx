import { COMMENT_REACTION_EMOJI } from "../lib/reactions";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useMenuKeys } from "../hooks/use-menu-keys";
import { ColorSwatches } from "./ColorSwatches";
import { useModalFocus } from "../hooks/use-modal-focus";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { DictateDoneEvent, DictateLevelEvent, DictatePartialEvent, ReviewRangeDraft } from "../types";
import { DictationWave } from "./DictationWave";
import { EmojiPicker } from "./EmojiPicker";
import { IconDownload, IconRange } from "./Icons";
import { getPlayheadSeconds, usePlayheadSecondsCoarse } from "../lib/playhead-store";
import { secondsToHms, secondsToTc } from "../lib/timecode";
import { loadJson, saveJson } from "../lib/storage";
import { formatError } from "../lib/error-format";
import { appUndo } from "../lib/undo";
import {
  loadReview, saveReview, ensureVersion,
  buildComment, insertComment, editComment, deleteComment, editReply, removeReply,
  setResolved, setLike, reactionsOf, rootComments, openCount,
  setActiveVersion, carriedComments, versionCandidates, canUnlinkVersion,
  applyReviewOp, inverseReviewOps, inverseReviewOpsBatch, restampReviewOp,
  reviewToMarkdown,
  avatarColor, initialsOf, loadReviewer, AVATAR_COLORS, AUTHOR_KEY, AUTHOR_COLOR_KEY, REVIEW_CHANGED_EVENT,
  loadReviewHistory, removeReviewHistory, clearReviewHistory, annotationHasContent,
  type ReviewDoc, type ReviewComment, type CommentSort, type AnnotationStrokes, type ReviewHistoryEntry, type ReviewOp,
} from "../lib/review";
import {
  markersToAvidTxt, markersToPremiereXml, markersToResolveEdl, markersToFcpxml, markersToCsv,
} from "../lib/markers";
import { PasteNotesModal, type ImportedNote } from "./review/PasteNotesModal";
import {
  markRangeIn as markRangeInAt, markRangeOut as markRangeOutAt, tapRange as tapRangeAt,
  rangeToPost, type MarkRange,
} from "../lib/review-range";
import {
  RATE_TABLE, DEFAULT_MARKER_SETTINGS, tcToFrames, FRAME_RATE_KEYS, fpsToRateKey,
  type FrameRateKey, type MarkerExportSettings,
} from "../lib/marker-time";
import { newJobId } from "../lib/job-id";

/** The export popover's format choices — Notes (Markdown) + the five marker
 *  targets. Persisted marker settings drive every marker format. */
type ExportKind = "md" | "avid" | "premiere" | "resolve" | "fcpx" | "csv";

const MARKER_SETTINGS_KEY = "saucebunny.markerExport";

/** Load persisted marker settings; seed the frame rate from the clip's fps when
 *  nothing is stored yet. Anything stored wins (the user's explicit choice). */
function loadMarkerSettings(fps: number): MarkerExportSettings {
  const stored = loadJson<Partial<MarkerExportSettings>>(MARKER_SETTINGS_KEY, {});
  const seeded = fpsToRateKey(fps);
  const frameRate = stored.frameRate && FRAME_RATE_KEYS.includes(stored.frameRate)
    ? stored.frameRate
    : seeded ?? DEFAULT_MARKER_SETTINGS.frameRate;
  const settings: MarkerExportSettings = {
    frameRate,
    sequenceStartTc: stored.sequenceStartTc ?? DEFAULT_MARKER_SETTINGS.sequenceStartTc,
    dropFrame: stored.dropFrame ?? DEFAULT_MARKER_SETTINGS.dropFrame,
  };
  // Drop-frame is only meaningful at 29.97 / 59.94 — never persist it enabled
  // on a rate that can't drop-frame.
  if (!RATE_TABLE[settings.frameRate].dropAllowed) settings.dropFrame = false;
  return settings;
}

/**
 * Frame.io-style review panel — a local, self-hosted review tab. Timecoded
 * threaded comments anchored to the player's playhead, click-to-seek, resolve,
 * and a per-version approval status. All state is local (localStorage, keyed per
 * source); no server, no accounts. Reuses the drawer's existing playhead
 * (the playhead store) + seek (`onSeek`) — the same wiring the transcript tab uses.
 *
 * ReviewPanel itself is a thin orchestrator: it owns state + handlers and
 * composes three sibling presentational pieces — ReviewToolbar, ReviewComposer,
 * NameGateModal — plus the comment list (CommentRow).
 */

/** Compact relative time ("just now" / "5m ago" / "2d ago" / a date). */
function timeAgo(ms: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

/** Insert an emoji at a single-line input's caret (replacing any selection),
 *  then restore focus + caret — the input-flavoured twin of the composer's
 *  textarea insertEmoji. Used by the reply input and the reply edit field. */
function insertAtCaret(
  ref: React.RefObject<HTMLInputElement>, value: string, setValue: (s: string) => void, emoji: string,
) {
  const el = ref.current;
  if (!el) { setValue(value + emoji); return; }
  const start = el.selectionStart ?? value.length;
  const end = el.selectionEnd ?? value.length;
  setValue(value.slice(0, start) + emoji + value.slice(end));
  requestAnimationFrame(() => {
    const n = ref.current;
    if (!n) return;
    const caret = start + emoji.length;
    n.focus();
    n.setSelectionRange(caret, caret);
  });
}

// Composer height persistence — null = auto-size (grow with content up to
// 140px, today's behavior). A number = the user dragged the composer to a
// fixed height: the typing area IS that height and content scrolls inside it.
const COMPOSER_HEIGHT_KEY = "saucebunny.review.composerHeight";
// Matches .cp-review-input min-height. Raised with it when the composer
// became a column: the field is three lines now, and a floor of 34 let the
// autosize and the drag handle shrink it back to the slot it used to be.
const COMPOSER_MIN = 68;
const COMPOSER_LOAD_MAX = 480; // static clamp on read; live drags clamp to 60% of the panel
function loadComposerHeight(): number | null {
  try {
    const raw = localStorage.getItem(COMPOSER_HEIGHT_KEY);
    if (!raw) return null;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return null;
    return Math.max(COMPOSER_MIN, Math.min(COMPOSER_LOAD_MAX, n));
  } catch { return null; }
}

function Avatar({ name, size = 30, color }: { name: string; size?: number; color?: string }) {
  return (
    <span
      className="cp-review-avatar"
      style={{ background: color ?? avatarColor(name), width: size, height: size, fontSize: Math.round(size * 0.4) }}
      aria-hidden
    >
      {initialsOf(name)}
    </span>
  );
}

/** Shared empty replies array. A fresh `[]` per render would give every
 *  reply-less root a new prop identity on every tick, for nothing. */
const NO_REPLIES: ReviewComment[] = [];

export function ReviewPanel({
  sourceKey,
  sourceTitle,
  playheadActive,
  fps,
  durationSec = null,
  onSeek, onMarkRange, onQueueRange,
  drawActive = false,
  draft = null,
  onToggleDraw,
  labelActive = false,
  onToggleLabel,
  onDraftConsumed,
  onShowAnnotation,
  onOpenReview,
  onLinkAsVersion,
  onUnlinkVersion,
  sourcePath,
  onRangeDraft,
  onRegisterRangeHotkeys,
  sessionActive = false,
  sessionDoc = null,
  onSessionOp,
}: {
  /** Stable id for the current source (local path or URL); null when none loaded. */
  sourceKey: string | null;
  /** Human label for the source (for the version row). */
  sourceTitle?: string | null;
  /** True while the panel should track the live playhead (a source is loaded
   *  AND the tab is visible). The panel subscribes to the playhead store
   *  itself; while false its playhead reads null — freezing the composer
   *  timestamp and blocking marks that would land at a lying 0:00. */
  playheadActive: boolean;
  /** Source frame rate — for SMPTE timecodes in CSV/EDL export. */
  fps: number;
  /** Duration of the loaded cut, when known. Used only to disambiguate pasted
   *  three-part timecodes ("00:08:10" cannot be 490s into a 3-minute cut). */
  durationSec?: number | null;
  /** Click-to-seek — receives seconds. */
  onSeek: (seconds: number) => void;
  /**
   * Adopt a range NOTE into this machine's own clip marks / export queue.
   *
   * The two halves of "mark a range" are deliberately separate here and stay
   * that way. A range COMMENT says "look at this span": it is shared, lands on
   * every peer's timeline, and exports to all four NLE marker formats (as a
   * duration marker in Premiere, Resolve and FCPX; Avid has no spanned-marker
   * import, so markers.ts emits a >> RANGE START / << RANGE END bracket pair
   * there instead).
   *
   * CLIP MARKS say "cut this span": they are this machine's export plan, which
   * App.tsx and session-msg-contract both keep off the wire by name.
   *
   * What was missing was not a schema or a message - it was the BRIDGE. The
   * transcript has had exactly these two verbs for a while (QueueDrawer passes
   * them straight to TranscriptViewer); the review panel never received them,
   * so a range the whole room had just agreed on could only be jumped to.
   *
   * Optional, so the panel still mounts anywhere these do not apply.
   */
  onMarkRange?: (startSeconds: number, endSeconds: number) => void;
  onQueueRange?: (startSeconds: number, endSeconds: number) => void;
  /** True while drawing on the frame (the monitor overlay is capturing). */
  drawActive?: boolean;
  /** Live draft strokes drawn over the frame — attached to the next comment. */
  draft?: AnnotationStrokes | null;
  /** Toggle draw mode on/off (managed by App, drives the monitor overlay). */
  onToggleDraw?: () => void;
  /** True while the label tool is selected inside draw mode. */
  labelActive?: boolean;
  /** Toggle the label tool (App enters draw mode first when needed). */
  onToggleLabel?: () => void;
  /** Clear the draft + exit draw mode after a comment captured it. */
  onDraftConsumed?: () => void;
  /** Display a saved annotation read-only over the frame (null to hide).
   *  `color` = the author's reviewer colour, for the label chips. */
  onShowAnnotation?: (a: AnnotationStrokes | null, color?: string, time?: number) => void;
  /** Re-open a past-review source (local path / URL) from the history popover. */
  onOpenReview?: (path: string) => void;
  /** Version stacks: absorb the CURRENT source into `oldKey`'s review doc as
   *  its next version (App owns the fingerprint + key re-resolution). Absent
   *  for sources that cannot stack (web URLs, co-review). */
  onLinkAsVersion?: (oldKey: string) => void;
  /** Version stacks: take the CURRENT source back out of its stack — the
   *  escape hatch for a wrong link. Only ever invoked for a comment-free
   *  active version; the lib refuses anything else regardless. */
  onUnlinkVersion?: () => void;
  /** Absolute path of the file actually OPEN in the player, or null for web
   *  sources. Distinct from `sourceKey`, which is the review's key and points
   *  at the OLDEST cut once this file has been stacked onto it. Unlink needs
   *  this: it acts on the open file, so the control may only be offered while
   *  the version being viewed is that file's. */
  sourcePath?: string | null;
  /** Emit the range currently being set in the composer (or null) so App can
   *  preview it on the timeline. `live` = an end still follows the playhead. */
  onRangeDraft?: (r: ReviewRangeDraft | null) => void;
  /** Register the ⇧I/⇧O range-mark handlers with App's keyboard dispatch
   *  (null on unmount). The range state stays local to this panel. */
  onRegisterRangeHotkeys?: (h: { markIn: () => void; markOut: () => void } | null) => void;
  /** Co-review: true while a session is active. May be true BEFORE the doc
   *  snapshot lands — the panel then shows "Connecting…" and blocks posting so
   *  a comment can't be written into the void (would be lost when the snapshot
   *  arrives). Drives `inSession` instead of doc-presence for exactly that reason. */
  sessionActive?: boolean;
  /** Co-review: the SHARED doc (arrives once the snapshot lands). While a
   *  session is active the panel shows this instead of the local-by-sourceKey
   *  doc and routes every mutation through `onSessionOp` (App applies + relays
   *  over the P2P session) instead of localStorage. */
  sessionDoc?: ReviewDoc | null;
  onSessionOp?: (op: ReviewOp) => void;
}) {
  // NOTE: this component deliberately does NOT subscribe to the playhead at
  // the top. It used to, and the cost was the whole thread list — every
  // comment row, every reply, unmemoized — re-rendering 60×/s for the entire
  // duration of playback. What actually wanted the live value was the
  // composer's "Comment at 1:23" placeholder and the range band's following
  // edge; everything else was mark-in, mark-out, tap and submit, which are
  // handlers and can read the value when they fire. That is the store's own
  // documented rule (see the cadence contract in playhead-store.ts), and this
  // file was the one place breaking it.
  //
  // So: handlers call `getPlayheadSeconds` at action time, the composer
  // subscribes for itself, and the only render-time subscription left up here
  // is the narrow one below, live for as long as a range edge is armed.
  const playheadAt = () => getPlayheadSeconds(fps, playheadActive);
  const [doc, setDoc] = useState<ReviewDoc | null>(null);
  const [sort, setSort] = useState<CommentSort>("time");
  const [text, setText] = useState("");
  /**
   * The moment the comment is ABOUT, latched when composing starts.
   *
   * `submit` used to read the live playhead at the instant Enter was pressed,
   * so a note typed while the video kept rolling was stamped with wherever the
   * playhead had drifted to by the time you finished - the composer's
   * placeholder visibly counting up was the only warning. A comment is about
   * the frame you were LOOKING at, and that is the frame you were looking at
   * when you started to describe it.
   *
   * Latched on the first keystroke and on entering draw mode; released once
   * the comment is posted or the composer is emptied.
   */
  const [anchorSec, setAnchorSec] = useState<number | null>(null);
  const latchAnchor = () => setAnchorSec((prev) => prev ?? playheadAt() ?? 0);
  /** Latch on the first character, release when the box goes back to empty. */
  const setTextLatching = (next: string) => {
    if (next.trim() && !text.trim()) latchAnchor();
    else if (!next.trim() && !drawActive) setAnchorSec(null);
    setText(next);
  };

  // Entering draw mode latches too: a drawing is unambiguously about the frame
  // on screen when the pen came out, and App pauses playback at the same
  // moment so that frame stops moving under the stroke.
  useEffect(() => {
    if (drawActive) latchAnchor();
    else if (!text.trim()) setAnchorSec(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- latch on the EDGE
  }, [drawActive]);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [exportOpen, setExportOpen] = useState(false);
  /** The paste-producer-notes modal. */
  const [pasteOpen, setPasteOpen] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  // NLE marker-export settings (frame rate / Start TC / drop-frame), persisted
  // and seeded from the source fps on first open. Drives every marker format.
  const [markerSettings, setMarkerSettings] = useState<MarkerExportSettings>(() => loadMarkerSettings(fps));
  const updateMarkerSettings = (patch: Partial<MarkerExportSettings>) => {
    setMarkerSettings((prev) => {
      const next = { ...prev, ...patch };
      if (!RATE_TABLE[next.frameRate].dropAllowed) next.dropFrame = false;
      saveJson(MARKER_SETTINGS_KEY, next);
      return next;
    });
  };
  const [author, setAuthor] = useState(() => loadJson<string>(AUTHOR_KEY, ""));
  // Chosen avatar colour — stable + user-picked (NOT derived from the live-typed
  // name, which used to recolour on every keystroke). loadReviewer defaults a
  // named reviewer off their name hash and a first-run (unnamed) reviewer to
  // AVATAR_COLORS[0] (blue).
  const [authorColor, setAuthorColor] = useState(() => loadReviewer().color);
  const [nameModal, setNameModal] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [filter, setFilter] = useState<"all" | "open" | "resolved">("all");
  const [search, setSearch] = useState("");
  // ── Comment range (in→out) ────────────────────────────────────────
  // Optional span for the NEXT comment. Either end can be armed first (⇧I,
  // ⇧O, or the composer button); the unarmed end follows the playhead in the
  // live preview until it's marked too. Distinct from the clip mark-in/out
  // (orange, App-level) — this is reviewer-tinted and lives in the composer.
  //
  // State machine (MIN span 0.05s; t = playhead):
  //   IDLE(∅,∅) · IN-ARMED(in,∅) · OUT-ARMED(∅,out) · SET(in,out)
  //   ⇧I: arm/move IN; from OUT-ARMED completes (normalized); from SET moves
  //       IN, collapsing the span drops OUT (back to IN-ARMED).
  //   ⇧O: the exact mirror. Sub-MIN completions are ignored (stay armed).
  const [rangeIn, setRangeIn] = useState<number | null>(null);
  const [rangeOut, setRangeOut] = useState<number | null>(null);
  const clearRange = () => { setRangeIn(null); setRangeOut(null); };
  /** Apply a pure transition, keeping the two state slots in step. */
  const applyRange = (fn: (cur: MarkRange, t: number) => MarkRange) => {
    if (!ensureNamed()) return;
    const t = playheadAt();
    if (t == null) return; // no playable playhead — a mark at 0:00 would be a lie
    const next = fn({ in: rangeIn, out: rangeOut }, t);
    setRangeIn(next.in);
    setRangeOut(next.out);
  };
  const markRangeIn = () => applyRange(markRangeInAt);
  const markRangeOut = () => applyRange(markRangeOutAt);
  // Composer button keeps its tap cycle: arm IN → complete → re-arm.
  const tapRange = () => applyRange(tapRangeAt);
  // Preview the in-progress range on the App timeline; clear on unmount. The
  // playhead-following end is clamped against the armed mark so the band
  // never inverts while scrubbing behind it.
  // Once BOTH marks are set the band is fixed, so the playhead contributes
  // nothing to the payload — but keeping currentSec in the deps republished a
  // value-identical object on every tick, and because that lands in App state
  // it re-rendered the whole App tree at source-fps. Follow the playhead only
  // while an edge is still armed.
  const rangeArmed = rangeIn == null || rangeOut == null;
  // Publish the ANCHOR, not the moving edge.
  //
  // This effect used to depend on a live playhead value, so while one edge was
  // armed it pushed a fresh object into App state every frame — and App state
  // means the whole App tree re-rendered at source fps, during the exact
  // gesture where the editor is scrubbing to find the other end of a comment.
  // An earlier fix stopped the BOTH-marks-set case from doing it; the
  // one-edge-armed case is the gesture itself, so it was the case that
  // mattered.
  //
  // Nothing here needs the playhead. The armed mark is fixed, the band's other
  // end is wherever the playhead is right now, and the one consumer is a band
  // on the timeline — so the timeline reads the playhead itself, the same way
  // its own cursor does. This effect now fires only when a mark actually moves.
  useEffect(() => {
    if (rangeIn == null && rangeOut == null) { onRangeDraft?.(null); return; }
    if (rangeArmed) {
      // One edge marked: hand over the anchor and let the band follow.
      onRangeDraft?.({ anchor: (rangeIn ?? rangeOut)!, color: authorColor, live: true });
      return;
    }
    onRangeDraft?.({ start: rangeIn!, end: rangeOut!, color: authorColor, live: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeIn, rangeOut, rangeArmed, authorColor]);
  useEffect(() => () => onRangeDraft?.(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  // Hotkey registration — App dispatches ⇧I/⇧O here, gated on the Review tab
  // being active in the docked drawer. No deps: re-registers every render so
  // the handlers never close over stale range state; unmount registers null.
  useEffect(() => {
    onRegisterRangeHotkeys?.({ markIn: markRangeIn, markOut: markRangeOut });
    return () => onRegisterRangeHotkeys?.(null);
  });
  // Collapsed reply threads (Reddit-style) — per-comment UI state, deliberately
  // NOT persisted: threads default to expanded on every load.
  const [collapsedThreads, setCollapsedThreads] = useState<ReadonlySet<string>>(new Set());
  const toggleThread = (id: string) => setCollapsedThreads((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const [searchOpen, setSearchOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<ReviewHistoryEntry[]>([]);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // Panel root — measured for the composer-resize 60%-of-panel cap.
  const rootRef = useRef<HTMLDivElement>(null);

  /**
   * Where focus goes when a comment or reply is deleted.
   *
   * The delete button sits INSIDE the card it destroys, so React unmounts the
   * focused node and focus falls to <body> - the keyboard then restarts from
   * the top of the document, which on this screen is a long way from the
   * comment you were reading (WCAG 2.4.3, Level A). Nothing caught it: the
   * focus specs check dialogs and popovers, not a list that loses a row.
   *
   * The list itself is the catcher rather than the neighbouring card. Focusing
   * a neighbour reads better, but it needs the surviving id captured before
   * the dispatch and re-focused after the re-render, in two components, with
   * an empty-list case anyway. The container is one line, always correct, and
   * leaves the next Tab where the user was.
   */
  const listRef = useRef<HTMLDivElement>(null);
  const catchFocus = useCallback(() => {
    // Only if the delete actually orphaned focus. A row whose menu moved focus
    // somewhere deliberate must keep it.
    if (document.activeElement === document.body || document.activeElement == null) {
      listRef.current?.focus();
    }
  }, []);
  // ── Composer height (drag-resizable split vs the comment list) ──────
  // null = auto-size; a number = user-dragged fixed height. Mirrored into a
  // ref because autosizeComposer is also called from once-registered
  // dictation listeners whose closures would otherwise see the mount value.
  const [composerHeight, setComposerHeight] = useState<number | null>(loadComposerHeight);
  const [composerResizing, setComposerResizing] = useState(false);
  const composerHeightRef = useRef<number | null>(composerHeight);
  // Popover containers — used by the unified outside-click/Escape dismissal.
  const exportWrapRef = useRef<HTMLDivElement>(null);
  const historyWrapRef = useRef<HTMLDivElement>(null);
  const searchRowRef = useRef<HTMLDivElement>(null);
  const searchBtnRef = useRef<HTMLButtonElement>(null);
  // Clock for the relative timestamps ("just now", "12m ago") on every
  // comment, reply and history card.
  //
  // This used to be a bare `Date.now()` read during render, and it stayed
  // honest during playback only by ACCIDENT: the panel's old top-level
  // playhead subscription re-rendered it 60 times a second, so the value was
  // never more than a frame stale. Pushing that subscription down into the
  // composer took the accident away and left every label frozen at whenever
  // the panel last rendered for some other reason — press play, come back ten
  // minutes later, and a comment posted at the start still reads "just now".
  //
  // So make it deliberate and cheap. `timeAgo` is coarse (it says "just now"
  // below 45 seconds and whole minutes above), which means a 30s tick can
  // never be visibly wrong, and it costs one re-render per 30s instead of one
  // per frame. Paused while the window is hidden — a backgrounded panel has
  // nobody to be stale for — and resynced the moment it comes back.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let id = 0;
    const start = () => {
      setNow(Date.now());
      id = window.setInterval(() => setNow(Date.now()), 30_000);
    };
    const stop = () => { if (id) { window.clearInterval(id); id = 0; } };
    const onVisibility = () => (document.hidden ? stop() : start());
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { stop(); document.removeEventListener("visibilitychange", onVisibility); };
  }, []);

  // ── Voice dictation (mic → text) ──────────────────────────────────
  // `recording` = mic live; `transcribing` = stopped, ASR running. The
  // active job id lives in a ref so the event listener (registered once)
  // always matches the latest recording.
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [dictError, setDictError] = useState<string | null>(null);
  const [dictNote, setDictNote] = useState<string | null>(null);
  const dictJobRef = useRef<string | null>(null);
  // Latest mic level (0..1) for the waveform — a ref so 20 Hz updates from the
  // backend never re-render React; DictationWave reads it in its rAF loop.
  const micLevelRef = useRef(0);
  // Composer text snapshot taken when dictation starts. Live partials and the
  // final transcript are appended onto THIS, so streaming words replace cleanly
  // and a cancel/error reverts to exactly what was typed before.
  const dictBaseRef = useRef("");

  // Append dictated text onto the pre-dictation snapshot with one separating space.
  const withDictation = (t: string) => {
    const base = dictBaseRef.current;
    if (!t) return base;
    return base.trim() ? base.replace(/\s*$/, "") + " " + t : t;
  };

  useEffect(() => {
    const unDone = listen<DictateDoneEvent>("dictate-done", (e) => {
      if (e.payload.job_id !== dictJobRef.current) return;
      dictJobRef.current = null;
      micLevelRef.current = 0;
      setRecording(false);
      setTranscribing(false);
      if (e.payload.success) {
        setText(withDictation((e.payload.text ?? "").trim()));
        setDictNote(e.payload.note ?? null); // e.g. hit the 5-minute cap
      } else {
        setText(dictBaseRef.current); // revert any live partials
        if (e.payload.error && e.payload.error !== "Cancelled") setDictError(e.payload.error);
      }
      requestAnimationFrame(autosizeComposer);
      dictBaseRef.current = "";
    });
    // Native path only: interim transcript while still speaking → live update.
    const unPartial = listen<DictatePartialEvent>("dictate-partial", (e) => {
      if (e.payload.job_id !== dictJobRef.current) return;
      setText(withDictation(e.payload.text));
      requestAnimationFrame(autosizeComposer);
    });
    const unLevel = listen<DictateLevelEvent>("dictate-level", (e) => {
      if (e.payload.job_id === dictJobRef.current) micLevelRef.current = e.payload.level;
    });
    return () => { unDone.then((f) => f()); unPartial.then((f) => f()); unLevel.then((f) => f()); };
  }, []);

  // Safety net: the panel is conditionally mounted (drawer tab switch / source
  // change unmounts it). If a recording is still live, cancel it so the mic
  // isn't left hot with no in-app way to stop it. cancel_job SIGKILLs ffmpeg;
  // the backend drain task treats that as "Cancelled" and discards the WAV.
  useEffect(() => () => {
    const j = dictJobRef.current;
    if (j) invoke("cancel_job", { jobId: j }).catch(() => { /* best-effort */ });
  }, []);

  // One robust dismissal for all three popovers (export / history / search):
  // outside-click + Escape, only wired while something is open. Replaces the
  // brittle per-button onBlur+setTimeout (which never closed on a click into the
  // non-focusable comment list, and gave search no outside-click at all).
  useEffect(() => {
    if (!exportOpen && !historyOpen && !searchOpen) return;
    const outside = (ref: React.RefObject<HTMLElement>, t: Node) => !ref.current || !ref.current.contains(t);
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (exportOpen && outside(exportWrapRef, t)) setExportOpen(false);
      if (historyOpen && outside(historyWrapRef, t)) setHistoryOpen(false);
      if (searchOpen && outside(searchRowRef, t) && outside(searchBtnRef, t)) { setSearch(""); setSearchOpen(false); }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setExportOpen(false); setHistoryOpen(false);
      if (searchOpen) { setSearch(""); setSearchOpen(false); }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
  }, [exportOpen, historyOpen, searchOpen]);

  // Export status banner is transient — auto-clear after a few seconds (and it's
  // also click-to-dismiss). Re-armed whenever the message changes.
  useEffect(() => {
    if (!exportMsg) return;
    const t = window.setTimeout(() => setExportMsg(null), 4000);
    return () => window.clearTimeout(t);
  }, [exportMsg]);

  const toggleDictation = async () => {
    if (!ensureNamed()) return;
    if (recording) {
      // Graceful stop → backend finalizes + transcribes, then emits dictate-done.
      setTranscribing(true);
      try { await invoke("dictate_stop", { jobId: dictJobRef.current }); }
      catch { /* drain task still resolves via the event */ }
      setRecording(false);
      return;
    }
    setDictError(null);
    setDictNote(null);
    micLevelRef.current = 0;
    dictBaseRef.current = text; // partials + final append onto what's already typed
    try {
      const job = newJobId();
      dictJobRef.current = job;
      try {
        // Prefer the native, on-device, LIVE-streaming path (Apple Speech):
        // words appear in the composer as you speak.
        await invoke("dictate_native_start", { jobId: job, locale: "en-US" });
      } catch {
        // Native sidecar unavailable → fall back to ffmpeg → Whisper/Parakeet
        // (batch after stop). Mic chosen in Settings → Transcription.
        const device = loadJson<string>("saucebunny.dictation.device", "default");
        // Dictation language follows Settings → Transcription → Language
        // (whisper `-l`; "auto" = detect). Read from the persisted defaults
        // blob at call time — the same live-read pattern as the mic device
        // above; "cp-defaults-v2" mirrors App's DEFAULTS_KEY (kept as a
        // literal to avoid an App↔panel import).
        const language = loadJson<{ transcriptionLanguage?: string }>("cp-defaults-v2", {})
          .transcriptionLanguage ?? "auto";
        await invoke("dictate_start", { jobId: job, device, language });
      }
      setRecording(true);
    } catch (e) {
      dictJobRef.current = null;
      dictBaseRef.current = "";
      setDictError(formatError(e));
    }
  };

  // Identity changes (name/colour) → notify so the timeline markers recolour.
  const notifyIdentity = () => {
    try { window.dispatchEvent(new CustomEvent(REVIEW_CHANGED_EVENT)); } catch { /* non-DOM */ }
  };
  const saveAuthor = (n: string) => {
    const v = n.trim();
    if (!v) return;
    setAuthor(v);
    saveJson(AUTHOR_KEY, v);
    setNameModal(false);
    notifyIdentity();
  };
  const pickAuthorColor = (c: string) => { setAuthorColor(c); saveJson(AUTHOR_COLOR_KEY, c); notifyIdentity(); };
  // Gate any compose action behind a one-time name prompt (first-run modal).
  const ensureNamed = (): boolean => {
    if (author.trim()) return true;
    setNameInput("");
    setNameModal(true);
    return false;
  };
  // Re-open the name prompt to change it (prefilled with the current name).
  const openRename = () => { setNameInput(author); setNameModal(true); };
  const autosizeComposer = () => {
    const ta = composerRef.current;
    if (!ta) return;
    // Hidden keep-alive tab (display:none ancestor) measures clientHeight 0 —
    // skip the re-measure so background dictation events can't stamp a
    // collapsed height; the styles set while visible remain correct.
    if (rootRef.current && rootRef.current.clientHeight === 0) return;
    const manual = composerHeightRef.current;
    if (manual != null) {
      // Manual mode: the typing area is exactly the dragged height — content
      // scrolls inside it. Inline maxHeight beats the stylesheet's 140px cap
      // so a tall composer actually gets tall; re-clamping against the live
      // panel height self-heals when the window/drawer shrinks.
      const cap = rootRef.current ? Math.round(rootRef.current.clientHeight * 0.6) : COMPOSER_LOAD_MAX;
      const h = Math.max(COMPOSER_MIN, Math.min(manual, cap));
      ta.style.maxHeight = h + "px";
      ta.style.height = h + "px";
      return;
    }
    ta.style.maxHeight = ""; // back to the stylesheet's 140px cap
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 140) + "px";
  };
  // Keep the ref in sync, re-apply the height, persist. Removal (null)
  // returns the key to "auto" for the next launch.
  useEffect(() => {
    composerHeightRef.current = composerHeight;
    autosizeComposer();
    try {
      if (composerHeight == null) localStorage.removeItem(COMPOSER_HEIGHT_KEY);
      else localStorage.setItem(COMPOSER_HEIGHT_KEY, String(composerHeight));
    } catch { /* quota */ }
  }, [composerHeight]);
  const onComposerResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = composerHeightRef.current
      ?? composerRef.current?.getBoundingClientRect().height
      ?? COMPOSER_MIN;
    const cap = rootRef.current ? Math.round(rootRef.current.clientHeight * 0.6) : COMPOSER_LOAD_MAX;
    setComposerResizing(true);
    document.body.classList.add("cp-resizing-ns");
    function onMove(ev: MouseEvent) {
      // Dragging UP grows the composer (cursor delta is negative upward).
      setComposerHeight(Math.max(COMPOSER_MIN, Math.min(cap, Math.round(startH + (startY - ev.clientY)))));
    }
    function onUp() {
      setComposerResizing(false);
      document.body.classList.remove("cp-resizing-ns");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  /**
   * The keyboard half of the composer resize.
   *
   * The handle carried role="separator" and aria-label="Resize comment box"
   * with onMouseDown and nothing else, so the composer height could not be
   * changed by keyboard at all (WCAG 2.1.1, Level A). Two of the app's four
   * resize handles already had tabIndex + arrows; this was one of the two that
   * did not.
   *
   * Up/Down rather than Left/Right, because this splitter is horizontal and
   * moves the boundary vertically - and it grows UPWARD, matching the drag
   * (dragging up grows the composer). Home clears the manual height, which is
   * the same thing the double-click reset does. The 60%-of-panel cap is read
   * the same way the drag reads it, so the two paths stop at the same place.
   */
  const onComposerResizeKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 32 : 8;
    if (e.key === "Home") { e.preventDefault(); setComposerHeight(null); return; }
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const cap = rootRef.current ? Math.round(rootRef.current.clientHeight * 0.6) : COMPOSER_LOAD_MAX;
    const current = composerHeightRef.current
      ?? composerRef.current?.getBoundingClientRect().height
      ?? COMPOSER_MIN;
    const delta = e.key === "ArrowUp" ? step : -step;
    setComposerHeight(Math.max(COMPOSER_MIN, Math.min(cap, Math.round(current + delta))));
  };

  // Load (and ensure a version exists) whenever the source changes.
  useEffect(() => {
    // Clear transient dictation banners so a previous clip's error/note doesn't
    // linger over the new one.
    setDictError(null);
    setDictNote(null);
    setCollapsedThreads(new Set()); // new source → all threads back to expanded
    setLinkDismissed(false); // the "new cut of X?" offer is per-source
    clearRange(); // an armed range from the previous clip would be nonsense here
    if (!sourceKey) { setDoc(null); return; }
    const { doc: d } = ensureVersion(loadReview(sourceKey), sourceKey, sourceTitle ?? undefined);
    saveReview(d);
    setDoc(d);
  }, [sourceKey, sourceTitle]);

  // One mutate helper: apply a pure op, persist, set state. (Solo path only.)
  const mutate = (fn: (d: ReviewDoc) => ReviewDoc) => {
    setDoc((prev) => {
      if (!prev) return prev;
      const next = fn(prev);
      saveReview(next);
      return next;
    });
  };

  // ── Co-review awareness ────────────────────────────────────────────
  // In a session the SHARED doc is the source of truth for both display and
  // mutation; solo, it's the local-by-sourceKey doc. `inSession` follows the
  // session being ACTIVE (not the doc arriving) so a joined-but-connecting
  // peer never falls back to the solo path and posts into the void. `dispatch`
  // sends an op to the session (App applies + relays) or mutates locally.
  const inSession = sessionActive;
  const connecting = inSession && !sessionDoc;
  const viewDoc = inSession ? sessionDoc : doc;
  const dispatch = (op: ReviewOp, localFn: (d: ReviewDoc) => ReviewDoc) => {
    if (inSession) onSessionOp?.(op);
    else mutate(localFn);
  };

  // ── Undo integration (lib/undo.ts) ─────────────────────────────────
  // CO-REVIEW SAFETY: entries are pushed ONLY from this panel's own handlers
  // (via dispatchUndoable below) — the funnel every LOCAL mutation goes
  // through. Ops arriving from peers land in useCoReview's session:msg
  // listener and never gain an inverse, so ⌘Z can only take back the user's
  // own actions. App additionally clears the stack on session join/leave and
  // source change, so a captured entry can never replay against the wrong
  // doc/mode.
  //
  // Replay is self-contained: in a session it re-enters the op relay; solo it
  // goes straight to localStorage — deliberately NOT through this instance's
  // state, because the ⌘Z keydown lives in App and may fire after this panel
  // instance unmounted (drawer tab switch). saveReview fires
  // REVIEW_CHANGED_EVENT, which the effect below folds back into a mounted
  // panel's state.
  const replayOps = (ops: ReviewOp[]) => {
    if (ops.length === 0) return;
    if (inSession) { for (const op of ops) onSessionOp?.(op); return; }
    if (!sourceKey) return;
    let d = loadReview(sourceKey);
    for (const op of ops) d = applyReviewOp(d, op);
    saveReview(d);
  };
  // Dispatch + record. The inverse ops are computed EAGERLY from the pre-op
  // doc so the undo closure holds only the small inverse-op array (at most
  // the deleted comment + its replies), never the whole ReviewDoc — pinning
  // up to 50 full doc snapshots in the app-wide stack was a memory leak.
  // LWW timestamps are re-stamped at EXECUTION time on undo AND redo so the
  // replay wins the LWW guard of whatever it reverses. Re-adds carry the
  // original comment (same id/timestamps — insertComment is idempotent by
  // id), so undo/redo of adds and deletes converges cleanly in co-review.
  const dispatchUndoable = (label: string, op: ReviewOp, localFn: (d: ReviewDoc) => ReviewDoc) => {
    const before = viewDoc; // ops are pure — `before` stays an immutable snapshot
    dispatch(op, localFn);
    if (!before) return;
    const inverse = inverseReviewOps(before, op); // `at` is a placeholder — re-stamped on undo
    appUndo.push({
      label,
      undo: () => { const at = Date.now(); replayOps(inverse.map((o) => restampReviewOp(o, at))); },
      redo: () => replayOps([restampReviewOp(op, Date.now())]),
    });
  };

  /**
   * Import a batch of pasted producer notes as comments — ONE undo step.
   *
   * Routing thirteen notes through dispatchUndoable would work, but undoing a
   * mis-parsed paste would then take thirteen ⌘Z presses, each silently
   * deleting a comment the user can't see from the composer. One entry whose
   * inverse deletes the whole batch matches what the user did: one paste.
   * In co-review the adds still relay as individual ops — that is the wire
   * format peers converge on — but the undo entry is local and batched.
   */
  const importNotes = (rows: ImportedNote[], noteAuthor: string) => {
    if (!viewDoc || !versionId || rows.length === 0) return;
    const base = Date.now();
    const comments = rows.map((r, i) => buildComment({
      versionId,
      // A general note anchors at 0: it has no spot, and the head of the cut
      // is where an untimed "big picture" note reads naturally in a time sort.
      timeStart: r.startSec ?? 0,
      timeEnd: r.endSec,
      body: r.body,
      author: noteAuthor,
    // base + i keeps the pasted order stable under "newest" sort, which
    // ties on identical createdAt values otherwise.
    }, base + i));
    const ops: ReviewOp[] = comments.map((c) => ({ t: "add", comment: c }));
    // Batch inverses come from the lib, in replay order. This loop used to be
    // written out here and accumulated its inverses FORWARDS, which is only
    // correct because a paste is all-adds; see inverseReviewOpsBatch.
    const inverse = inverseReviewOpsBatch(viewDoc, ops);
    if (inSession) { for (const op of ops) onSessionOp?.(op); }
    else mutate((d) => ops.reduce((acc, op) => applyReviewOp(acc, op), d));
    appUndo.push({
      label: `import ${comments.length} ${comments.length === 1 ? "note" : "notes"}`,
      undo: () => { const at = Date.now(); replayOps(inverse.map((o) => restampReviewOp(o, at))); },
      redo: () => { const at = Date.now(); replayOps(ops.map((o) => restampReviewOp(o, at))); },
    });
    setPasteOpen(false);
  };
  // Fold external solo-mode writes (an undo/redo replay, possibly from a
  // closure that outlived a previous panel instance) back into local state.
  // Echoes of our own saves are harmless — same data re-read.
  useEffect(() => {
    if (sessionActive || !sourceKey) return;
    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ sourceKey?: string }>).detail;
      if (!detail || detail.sourceKey === sourceKey) setDoc(loadReview(sourceKey));
    };
    window.addEventListener(REVIEW_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(REVIEW_CHANGED_EVENT, onChanged);
  }, [sessionActive, sourceKey]);
  // On leaving a session, reload the local doc — App persisted the merged
  // collaborative doc to storage, so the panel must re-read it (its local
  // `doc` state predates the session's comments).
  const wasInSessionRef = useRef(false);
  useEffect(() => {
    const was = wasInSessionRef.current;
    wasInSessionRef.current = inSession;
    if (was && !inSession && sourceKey) setDoc(loadReview(sourceKey));
  }, [inSession, sourceKey]);

  const versionId = viewDoc?.activeVersionId ?? null;
  const roots = useMemo(
    () => (viewDoc ? rootComments(viewDoc, versionId, sort) : []),
    [viewDoc, versionId, sort],
  );
  const open = viewDoc ? openCount(viewDoc, versionId) : 0;
  const resolved = roots.length - open;

  // ── Version stacks (solo only — a session shares one doc, one view) ──
  const versions = viewDoc?.versions ?? [];
  const [versionsOpen, setVersionsOpen] = useState(false);
  const versionsWrapRef = useRef<HTMLDivElement>(null);
  /** Unresolved notes from the stack's OTHER versions — the carry-forward
   *  list this whole feature exists for. */
  const carried = useMemo(
    () => (viewDoc && !inSession ? carriedComments(viewDoc, versionId) : []),
    [viewDoc, versionId, inSession],
  );
  /** "New cut of X?" — offered only while this doc is a blank slate, because
   *  once comments exist here, absorbing the doc elsewhere would strand them. */
  const [linkDismissed, setLinkDismissed] = useState(false);
  const linkCandidate = useMemo(() => {
    if (inSession || !onLinkAsVersion || !sourceKey || !viewDoc) return null;
    if (viewDoc.comments.length > 0 || viewDoc.versions.length > 1) return null;
    return versionCandidates(sourceTitle ?? "", sourceKey, loadReviewHistory())[0] ?? null;
  }, [inSession, onLinkAsVersion, sourceKey, viewDoc, sourceTitle]);

  const switchVersion = (id: string) => {
    // View state, not an edit: persisted so the stack re-opens where you left
    // it, but deliberately NOT an undo entry.
    mutate((d) => setActiveVersion(d, id));
    setVersionsOpen(false);
  };

  // Same deferred-a-tick outside-click dismissal as the other popovers.
  useEffect(() => {
    if (!versionsOpen) return;
    function onDoc(e: MouseEvent) {
      if (!versionsWrapRef.current?.contains(e.target as Node)) setVersionsOpen(false);
    }
    const t = setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
    return () => { clearTimeout(t); document.removeEventListener("mousedown", onDoc); };
  }, [versionsOpen]);

  // Replies, bucketed by parent, once per document.
  //
  // This was `repliesOf(viewDoc, c.id)` inline in the row map, so rendering N
  // roots scanned and sorted the whole comment array N times. The scan was the
  // smaller half of the problem: it also handed every row a brand-new array on
  // every render, which forecloses memoizing CommentRow later. One pass, and
  // each root keeps the same array identity until the doc actually changes.
  const repliesByParent = useMemo(() => {
    const m = new Map<string, ReviewComment[]>();
    if (!viewDoc) return m;
    for (const c of viewDoc.comments) {
      if (!c.parentId) continue;
      const bucket = m.get(c.parentId);
      if (bucket) bucket.push(c);
      else m.set(c.parentId, [c]);
    }
    for (const bucket of m.values()) bucket.sort((a, b) => a.createdAt - b.createdAt);
    return m;
  }, [viewDoc]);

  // The visible list = current open/resolved filter ∩ text search (body or author).
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return roots.filter((c) => {
      if (filter === "open" && c.resolved) return false;
      if (filter === "resolved" && !c.resolved) return false;
      if (q && !(c.body.toLowerCase().includes(q) || c.author.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [roots, filter, search]);

  if (connecting) {
    return (
      <div className="cp-pane-empty cp-review-empty">
        <p>Connecting to the session…</p>
        <p className="sub">Loading the shared review from the host.</p>
      </div>
    );
  }
  if (!viewDoc || !versionId || (!inSession && !sourceKey)) {
    return (
      <div className="cp-pane-empty cp-review-empty">
        <p>Load a source to start a review.</p>
        <p className="sub">Timecoded comments, resolved and signed off. All local.</p>
      </div>
    );
  }

  const submit = () => {
    const body = text.trim();
    const hasDrawing = annotationHasContent(draft);
    if (!body && !hasDrawing) return;
    if (!ensureNamed()) return;
    // Post column of the range machine: a SET range posts as-is; an ARMED
    // range commits the live span the pill is showing — the SAME clamped
    // values the preview computes (scrubbing behind an armed IN / ahead of
    // an armed OUT collapses to the mark), degrading to a point comment.
    // The latched moment, not the live playhead - see anchorSec.
    const { timeStart, timeEnd } = rangeToPost(
      { in: rangeIn, out: rangeOut }, anchorSec ?? playheadAt() ?? 0,
    );
    const comment = buildComment({
      versionId,
      timeStart,
      timeEnd,
      body: body || "(drawing)",
      author,
      annotation: hasDrawing ? draft : null,
    });
    dispatchUndoable("add comment", { t: "add", comment }, (d) => insertComment(d, comment));
    setText("");
    setAnchorSec(null);
    clearRange();
    // Re-measure after React flushes the cleared text — collapses in auto
    // mode, holds the dragged height in manual mode.
    requestAnimationFrame(autosizeComposer);
    if (hasDrawing) onDraftConsumed?.();
  };
  const submitReply = (parentId: string, atTime: number) => {
    const body = replyDraft.trim();
    if (!body) return;
    if (!ensureNamed()) return; // gate like submit() — no empty-author replies
    const reply = buildComment({ versionId, timeStart: atTime, body, author, parentId });
    dispatchUndoable("add reply", { t: "add", comment: reply }, (d) => insertComment(d, reply));
    setReplyDraft("");
    setReplyTo(null);
  };

  const doExport = async (kind: ExportKind) => {
    setExportOpen(false);
    if (!viewDoc) return;
    const title = sourceTitle ?? "Sauce Bunny Review";
    const f = {
      md:       { ext: "md",     name: "Markdown",            text: reviewToMarkdown(viewDoc, sourceTitle ?? "Review") },
      avid:     { ext: "txt",    name: "Avid Media Composer", text: markersToAvidTxt(viewDoc, markerSettings, title) },
      premiere: { ext: "xml",    name: "Adobe Premiere",      text: markersToPremiereXml(viewDoc, markerSettings, title) },
      resolve:  { ext: "edl",    name: "DaVinci Resolve",     text: markersToResolveEdl(viewDoc, markerSettings, title) },
      fcpx:     { ext: "fcpxml", name: "Final Cut Pro",       text: markersToFcpxml(viewDoc, markerSettings, title) },
      csv:      { ext: "csv",    name: "CSV",                 text: markersToCsv(viewDoc, markerSettings, title) },
    }[kind];
    const base = (sourceTitle ?? "review").replace(/[^\w.-]+/g, "-").slice(0, 60) || "review";
    try {
      const path = await saveDialog({ defaultPath: `${base}-review.${f.ext}`, filters: [{ name: f.name, extensions: [f.ext] }] });
      if (typeof path !== "string" || !path) return;
      await invoke("write_text_to_path", { path, text: f.text, atomic: true });
      setExportMsg(`Exported ${f.name} → ${path.split("/").pop()}`);
    } catch {
      setExportMsg("Export failed.");
    }
  };

  return (
    <div className="cp-review" ref={rootRef}>
      <ReviewToolbar
        filter={filter} setFilter={setFilter}
        counts={{ all: roots.length, open, resolved }}
        searchOpen={searchOpen} setSearchOpen={setSearchOpen}
        clearSearch={() => setSearch("")} searchBtnRef={searchBtnRef}
        sort={sort} setSort={setSort}
        exportOpen={exportOpen} setExportOpen={setExportOpen} exportWrapRef={exportWrapRef}
        doExport={doExport} exportDisabled={roots.length === 0}
        markerSettings={markerSettings} onMarkerSettingsChange={updateMarkerSettings}
        onOpenReview={onOpenReview}
        historyOpen={historyOpen} setHistoryOpen={setHistoryOpen} historyWrapRef={historyWrapRef}
        history={history} setHistory={setHistory} now={now}
        author={author} authorColor={authorColor} openRename={openRename}
      />
      {searchOpen && (
        <div className="cp-review-search" ref={searchRowRef}>
          <SearchGlyph />
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") { setSearch(""); setSearchOpen(false); } }}
            placeholder="Search comments…"
          />
          {search && <button className="cp-review-search-clear" onClick={() => setSearch("")} title="Clear">✕</button>}
        </div>
      )}
      {exportMsg && <div className="cp-review-export-msg" onClick={() => setExportMsg(null)} title="Dismiss">{exportMsg}</div>}

      {/* Version stack row — only once the doc actually IS a stack. */}
      {!inSession && versions.length > 1 && (
        <div className="cp-review-verrow">
          <div className="cp-review-verwrap" ref={versionsWrapRef}>
            <button
              className="cp-review-verpill"
              onClick={() => setVersionsOpen((v) => !v)}
              aria-expanded={versionsOpen}
              title="Switch version"
            >
              {versions.find((v) => v.id === versionId)?.label ?? "V?"}
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {versionsOpen && (
              <div className="cp-review-verpop" role="listbox" aria-label="Versions">
                {[...versions].reverse().map((v) => (
                  <button
                    key={v.id}
                    role="option"
                    aria-selected={v.id === versionId}
                    className={"cp-review-veritem" + (v.id === versionId ? " current" : "")}
                    onClick={() => switchVersion(v.id)}
                    title={v.path}
                  >
                    <span className="cp-review-verlabel">{v.label}</span>
                    <span className="cp-review-vermeta">
                      {openCount(viewDoc, v.id)} open · {timeAgo(v.addedAt, now)}
                    </span>
                  </button>
                ))}
                {/* The wrong-link escape hatch. Two conditions, both load-bearing.
                    The viewed version must have no comments, so unlinking cannot
                    strand anything. And it must be the version of the file that
                    is actually OPEN: unlink acts on the open file, so offering
                    it while you are viewing an older cut would remove a
                    different version than the one the word "this" points at —
                    or, if the open file had comments, silently do nothing. */}
                {onUnlinkVersion && canUnlinkVersion(viewDoc, versionId, sourcePath ?? null) && (
                  <button
                    className="cp-review-verunlink"
                    onClick={() => { onUnlinkVersion(); setVersionsOpen(false); }}
                    title="Not actually a new cut of this review? Take it back out of the stack."
                  >
                    Unlink this cut
                  </button>
                )}
              </div>
            )}
          </div>
          {carried.length > 0 && (
            <span className="cp-review-vercarry">
              {carried.length} still open from earlier {carried.length === 1 ? "cut" : "cuts"}
            </span>
          )}
        </div>
      )}

      {/* "New cut of X?" — the one-click stack link. Offered, never guessed:
          name similarity surfaces the candidate, the person confirms it. */}
      {linkCandidate && !linkDismissed && (
        <div className="cp-review-linkoffer">
          <span className="cp-review-linkoffer-text">
            New cut of <strong>{linkCandidate.title}</strong>?
          </span>
          <button
            className="btn btn-ghost btn-compact"
            onClick={() => onLinkAsVersion!(linkCandidate.key)}
            title={`Carry ${linkCandidate.count} ${linkCandidate.count === 1 ? "note" : "notes"} forward from ${linkCandidate.title}`}
          >
            Link as new version
          </button>
          <button
            className="cp-review-linkoffer-x"
            onClick={() => setLinkDismissed(true)}
            title="Not a new cut, dismiss"
            aria-label="Dismiss"
          >✕</button>
        </div>
      )}

      {/* Comment list */}
      <div className="cp-review-list" ref={listRef} tabIndex={-1}>
        {roots.length === 0 && carried.length === 0 && (
          <div className="cp-review-hint">No comments yet. Scrub to a spot and add one below.</div>
        )}
        {roots.length > 0 && visible.length === 0 && (
          <div className="cp-review-hint">
            {search.trim() ? "No comments match your search." : filter === "open" ? "No open comments. All signed off." : "No resolved comments yet."}
          </div>
        )}
        {visible.map((c) => (
          <CommentRow
            key={c.id}
            c={c}
            now={now}
            fps={fps}
            myName={author}
            myColor={authorColor}
            replies={repliesByParent.get(c.id) ?? NO_REPLIES}
            onSeek={onSeek}
            onMarkRange={onMarkRange}
            onQueueRange={onQueueRange}
            onShowAnnotation={onShowAnnotation}
            onResolve={() => { const at = Date.now(), v = !c.resolved; dispatchUndoable(v ? "resolve comment" : "reopen comment", { t: "resolve", id: c.id, resolved: v, at }, (d) => setResolved(d, c.id, v, at)); }}
            onDelete={() => { dispatchUndoable("delete comment", { t: "del", id: c.id }, (d) => deleteComment(d, c.id)); catchFocus(); }}
            onEdit={(body) => { const at = Date.now(); dispatchUndoable("edit comment", { t: "edit", id: c.id, body, at }, (d) => editComment(d, c.id, body, at)); }}
            onLike={(emoji) => { if (!ensureNamed()) return; const liked = !(reactionsOf(c)[emoji] ?? []).includes(author); dispatch({ t: "like", id: c.id, name: author, liked, emoji }, (d) => setLike(d, c.id, author, liked, emoji)); }}
            onEditReply={(replyId, body) => { const at = Date.now(); dispatchUndoable("edit reply", { t: "editReply", versionId, commentId: c.id, replyId, body, at }, (d) => editReply(d, versionId, c.id, replyId, body, at)); }}
            onDeleteReply={(replyId) => { dispatchUndoable("delete reply", { t: "delReply", versionId, commentId: c.id, replyId }, (d) => removeReply(d, versionId, c.id, replyId)); catchFocus(); }}
            onLikeReply={(replyId, emoji) => { if (!ensureNamed()) return; const r = viewDoc.comments.find((x) => x.id === replyId); if (!r) return; const liked = !(reactionsOf(r)[emoji] ?? []).includes(author); dispatch({ t: "like", id: replyId, name: author, liked, emoji }, (d) => setLike(d, replyId, author, liked, emoji)); }}
            collapsed={collapsedThreads.has(c.id)}
            onToggleCollapse={() => toggleThread(c.id)}
            replyOpen={replyTo === c.id}
            onToggleReply={() => { setReplyTo(replyTo === c.id ? null : c.id); setReplyDraft(""); }}
            replyDraft={replyDraft}
            setReplyDraft={setReplyDraft}
            onSubmitReply={() => submitReply(c.id, c.timeStart)}
          />
        ))}

        {/* Carry-forward: unresolved notes from the stack's other versions,
            LIVE while the new cut plays. This is the divergence from
            Frame.io, where old comments stay behind on the old asset and the
            documented workaround is copy-paste. A notes pass on v2 is exactly
            "check the new cut against the old notes", so the old notes sit
            here, seekable and resolvable, until they are dealt with. */}
        {carried.length > 0 && (
          <>
            <div className="cp-review-carried-head">Still open from earlier cuts</div>
            {carried.map(({ comment: c, versionLabel }) => (
              <div key={c.id} className="cp-review-carried">
                <button
                  className="cp-review-carried-tc"
                  onClick={() => onSeek(c.timeStart)}
                  title="Jump to this point"
                >
                  {secondsToHms(c.timeStart).replace(/^00:/, "")}
                </button>
                <span className="cp-review-carried-ver" title={`Noted on ${versionLabel}`}>{versionLabel}</span>
                <span className="cp-review-carried-body">
                  <span className="cp-review-carried-author">{c.author}</span> {c.body}
                </span>
                <button
                  className="cp-review-carried-resolve"
                  onClick={() => {
                    const at = Date.now();
                    dispatchUndoable("resolve comment", { t: "resolve", id: c.id, resolved: true, at }, (d) => setResolved(d, c.id, true, at));
                  }}
                  title="Resolve: dealt with in this cut"
                >
                  Resolve
                </button>
              </div>
            ))}
          </>
        )}
      </div>

      <ReviewComposer
        drawActive={drawActive}
        onToggleDraw={onToggleDraw}
        labelActive={labelActive}
        onToggleLabel={onToggleLabel}
        ensureNamed={ensureNamed}
        recording={recording}
        transcribing={transcribing}
        dictError={dictError} clearDictError={() => setDictError(null)}
        dictNote={dictNote} clearDictNote={() => setDictNote(null)}
        toggleDictation={toggleDictation}
        levelRef={micLevelRef}
        text={text} setText={setTextLatching} anchorSec={anchorSec}
        composerRef={composerRef} autosize={autosizeComposer}
        onResizeStart={onComposerResizeStart}
        onResizeKey={onComposerResizeKey}
        resizing={composerResizing}
        onResizeReset={() => setComposerHeight(null)}
        submit={submit} hasDraft={annotationHasContent(draft)}
        playheadActive={playheadActive} fps={fps}
        rangeIn={rangeIn} rangeOut={rangeOut} onRangeTap={tapRange} onRangeClear={clearRange}
        rangeColor={authorColor}
        onPasteNotes={() => setPasteOpen(true)}
      />

      {pasteOpen && (
        <PasteNotesModal
          durationSec={durationSec}
          fps={fps}
          defaultAuthor={author}
          onImport={importNotes}
          onClose={() => setPasteOpen(false)}
        />
      )}

      {nameModal && (
        <NameGateModal
          author={author}
          authorColor={authorColor}
          nameInput={nameInput}
          setNameInput={setNameInput}
          onSave={saveAuthor}
          onClose={() => setNameModal(false)}
          onPickColor={pickAuthorColor}
        />
      )}
    </div>
  );
}

/** Top toolbar: comment filter + search toggle + sort + export menu + past-reviews + whoami. */
function ReviewToolbar({
  filter, setFilter, counts,
  searchOpen, setSearchOpen, clearSearch, searchBtnRef,
  sort, setSort,
  exportOpen, setExportOpen, exportWrapRef, doExport, exportDisabled,
  markerSettings, onMarkerSettingsChange,
  onOpenReview, historyOpen, setHistoryOpen, historyWrapRef, history, setHistory, now,
  author, authorColor, openRename,
}: {
  filter: "all" | "open" | "resolved";
  setFilter: (f: "all" | "open" | "resolved") => void;
  counts: { all: number; open: number; resolved: number };
  searchOpen: boolean;
  setSearchOpen: React.Dispatch<React.SetStateAction<boolean>>;
  clearSearch: () => void;
  searchBtnRef: React.RefObject<HTMLButtonElement>;
  sort: CommentSort;
  setSort: (s: CommentSort) => void;
  exportOpen: boolean;
  setExportOpen: React.Dispatch<React.SetStateAction<boolean>>;
  exportWrapRef: React.RefObject<HTMLDivElement>;
  doExport: (kind: ExportKind) => void;
  exportDisabled: boolean;
  markerSettings: MarkerExportSettings;
  onMarkerSettingsChange: (patch: Partial<MarkerExportSettings>) => void;
  onOpenReview?: (path: string) => void;
  historyOpen: boolean;
  setHistoryOpen: (b: boolean) => void;
  historyWrapRef: React.RefObject<HTMLDivElement>;
  history: ReviewHistoryEntry[];
  setHistory: (h: ReviewHistoryEntry[]) => void;
  now: number;
  author: string;
  authorColor: string;
  openRename: () => void;
}) {
  return (
    <div className="cp-review-toolbar">
      <div className="cp-review-filter" role="tablist" aria-label="Filter comments">
        {([
          { id: "all", label: "All", n: counts.all },
          { id: "open", label: "Open", n: counts.open },
          { id: "resolved", label: "Resolved", n: counts.resolved },
        ] as const).map((f) => (
          <button
            key={f.id}
            role="tab"
            aria-selected={filter === f.id}
            className={filter === f.id ? "active" : ""}
            onClick={() => setFilter(f.id)}
          >
            {f.label}<span className="n">{f.n}</span>
          </button>
        ))}
      </div>
      <div className="cp-review-toolbar-right">
        <button
          ref={searchBtnRef}
          className={"cp-review-iconbtn" + (searchOpen ? " active" : "")}
          onClick={() => { setSearchOpen((o) => { if (o) clearSearch(); return !o; }); }}
          aria-pressed={searchOpen}
          title="Search comments"
        >
          <SearchGlyph />
        </button>
        <select className="cp-select sm cp-review-sort" value={sort} onChange={(e) => setSort(e.target.value as CommentSort)} title="Sort comments">
          <option value="time">By timecode</option>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
        <div className="cp-review-export" ref={exportWrapRef}>
          {/* Icon trigger (matches the search/history icon buttons); the menu
              stays anchored to this wrapper via its position:relative. */}
          <button
            className={"cp-review-iconbtn" + (exportOpen ? " active" : "")}
            onClick={() => setExportOpen((o) => !o)}
            disabled={exportDisabled}
            aria-pressed={exportOpen}
            aria-label="Export review"
            title="Export review…"
          >
            <IconDownload size={14} strokeWidth={2} className="cp-review-glyph" />
          </button>
          {exportOpen && (
            /* onClick, NOT onMouseDown. These nine were mousedown-only, which
               means Enter and Space on a focused button did nothing at all -
               a keyboard user could open this menu, tab to Markdown, press
               Enter and get silence. Verified in webkit as well as chromium,
               since webkit is the engine this app ships in.

               The outside-click dismisser above listens on `pointerdown` and
               is scoped by exportWrapRef.contains(target), so a click inside
               the menu cannot close it before the click lands: mousedown was
               never load-bearing here. */
            <div className="cp-review-export-menu">
              <div className="cp-review-export-group">Notes</div>
              <button onClick={() => doExport("md")}>Markdown</button>
              <div className="cp-review-export-group">Markers</div>
              <button onClick={() => doExport("avid")}>Avid Media Composer</button>
              <button onClick={() => doExport("premiere")}>Adobe Premiere</button>
              <button onClick={() => doExport("resolve")}>DaVinci Resolve</button>
              <button onClick={() => doExport("fcpx")}>Final Cut Pro</button>
              <button onClick={() => doExport("csv")}>CSV</button>
              <MarkerSettingsRow settings={markerSettings} onChange={onMarkerSettingsChange} />
            </div>
          )}
        </div>
        {/* Past reviews — re-open a clip you've reviewed before. */}
        {onOpenReview && (
          <div className="cp-review-history" ref={historyWrapRef}>
            <button
              className={"cp-review-iconbtn" + (historyOpen ? " active" : "")}
              onClick={() => { const next = !historyOpen; setHistoryOpen(next); if (next) setHistory(loadReviewHistory()); }}
              aria-pressed={historyOpen}
              title="Past reviews"
            >
              <HistoryGlyph />
            </button>
            {historyOpen && (
              <div className="cp-review-history-menu">
                {history.length === 0 ? (
                  <div className="cp-review-history-empty">No past reviews yet. Reviewed clips show up here.</div>
                ) : history.map((h) => (
                  <div key={h.key} className="cp-review-history-item">
                    <button
                      className="cp-review-history-open"
                      onClick={() => { setHistoryOpen(false); onOpenReview(h.path); }}
                      title={h.path}
                    >
                      <span className="cp-review-history-title">{h.title}</span>
                      <span className="cp-review-history-meta">{h.count} note{h.count === 1 ? "" : "s"} · {timeAgo(h.updatedAt, now)}</span>
                    </button>
                    <button
                      className="cp-review-history-del"
                      onClick={(e) => { e.stopPropagation(); removeReviewHistory(h.key); setHistory(loadReviewHistory()); }}
                      title="Remove from history"
                    >✕</button>
                  </div>
                ))}
                {/* Bulk clear — history entries are just pointers, so no confirm:
                    the review docs themselves are never deleted from here. */}
                {history.length > 0 && (
                  <button
                    className="cp-review-history-clear"
                    onClick={() => { clearReviewHistory(); setHistory([]); }}
                    title="Clear the list. Review notes themselves are kept"
                  >Clear all</button>
                )}
              </div>
            )}
          </div>
        )}
        {/* Who you're reviewing as — click to set/change name + colour. */}
        <button
          className="cp-review-whoami"
          onClick={openRename}
          title={author ? `Reviewing as ${author} · click to rename` : "Set your name"}
        >
          <Avatar name={author || "?"} size={26} color={authorColor} />
        </button>
      </div>
    </div>
  );
}

/** Inline marker-export settings inside the export popover: frame rate, sequence
 *  Start TC (validated), and a drop-frame toggle that's only enabled on the two
 *  NTSC broadcast rates. The committed Start TC is only written back when it
 *  parses, so an export always uses a valid timecode. */
function MarkerSettingsRow({
  settings, onChange,
}: {
  settings: MarkerExportSettings;
  onChange: (patch: Partial<MarkerExportSettings>) => void;
}) {
  const [tcDraft, setTcDraft] = useState(settings.sequenceStartTc);
  const tcValid = tcToFrames(tcDraft, settings.frameRate, settings.dropFrame) !== null;
  const dropAllowed = RATE_TABLE[settings.frameRate].dropAllowed;
  const commitTc = (v: string) => {
    setTcDraft(v);
    if (tcToFrames(v, settings.frameRate, settings.dropFrame) !== null) onChange({ sequenceStartTc: v });
  };
  return (
    <div className="cp-review-export-settings">
      <label className="cp-review-export-field">
        <span>Frame rate</span>
        <select
          className="cp-select sm cp-review-export-select"
          value={settings.frameRate}
          onChange={(e) => onChange({ frameRate: e.target.value as FrameRateKey })}
        >
          {FRAME_RATE_KEYS.map((k) => <option key={k} value={k}>{k} fps</option>)}
        </select>
      </label>
      <label className="cp-review-export-field">
        <span>Start TC</span>
        <input
          className={"cp-review-export-tc" + (tcValid ? "" : " invalid")}
          value={tcDraft}
          spellCheck={false}
          onChange={(e) => commitTc(e.target.value)}
          placeholder="01:00:00:00"
          aria-invalid={!tcValid}
          aria-label="Sequence start timecode"
        />
      </label>
      <label className={"cp-review-export-drop" + (dropAllowed ? "" : " disabled")}>
        <input
          type="checkbox"
          checked={settings.dropFrame}
          disabled={!dropAllowed}
          onChange={(e) => onChange({ dropFrame: e.target.checked })}
        />
        <span>Drop-frame{dropAllowed ? "" : " (29.97 / 59.94 only)"}</span>
      </label>
    </div>
  );
}

/** Composer: draw/voice tools + the playhead-anchored comment box, with its
 *  draw / recording / transcribing / error / note hint stack above it. */
function ReviewComposer({
  drawActive, onToggleDraw, labelActive, onToggleLabel, ensureNamed,
  recording, transcribing,
  dictError, clearDictError, dictNote, clearDictNote,
  toggleDictation, levelRef,
  text, setText, anchorSec, composerRef, autosize,
  onResizeStart, onResizeKey, resizing, onResizeReset,
  submit, hasDraft, playheadActive, fps,
  rangeIn, rangeOut, onRangeTap, onRangeClear, rangeColor,
  onPasteNotes,
}: {
  drawActive: boolean;
  /** The latched moment this comment is about, or null before composing. */
  anchorSec: number | null;
  onToggleDraw?: () => void;
  labelActive: boolean;
  onToggleLabel?: () => void;
  ensureNamed: () => boolean;
  recording: boolean;
  transcribing: boolean;
  dictError: string | null;
  clearDictError: () => void;
  dictNote: string | null;
  clearDictNote: () => void;
  toggleDictation: () => void;
  levelRef: React.RefObject<number>;
  text: string;
  setText: (s: string) => void;
  composerRef: React.RefObject<HTMLTextAreaElement>;
  autosize: () => void;
  /** Start the composer-height drag (handle on the composer's top edge). */
  onResizeStart: (e: React.MouseEvent) => void;
  onResizeKey: (e: React.KeyboardEvent) => void;
  /** True while the height drag is live — brightens the shared handle rail. */
  resizing: boolean;
  /** Double-click reset — back to auto-size. */
  onResizeReset: () => void;
  submit: () => void;
  hasDraft: boolean;
  playheadActive: boolean;
  fps: number;
  rangeIn: number | null;
  rangeOut: number | null;
  onRangeTap: () => void;
  onRangeClear: () => void;
  rangeColor: string;
  /** Open the paste-producer-notes modal (owned by ReviewPanel). */
  onPasteNotes: () => void;
}) {
  // The composer subscribes to the playhead itself rather than taking it as a
  // prop from ReviewPanel - the re-render stops at this subtree instead of
  // dragging the whole thread list along. And it subscribes COARSE: its two
  // consumers are second-granularity text (the "Comment at 1:23" placeholder
  // and the range pill), so whole seconds cut the subtree's re-render rate
  // from source fps to ~1/sec. The one moment that genuinely shows frames -
  // an armed range edge rendering a full following timecode - flips the
  // subscription fine for exactly that window.
  const rangeArmed = rangeIn != null || rangeOut != null;
  const currentSec = usePlayheadSecondsCoarse(fps, playheadActive, rangeArmed);

  // Insert an emoji at the textarea caret (replacing any selection), then
  // restore focus + caret so typing continues seamlessly.
  const insertEmoji = (emoji: string) => {
    const ta = composerRef.current;
    if (!ta) { setText(text + emoji); return; }
    const start = ta.selectionStart ?? text.length;
    const end = ta.selectionEnd ?? text.length;
    setText(text.slice(0, start) + emoji + text.slice(end));
    requestAnimationFrame(() => {
      const el = composerRef.current;
      if (!el) return;
      const caret = start + emoji.length;
      el.focus();
      el.setSelectionRange(caret, caret);
      autosize();
    });
  };
  return (
    <>
      {drawActive && (
        <div className="cp-review-drawhint">
          {labelActive
            ? "Aa Click the video to place a label. Enter commits, Esc cancels."
            : "✎ Drawing on the frame. Your comment will include it."}
        </div>
      )}
      {recording && (
        <div className="cp-review-recbar">
          <DictationWave levelRef={levelRef} active={recording} />
          <span className="cp-review-reclabel">Listening… tap the mic to finish</span>
        </div>
      )}
      {transcribing && (
        <div className="cp-review-drawhint">
          Transcribing your voice…
        </div>
      )}
      {dictError && (
        <div className="cp-review-drawhint error" onClick={clearDictError} title="Dismiss">
          {dictError}
        </div>
      )}
      {dictNote && (
        <div className="cp-review-drawhint" onClick={clearDictNote} title="Dismiss">
          {dictNote}
        </div>
      )}
      {/* Comment range indicator — reviewer-tinted, deliberately unlike the
          orange clip in/out. Appears once either end is armed; the unarmed
          end shows the (clamped) live playhead in italics until marked. */}
      {(rangeIn != null || rangeOut != null) && (() => {
        const t = currentSec ?? rangeIn ?? rangeOut ?? 0;
        const startTc = secondsToTc(rangeIn ?? Math.min(t, rangeOut ?? t), fps);
        const endTc = secondsToTc(rangeOut ?? Math.max(t, rangeIn ?? t), fps);
        return (
          <div className="cp-review-rangebar" style={{ ["--marker-color" as string]: rangeColor }}>
            <span className="cp-review-range-pill">
              <IconRange size={11} strokeWidth={2.4} className="cp-review-glyph" />
              <span className={rangeIn == null ? "live" : undefined}>{startTc}</span>
              <span className="cp-review-range-arrow">→</span>
              <span className={rangeOut == null ? "live" : undefined}>{endTc}</span>
            </span>
            <span className="cp-review-range-hint">
              {rangeIn != null && rangeOut != null
                ? "range locked. Post attaches it to your comment"
                : rangeIn != null
                  ? "⇧O marks OUT. End follows the playhead until then"
                  : "⇧I marks IN. Start follows the playhead until then"}
            </span>
            <button className="cp-review-range-x" onClick={onRangeClear} title="Clear range" aria-label="Clear range">×</button>
          </div>
        );
      })()}
      {/* Composer — draw + voice + comment, anchored at the current playhead. */}
      <div className="cp-review-composer">
        {/* THE TEXT GETS ITS OWN ROW.
            This was one nowrap flex row: six tool buttons, the textarea at
            `flex: 1`, and Post. In a panel at any ordinary width the textarea
            collapsed to its 120px minimum and you were writing a note through
            a slot. The tools are secondary to the writing, so they sit under
            it now and the field spans the full width. */}
        <textarea
          ref={composerRef}
          className="cp-review-input"
          value={text}
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onInput={autosize}
          onFocus={() => ensureNamed()}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
          // Placeholder uses coarse h:mm:ss (no frames, no zero-padded hour) so
          // it fits a narrow panel without wrapping; posted comments still
          // carry the full SMPTE timecode via secondsToTc.
          placeholder={drawActive
            ? "Describe the drawing…"
            // Once latched this stops counting up, which is the only signal a
            // user gets that the stamp is fixed rather than following them.
            : `Comment at ${secondsToHms(anchorSec ?? currentSec ?? 0).replace(/^0(?=\d)/, "")}`}
          /* A NAME, not just a placeholder. The placeholder changes with the
             playhead ("Comment at 1:23"), so it is a hint rather than a label,
             and the form-label sweep deliberately refuses placeholders as
             names. Without this the app's main writing surface announced as an
             unlabelled text box. */
          aria-label={drawActive ? "Describe the drawing" : "Comment"}
        />
        <div className="cp-review-composer-actions">
        {/* Height drag handle — rides the composer's top hairline; the list
            above takes whatever the composer doesn't. */}
        <div
          className={"cp-review-vresize cp-resize-handle horizontal" + (resizing ? " dragging" : "")}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize comment box"
          tabIndex={0}
          onMouseDown={onResizeStart}
          onKeyDown={onResizeKey}
          onDoubleClick={onResizeReset}
          title="Drag to resize · arrow keys to nudge · Home to reset"
        />
        {onToggleDraw && (
          <button
            className={"cp-review-tool" + (drawActive && !labelActive ? " active" : "")}
            onClick={() => { if (ensureNamed()) onToggleDraw(); }}
            title={drawActive ? "Stop drawing" : "Draw on the frame"}
            aria-label="Draw on the frame"
          >
            <PencilGlyph />
          </button>
        )}
        {onToggleLabel && (
          <button
            className={"cp-review-tool" + (drawActive && labelActive ? " active" : "")}
            onClick={() => { if (ensureNamed()) onToggleLabel(); }}
            title={drawActive && labelActive ? "Stop placing labels" : "Place a text label on the frame"}
            aria-label="Place a text label on the frame"
          >
            <LabelGlyph />
          </button>
        )}
        <button
          className={"cp-review-tool" + (recording ? " recording" : "")}
          onClick={toggleDictation}
          disabled={transcribing}
          title={recording ? "Stop & transcribe" : transcribing ? "Transcribing…" : "Dictate a comment"}
          aria-label="Dictate a comment"
        >
          <MicGlyph />
        </button>
        <EmojiPicker onPick={insertEmoji} />
        <button
          className="cp-review-tool"
          onClick={() => { if (ensureNamed()) onPasteNotes(); }}
          title="Paste producer notes as comments"
          aria-label="Paste producer notes"
        >
          <NotesGlyph />
        </button>
        <button
          className={"cp-review-tool" + (rangeIn != null || rangeOut != null ? " active" : "")}
          onClick={() => { if (ensureNamed()) onRangeTap(); }}
          title={rangeIn == null && rangeOut == null
                 ? "Set a comment time range. Mark IN at the playhead (⇧I / ⇧O)"
                 : rangeIn == null || rangeOut == null
                   ? "Mark the other end at the playhead (⇧I / ⇧O)"
                   : "Range set. Tap to start a new one"}
          aria-label="Set comment time range"
        >
          <IconRange size={16} className="cp-review-glyph" />
        </button>
          <span className="cp-review-composer-spacer" />
        <button className="btn btn-primary btn-compact" onClick={submit} disabled={!text.trim() && !hasDraft}>Post</button>
        </div>
      </div>
    </>
  );
}

/** First-run (and rename) name prompt — captures who's reviewing + avatar colour. */
function NameGateModal({
  author, authorColor, nameInput, setNameInput, onSave, onClose, onPickColor,
}: {
  author: string;
  authorColor: string;
  nameInput: string;
  setNameInput: (s: string) => void;
  onSave: (name: string) => void;
  onClose: () => void;
  onPickColor: (c: string) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  useModalFocus(true, dialogRef);
  // `autoFocus` alone did NOT move focus here, and neither did useModalFocus's
  // root.focus(): measured, focus stayed on the Post button behind the scrim
  // at +0ms, +100ms and +500ms. So a keyboard user pressed Post, a modal
  // opened, and their focus was left outside it — with a Tab trap now in
  // place, that is worse than before, because Tab has to walk back in.
  // A rAF-deferred explicit focus lands after the drawer's own layout work.
  return (
    <div className="cp-review-namegate" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {/* This was the ONLY modal in the app without dialog semantics. Every
          other one (Settings, Share, Media info, YouTube auth, Rename, the
          transcript search, Paste notes) declares role="dialog"; this one was
          a bare div with a scrim, so a screen reader announced no dialog
          boundary at all and `document.querySelector('[role="dialog"]')`
          returned nothing while a modal was plainly on screen.
          That last part is not cosmetic: TranscriptViewer's ⌘F and ⌘G both
          refuse to act when `[role="dialog"][aria-modal="true"]` matches,
          which is exactly the guard that should apply here.
          useModalFocus adds the Tab trap and restores focus to the opener on
          close, matching MediaInfoModal and LibraryQuickLook. It only focuses
          the root when focus is not already inside, so the input's autoFocus
          still wins. */}
      <div
        className="cp-review-namegate-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        ref={dialogRef}
        tabIndex={-1}
      >
        <Avatar name={nameInput.trim() || author || "?"} size={44} color={authorColor} />
        <h3 id={headingId}>What's your name?</h3>
        <p>Shown on every note you leave. Stored locally, no account.</p>
        <input
          autoFocus
          aria-label="Your name"
          value={nameInput}
          onChange={(e) => setNameInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onSave(nameInput); if (e.key === "Escape") onClose(); }}
          placeholder="e.g. Gasper"
        />
        <div className="cp-review-namegate-colors">
          <ColorSwatches colors={AVATAR_COLORS} value={authorColor} onPick={onPickColor} ariaLabel="Avatar colour" />
        </div>
        <button className="btn btn-primary" onClick={() => onSave(nameInput)} disabled={!nameInput.trim()}>Start reviewing</button>
      </div>
    </div>
  );
}

function CommentRow({
  c, now, fps, myName, myColor, replies, onSeek, onMarkRange, onQueueRange, onShowAnnotation, onResolve, onDelete, onEdit, onLike,
  onEditReply, onDeleteReply, onLikeReply, collapsed, onToggleCollapse,
  replyOpen, onToggleReply, replyDraft, setReplyDraft, onSubmitReply,
}: {
  c: ReviewComment;
  now: number;
  fps: number;
  myName: string;
  myColor: string;
  replies: ReviewComment[];
  onSeek: (s: number) => void;
  onMarkRange?: (startSeconds: number, endSeconds: number) => void;
  onQueueRange?: (startSeconds: number, endSeconds: number) => void;
  onShowAnnotation?: (a: AnnotationStrokes | null, color?: string, time?: number) => void;
  onResolve: () => void;
  onDelete: () => void;
  onEdit: (body: string) => void;
  onLike: (emoji: string) => void;
  onEditReply: (replyId: string, body: string) => void;
  onDeleteReply: (replyId: string) => void;
  onLikeReply: (replyId: string, emoji: string) => void;
  /** Reply thread collapsed to a one-line "N replies" row (UI state in ReviewPanel). */
  collapsed: boolean;
  onToggleCollapse: () => void;
  replyOpen: boolean;
  onToggleReply: () => void;
  replyDraft: string;
  setReplyDraft: (s: string) => void;
  onSubmitReply: () => void;
}) {
  const hasDrawing = annotationHasContent(c.annotation);
  /** A real span, not a point. The same test the timecode chip already makes
   *  twice; named once so the three cannot drift apart. */
  const isRange = c.timeEnd != null && c.timeEnd > c.timeStart;
  // Label chips on the overlay are tinted to the note author's colour —
  // same resolution the Avatar uses (my chosen colour for me, hash otherwise).
  const authorTint = c.author === myName ? myColor : avatarColor(c.author);
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(c.body);
  const replyInputRef = useRef<HTMLInputElement>(null);
  return (
    <div className={"cp-review-comment" + (c.resolved ? " resolved" : "")}>
      {/* Header: avatar · name · relative time · actions (Frame.io card). */}
      <div className="cp-review-comment-head">
        <Avatar name={c.author} size={30} color={c.author === myName ? myColor : undefined} />
        <div className="cp-review-meta">
          <span className="cp-review-author">{c.author}</span>
          <span className="cp-review-ago">{timeAgo(c.createdAt, now)}</span>
        </div>
        {c.resolved && <span className="cp-review-badge">Resolved</span>}
        <div className="cp-review-actions">
          <ReactionBar c={c} myName={myName} onReact={onLike} />
          <button onClick={onResolve} title={c.resolved ? "Reopen" : "Resolve"}>{c.resolved ? "Reopen" : "Resolve"}</button>
          <button onClick={() => { setEditing(true); setEditDraft(c.body); }} title="Edit">Edit</button>
          <button onClick={onDelete} title="Delete" aria-label="Delete comment">✕</button>
        </div>
      </div>

      {/* Timecode chip (+ drawing badge) — click to jump. */}
      <div className="cp-review-chiprow">
        <button
          className={"cp-review-tc" + (isRange ? " range" : "")}
          onClick={() => { onSeek(c.timeStart); if (hasDrawing) onShowAnnotation?.(c.annotation, authorTint, c.timeStart); }}
          title={isRange ? "Jump to range start" : (hasDrawing ? "Jump + show drawing" : "Jump to this point")}
        >
          <ClockGlyph /> {secondsToTc(c.timeStart, fps)}
          {isRange && <> → {secondsToTc(c.timeEnd as number, fps)}</>}
        </button>
        {hasDrawing && (
          <button
            className="cp-review-drawbadge"
            onClick={() => { onSeek(c.timeStart); onShowAnnotation?.(c.annotation, authorTint, c.timeStart); }}
            title="Show this drawing on the frame"
          >
            ✎ drawing
          </button>
        )}
        {/* THE BRIDGE. A range note could only be jumped to; the same two verbs
            have existed on a transcript selection all along. Shown only on a
            real range - a point comment has nothing to adopt - and only when
            the host actually passed the handlers.

            Both are LOCAL acts on this machine. Marks and the export queue are
            private per-machine state that never goes on the wire (App.tsx
            suppresses queue bands in a session, and session-msg-contract
            forbids marks by name), so adopting a peer's range sets YOUR marks
            and touches nothing anyone else can see. */}
        {isRange && onMarkRange && (
          <button
            className="cp-review-adopt"
            onClick={() => onMarkRange(c.timeStart, c.timeEnd as number)}
            title="Set your in and out marks to this range"
          >
            Mark
          </button>
        )}
        {isRange && onQueueRange && (
          <button
            className="cp-review-adopt"
            onClick={() => onQueueRange(c.timeStart, c.timeEnd as number)}
            title="Add this range to your export queue"
          >
            Queue
          </button>
        )}
      </div>

      {editing ? (
        <div className="cp-review-edit">
          <input value={editDraft} onChange={(e) => setEditDraft(e.target.value)} autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") { onEdit(editDraft.trim() || c.body); setEditing(false); } if (e.key === "Escape") setEditing(false); }} />
          <button className="btn btn-ghost btn-compact" onClick={() => { onEdit(editDraft.trim() || c.body); setEditing(false); }}>Save</button>
        </div>
      ) : (
        <div className="cp-review-body">{c.body}</div>
      )}

      {/* Reddit-style reply thread: a clickable thread-line down the left of
          the reply block collapses it to a one-line "N replies" row. */}
      {replies.length > 0 && (collapsed ? (
        <button className="cp-review-collapsed" onClick={onToggleCollapse} aria-expanded={false}>
          ▸ {replies.length} {replies.length === 1 ? "reply" : "replies"}
        </button>
      ) : (
        <div className="cp-review-thread-block">
          <button
            className="cp-review-thread"
            onClick={onToggleCollapse}
            title="Collapse replies"
            aria-label={`Collapse ${replies.length} ${replies.length === 1 ? "reply" : "replies"}`}
            aria-expanded={true}
          />
          <div className="cp-review-thread-replies">
            {replies.map((r) => (
              <ReplyRow
                key={r.id}
                r={r}
                now={now}
                myName={myName}
                myColor={myColor}
                onEdit={(body) => onEditReply(r.id, body)}
                onDelete={() => onDeleteReply(r.id)}
                onLike={(emoji) => onLikeReply(r.id, emoji)}
              />
            ))}
          </div>
        </div>
      ))}

      {replyOpen ? (
        <div className="cp-review-reply-input">
          <input ref={replyInputRef} value={replyDraft} onChange={(e) => setReplyDraft(e.target.value)} autoFocus
            placeholder="Reply…"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onSubmitReply(); } if (e.key === "Escape") onToggleReply(); }} />
          <EmojiPicker onPick={(em) => insertAtCaret(replyInputRef, replyDraft, setReplyDraft, em)} />
          <button className="btn btn-primary btn-compact" onClick={onSubmitReply} disabled={!replyDraft.trim()}>Post</button>
        </div>
      ) : (
        <button className="cp-review-replylink" onClick={onToggleReply}>Reply</button>
      )}
    </div>
  );
}

/** One reply under a comment's thread-line — same avatar+name+time header as
 *  before, plus quiet hover actions (Edit / ×) mirroring the comment header.
 *  Editing swaps the body for an input prefilled with the text; Enter saves,
 *  Esc cancels, and the emoji picker inserts at the caret like the composer. */
function ReplyRow({
  r, now, myName, myColor, onEdit, onDelete, onLike,
}: {
  r: ReviewComment;
  now: number;
  myName: string;
  myColor: string;
  onEdit: (body: string) => void;
  onDelete: () => void;
  onLike: (emoji: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(r.body);
  const inputRef = useRef<HTMLInputElement>(null);
  const save = () => { onEdit(draft.trim() || r.body); setEditing(false); };
  return (
    <div className="cp-review-reply">
      <Avatar name={r.author} size={20} color={r.author === myName ? myColor : undefined} />
      <div className="cp-review-reply-main">
        <div className="cp-review-reply-head">
          <div className="cp-review-meta">
            <span className="cp-review-author">{r.author}</span>
            <span className="cp-review-ago">{timeAgo(r.createdAt, now)}</span>
          </div>
          <div className="cp-review-actions">
            <ReactionBar c={r} myName={myName} onReact={onLike} />
            <button onClick={() => { setDraft(r.body); setEditing(true); }} title="Edit">Edit</button>
            <button onClick={onDelete} title="Delete" aria-label="Delete comment">✕</button>
          </div>
        </div>
        {editing ? (
          <div className="cp-review-edit">
            <input ref={inputRef} value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }} />
            <EmojiPicker onPick={(em) => insertAtCaret(inputRef, draft, setDraft, em)} />
            <button className="btn btn-ghost btn-compact" onClick={save}>Save</button>
          </div>
        ) : (
          <div className="cp-review-body">{r.body}</div>
        )}
      </div>
    </div>
  );
}

/** Emoji reactions in a note's action cluster (comments + replies): one
 *  chip per emoji anyone has used (click toggles yours), plus a smiley
 *  that opens the palette. The Slack pattern - macOS's native emoji panel
 *  can't be summoned programmatically from a webview, so the curated
 *  palette IS the picker. */
function ReactionBar({ c, myName, onReact }: { c: ReviewComment; myName: string; onReact: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLSpanElement>(null);
  // A single horizontal row of emoji. role="menu" was already here promising
  // arrow navigation; this is what keeps it.
  useMenuKeys(popRef, open, () => setOpen(false));
  const map = reactionsOf(c);
  const entries = Object.entries(map);
  return (
    <span className="cp-react-bar">
      {entries.map(([emoji, names]) => (
        <button
          key={emoji}
          className={"cp-review-like has-likes" + (myName && names.includes(myName) ? " liked" : "")}
          onClick={() => onReact(emoji)}
          aria-pressed={!!myName && names.includes(myName)}
          title={`${emoji} ${names.join(", ")}`}
          aria-label={`${emoji} by ${names.join(", ")}`}
        >
          <span className="cp-react-emoji">{emoji}</span>
          <span className="cp-review-like-n">{names.length}</span>
        </button>
      ))}
      <span className="cp-react-add-wrap">
        <button
          className={"cp-review-like" + (open ? " liked" : "")}
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          title="Add a reaction"
          aria-label="Add a reaction"
        >
          <SmileGlyph />
        </button>
        {open && (
          <span ref={popRef} className="cp-react-pop" role="menu" aria-orientation="horizontal" aria-label="Pick a reaction">
            {COMMENT_REACTION_EMOJI.map((emoji) => (
              <button key={emoji} role="menuitem" className="cp-react-pop-btn"
                onClick={() => { onReact(emoji); setOpen(false); }} aria-label={`React with ${emoji}`}>
                {emoji}
              </button>
            ))}
          </span>
        )}
      </span>
    </span>
  );
}

/** Tiny clock glyph for the timecode chip (matches the Frame.io marker pill). */
function ClockGlyph() {
  return (
    <svg className="cp-review-glyph" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
      strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

/** A page of lines with a leading timecode tick — the paste-notes tool. */
function NotesGlyph() {
  return (
    <svg className="cp-review-glyph" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 8h.01" /><path d="M11.5 8H16" />
      <path d="M8 12h.01" /><path d="M11.5 12H16" />
      <path d="M8 16h.01" /><path d="M11.5 16H14" />
    </svg>
  );
}

/** Pencil glyph for the draw-on-frame tool. */
function PencilGlyph() {
  return (
    <svg className="cp-review-glyph" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

/** Text-label glyph (a tag) for the label-on-frame tool. */
function LabelGlyph() {
  return (
    <svg className="cp-review-glyph" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M20.6 13.4 12.6 21.4a2 2 0 0 1-2.8 0L3 14.6V3h11.6l6 6a2 2 0 0 1 0 2.8Z" />
      <circle cx="7.5" cy="7.5" r="0.5" fill="currentColor" />
    </svg>
  );
}

/** Microphone glyph for the voice-dictation tool. */
function MicGlyph() {
  return (
    <svg className="cp-review-glyph" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M12 17v4" />
    </svg>
  );
}

/** Clock-with-arrow glyph for the past-reviews (history) affordance. */
function HistoryGlyph() {
  return (
    <svg className="cp-review-glyph" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v5h5" />
      <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

/** Smiley glyph for the add-reaction toggle. */
function SmileGlyph() {
  return (
    <svg className="cp-review-glyph" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" />
      <path d="M9 9.5h.01" strokeWidth={2.6} />
      <path d="M15 9.5h.01" strokeWidth={2.6} />
    </svg>
  );
}

/** Magnifier glyph for the comment search affordance. */
function SearchGlyph() {
  return (
    <svg className="cp-review-glyph" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
      strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}
