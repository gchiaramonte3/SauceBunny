import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { DictateDoneEvent, DictateLevelEvent, DictatePartialEvent } from "../types";
import { DictationWave } from "./DictationWave";
import { EmojiPicker } from "./EmojiPicker";
import { IconDownload, IconRange } from "./Icons";
import { usePlayheadSeconds } from "../lib/playhead-store";
import { secondsToHms, secondsToTc } from "../lib/timecode";
import { loadJson, saveJson } from "../lib/storage";
import { formatError } from "../lib/error-format";
import {
  loadReview, saveReview, ensureVersion,
  buildComment, insertComment, editComment, deleteComment, editReply, removeReply,
  setResolved, setLike, rootComments, repliesOf, openCount,
  reviewToMarkdown, reviewToCsv, reviewToEdl,
  avatarColor, initialsOf, loadReviewer, AVATAR_COLORS, AUTHOR_KEY, AUTHOR_COLOR_KEY, REVIEW_CHANGED_EVENT,
  loadReviewHistory, removeReviewHistory, clearReviewHistory,
  type ReviewDoc, type ReviewComment, type CommentSort, type AnnotationStrokes, type ReviewHistoryEntry, type ReviewOp,
} from "../lib/review";

/**
 * Frame.io-style review panel — a local, self-hosted review tab. Timecoded
 * threaded comments anchored to the player's playhead, click-to-seek, resolve,
 * and a per-version approval status. All state is local (localStorage, keyed per
 * source); no server, no accounts. Reuses the drawer's existing playhead
 * (`currentSec`) + seek (`onSeek`) — the same wiring the transcript tab uses.
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
const COMPOSER_MIN = 34;       // matches .cp-review-input min-height
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

export function ReviewPanel({
  sourceKey,
  sourceTitle,
  playheadActive,
  fps,
  onSeek,
  drawActive = false,
  draft = null,
  onToggleDraw,
  onDraftConsumed,
  onShowAnnotation,
  onOpenReview,
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
  /** Click-to-seek — receives seconds. */
  onSeek: (seconds: number) => void;
  /** True while drawing on the frame (the monitor overlay is capturing). */
  drawActive?: boolean;
  /** Live draft strokes drawn over the frame — attached to the next comment. */
  draft?: AnnotationStrokes | null;
  /** Toggle draw mode on/off (managed by App, drives the monitor overlay). */
  onToggleDraw?: () => void;
  /** Clear the draft + exit draw mode after a comment captured it. */
  onDraftConsumed?: () => void;
  /** Display a saved annotation read-only over the frame (null to hide). */
  onShowAnnotation?: (a: AnnotationStrokes | null) => void;
  /** Re-open a past-review source (local path / URL) from the history popover. */
  onOpenReview?: (path: string) => void;
  /** Emit the range currently being set in the composer (or null) so App can
   *  preview it on the timeline. `live` = an end still follows the playhead. */
  onRangeDraft?: (r: { start: number; end: number; color: string; live: boolean } | null) => void;
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
  // Live playhead (seconds) from the store — re-renders per tick while the
  // Review tab is up, exactly like the old 60Hz currentSec prop, so the
  // composer timestamp and the range-draft's playhead-following end keep
  // their cadence. Null while inactive (tab hidden / no source).
  const currentSec = usePlayheadSeconds(fps, playheadActive);
  const [doc, setDoc] = useState<ReviewDoc | null>(null);
  const [sort, setSort] = useState<CommentSort>("time");
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
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
  const MIN_RANGE_SPAN = 0.05; // s — below this a "span" is really a point
  const clearRange = () => { setRangeIn(null); setRangeOut(null); };
  const markRangeIn = () => {
    if (!ensureNamed()) return;
    if (currentSec == null) return; // no playable playhead — a mark at 0:00 would be a lie
    const t = currentSec;
    if (rangeOut == null) { setRangeIn(t); return; }          // IDLE / IN-ARMED: (re)arm IN
    if (rangeIn == null) {                                    // OUT-ARMED: complete
      const a = Math.min(t, rangeOut), b = Math.max(t, rangeOut);
      if (b - a < MIN_RANGE_SPAN) return;                     // no real span — stay armed
      setRangeIn(a); setRangeOut(b);
    } else if (rangeOut - t < MIN_RANGE_SPAN) {               // SET: IN at/after OUT collapses
      setRangeIn(t); setRangeOut(null);
    } else {
      setRangeIn(t);                                          // SET: move IN
    }
  };
  const markRangeOut = () => {
    if (!ensureNamed()) return;
    if (currentSec == null) return; // no playable playhead — a mark at 0:00 would be a lie
    const t = currentSec;
    if (rangeIn == null) { setRangeOut(t); return; }          // IDLE / OUT-ARMED: (re)arm OUT
    if (rangeOut == null) {                                   // IN-ARMED: complete
      const a = Math.min(rangeIn, t), b = Math.max(rangeIn, t);
      if (b - a < MIN_RANGE_SPAN) return;                     // no real span — stay armed
      setRangeIn(a); setRangeOut(b);
    } else if (t - rangeIn < MIN_RANGE_SPAN) {                // SET: OUT at/before IN collapses
      setRangeOut(t); setRangeIn(null);
    } else {
      setRangeOut(t);                                         // SET: move OUT
    }
  };
  // Composer button keeps its tap cycle: arm IN → complete → re-arm.
  const tapRange = () => {
    if (rangeIn != null && rangeOut != null) {                // SET → re-arm
      if (!ensureNamed() || currentSec == null) return;
      setRangeIn(currentSec); setRangeOut(null);
    } else if (rangeIn != null) markRangeOut();               // IN-ARMED → complete
    else markRangeIn();                                       // IDLE / OUT-ARMED
  };
  // Preview the in-progress range on the App timeline; clear on unmount. The
  // playhead-following end is clamped against the armed mark so the band
  // never inverts while scrubbing behind it.
  useEffect(() => {
    if (rangeIn == null && rangeOut == null) { onRangeDraft?.(null); return; }
    const t = currentSec ?? rangeIn ?? rangeOut ?? 0;
    const start = rangeIn ?? Math.min(t, rangeOut!);
    const end = rangeOut ?? Math.max(t, rangeIn!);
    onRangeDraft?.({ start, end, color: authorColor, live: rangeIn == null || rangeOut == null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeIn, rangeOut, currentSec, authorColor]);
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
  const now = Date.now();

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      const job = await invoke<string>("new_job_id");
      dictJobRef.current = job;
      try {
        // Prefer the native, on-device, LIVE-streaming path (Apple Speech):
        // words appear in the composer as you speak.
        await invoke("dictate_native_start", { jobId: job, locale: "en-US" });
      } catch {
        // Native sidecar unavailable → fall back to ffmpeg → Whisper/Parakeet
        // (batch after stop). Mic chosen in Settings → Transcription.
        const device = loadJson<string>("saucebunny.dictation.device", "default");
        await invoke("dictate_start", { jobId: job, device });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Load (and ensure a version exists) whenever the source changes.
  useEffect(() => {
    // Clear transient dictation banners so a previous clip's error/note doesn't
    // linger over the new one.
    setDictError(null);
    setDictNote(null);
    setCollapsedThreads(new Set()); // new source → all threads back to expanded
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
  // On leaving a session, reload the local doc — App persisted the merged
  // collaborative doc to storage, so the panel must re-read it (its local
  // `doc` state predates the session's comments).
  const wasInSessionRef = useRef(false);
  useEffect(() => {
    const was = wasInSessionRef.current;
    wasInSessionRef.current = inSession;
    if (was && !inSession && sourceKey) setDoc(loadReview(sourceKey));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inSession, sourceKey]);

  const versionId = viewDoc?.activeVersionId ?? null;
  const roots = useMemo(
    () => (viewDoc ? rootComments(viewDoc, versionId, sort) : []),
    [viewDoc, versionId, sort],
  );
  const open = viewDoc ? openCount(viewDoc, versionId) : 0;
  const resolved = roots.length - open;

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
      <div className="cp-review-empty">
        <p>Connecting to the session…</p>
        <p className="sub">Loading the shared review from the host — comments will appear here.</p>
      </div>
    );
  }
  if (!viewDoc || !versionId || (!inSession && !sourceKey)) {
    return (
      <div className="cp-review-empty">
        <p>Load a source to start a review.</p>
        <p className="sub">Drop timecoded comments on the video, resolve them, and sign off — all stored locally.</p>
      </div>
    );
  }

  const submit = () => {
    const body = text.trim();
    const hasDrawing = !!draft && draft.strokes.length > 0;
    if (!body && !hasDrawing) return;
    if (!ensureNamed()) return;
    // Post column of the range machine: a SET range posts as-is; an ARMED
    // range commits the live span the pill is showing — the SAME clamped
    // values the preview computes (scrubbing behind an armed IN / ahead of
    // an armed OUT collapses to the mark), degrading to a point comment.
    const t = currentSec ?? 0;
    let timeStart = t;
    let timeEnd: number | null = null;
    if (rangeIn != null && rangeOut != null) {
      timeStart = rangeIn; timeEnd = rangeOut;
    } else if (rangeIn != null) {
      const end = Math.max(t, rangeIn); // clamped like the pill/draft
      if (end - rangeIn >= MIN_RANGE_SPAN) { timeStart = rangeIn; timeEnd = end; }
      else timeStart = rangeIn;
    } else if (rangeOut != null) {
      const start = Math.min(t, rangeOut); // clamped like the pill/draft
      if (rangeOut - start >= MIN_RANGE_SPAN) { timeStart = start; timeEnd = rangeOut; }
      else timeStart = rangeOut;
    }
    const comment = buildComment({
      versionId,
      timeStart,
      timeEnd,
      body: body || "(drawing)",
      author,
      annotation: hasDrawing ? draft : null,
    });
    dispatch({ t: "add", comment }, (d) => insertComment(d, comment));
    setText("");
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
    dispatch({ t: "add", comment: reply }, (d) => insertComment(d, reply));
    setReplyDraft("");
    setReplyTo(null);
  };

  const doExport = async (kind: "md" | "csv" | "edl") => {
    setExportOpen(false);
    if (!viewDoc) return;
    const f = {
      md:  { ext: "md",  name: "Markdown", text: reviewToMarkdown(viewDoc, sourceTitle ?? "Review") },
      csv: { ext: "csv", name: "CSV",      text: reviewToCsv(viewDoc, fps) },
      edl: { ext: "edl", name: "EDL",      text: reviewToEdl(viewDoc, fps, sourceTitle ?? "Sauce Bunny Review") },
    }[kind];
    const base = (sourceTitle ?? "review").replace(/[^\w.-]+/g, "-").slice(0, 60) || "review";
    try {
      const path = await saveDialog({ defaultPath: `${base}-review.${f.ext}`, filters: [{ name: f.name, extensions: [f.ext] }] });
      if (typeof path !== "string" || !path) return;
      await invoke("write_bytes_to_path", { path, bytes: Array.from(new TextEncoder().encode(f.text)) });
      setExportMsg(`Exported → ${path.split("/").pop()}`);
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

      {/* Comment list */}
      <div className="cp-review-list">
        {roots.length === 0 && (
          <div className="cp-review-hint">No comments yet — scrub to a spot and add one below.</div>
        )}
        {roots.length > 0 && visible.length === 0 && (
          <div className="cp-review-hint">
            {search.trim() ? "No comments match your search." : filter === "open" ? "No open comments — all signed off. 🎉" : "No resolved comments yet."}
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
            replies={repliesOf(viewDoc, c.id)}
            onSeek={onSeek}
            onShowAnnotation={onShowAnnotation}
            onResolve={() => { const at = Date.now(), v = !c.resolved; dispatch({ t: "resolve", id: c.id, resolved: v, at }, (d) => setResolved(d, c.id, v, at)); }}
            onDelete={() => dispatch({ t: "del", id: c.id }, (d) => deleteComment(d, c.id))}
            onEdit={(body) => { const at = Date.now(); dispatch({ t: "edit", id: c.id, body, at }, (d) => editComment(d, c.id, body, at)); }}
            onLike={() => { if (!ensureNamed()) return; const liked = !(c.likes ?? []).includes(author); dispatch({ t: "like", id: c.id, name: author, liked }, (d) => setLike(d, c.id, author, liked)); }}
            onEditReply={(replyId, body) => { const at = Date.now(); dispatch({ t: "editReply", versionId, commentId: c.id, replyId, body, at }, (d) => editReply(d, versionId, c.id, replyId, body, at)); }}
            onDeleteReply={(replyId) => dispatch({ t: "delReply", versionId, commentId: c.id, replyId }, (d) => removeReply(d, versionId, c.id, replyId))}
            onLikeReply={(replyId) => { if (!ensureNamed()) return; const r = viewDoc.comments.find((x) => x.id === replyId); if (!r) return; const liked = !(r.likes ?? []).includes(author); dispatch({ t: "like", id: replyId, name: author, liked }, (d) => setLike(d, replyId, author, liked)); }}
            collapsed={collapsedThreads.has(c.id)}
            onToggleCollapse={() => toggleThread(c.id)}
            replyOpen={replyTo === c.id}
            onToggleReply={() => { setReplyTo(replyTo === c.id ? null : c.id); setReplyDraft(""); }}
            replyDraft={replyDraft}
            setReplyDraft={setReplyDraft}
            onSubmitReply={() => submitReply(c.id, c.timeStart)}
          />
        ))}
      </div>

      <ReviewComposer
        drawActive={drawActive}
        onToggleDraw={onToggleDraw}
        ensureNamed={ensureNamed}
        recording={recording}
        transcribing={transcribing}
        dictError={dictError} clearDictError={() => setDictError(null)}
        dictNote={dictNote} clearDictNote={() => setDictNote(null)}
        toggleDictation={toggleDictation}
        levelRef={micLevelRef}
        text={text} setText={setText}
        composerRef={composerRef} autosize={autosizeComposer}
        onResizeStart={onComposerResizeStart}
        resizing={composerResizing}
        onResizeReset={() => setComposerHeight(null)}
        submit={submit} hasDraft={!!draft && draft.strokes.length > 0}
        currentSec={currentSec} fps={fps}
        rangeIn={rangeIn} rangeOut={rangeOut} onRangeTap={tapRange} onRangeClear={clearRange}
        rangeColor={authorColor}
      />

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
  doExport: (kind: "md" | "csv" | "edl") => void;
  exportDisabled: boolean;
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
        <select className="cp-review-sort" value={sort} onChange={(e) => setSort(e.target.value as CommentSort)} title="Sort comments">
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
            <div className="cp-review-export-menu">
              <button onMouseDown={() => doExport("md")}>Notes (Markdown)</button>
              <button onMouseDown={() => doExport("csv")}>Markers (CSV)</button>
              <button onMouseDown={() => doExport("edl")}>EDL (Resolve / Premiere)</button>
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
                      onMouseDown={() => { setHistoryOpen(false); onOpenReview(h.path); }}
                      title={h.path}
                    >
                      <span className="cp-review-history-title">{h.title}</span>
                      <span className="cp-review-history-meta">{h.count} note{h.count === 1 ? "" : "s"} · {timeAgo(h.updatedAt, now)}</span>
                    </button>
                    <button
                      className="cp-review-history-del"
                      onMouseDown={(e) => { e.stopPropagation(); removeReviewHistory(h.key); setHistory(loadReviewHistory()); }}
                      title="Remove from history"
                    >✕</button>
                  </div>
                ))}
                {/* Bulk clear — history entries are just pointers, so no confirm:
                    the review docs themselves are never deleted from here. */}
                {history.length > 0 && (
                  <button
                    className="cp-review-history-clear"
                    onMouseDown={() => { clearReviewHistory(); setHistory([]); }}
                    title="Clear the list — review notes themselves are kept"
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
          title={author ? `Reviewing as ${author} — click to rename` : "Set your name"}
        >
          <Avatar name={author || "?"} size={26} color={authorColor} />
        </button>
      </div>
    </div>
  );
}

/** Composer: draw/voice tools + the playhead-anchored comment box, with its
 *  draw / recording / transcribing / error / note hint stack above it. */
function ReviewComposer({
  drawActive, onToggleDraw, ensureNamed,
  recording, transcribing,
  dictError, clearDictError, dictNote, clearDictNote,
  toggleDictation, levelRef,
  text, setText, composerRef, autosize,
  onResizeStart, resizing, onResizeReset,
  submit, hasDraft, currentSec, fps,
  rangeIn, rangeOut, onRangeTap, onRangeClear, rangeColor,
}: {
  drawActive: boolean;
  onToggleDraw?: () => void;
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
  /** True while the height drag is live — brightens the shared handle rail. */
  resizing: boolean;
  /** Double-click reset — back to auto-size. */
  onResizeReset: () => void;
  submit: () => void;
  hasDraft: boolean;
  currentSec: number | null;
  fps: number;
  rangeIn: number | null;
  rangeOut: number | null;
  onRangeTap: () => void;
  onRangeClear: () => void;
  rangeColor: string;
}) {
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
          ✎ Drawing on the frame — your comment will include it.
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
                ? "range locked — Post attaches it to your comment"
                : rangeIn != null
                  ? "⇧O marks OUT — end follows the playhead until then"
                  : "⇧I marks IN — start follows the playhead until then"}
            </span>
            <button className="cp-review-range-x" onClick={onRangeClear} title="Clear range" aria-label="Clear range">×</button>
          </div>
        );
      })()}
      {/* Composer — draw + voice + comment, anchored at the current playhead. */}
      <div className="cp-review-composer">
        {/* Height drag handle — rides the composer's top hairline; the list
            above takes whatever the composer doesn't. */}
        <div
          className={"cp-review-vresize cp-resize-handle horizontal" + (resizing ? " dragging" : "")}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize comment box"
          onMouseDown={onResizeStart}
          onDoubleClick={onResizeReset}
          title="Drag to resize · double-click to reset"
        />
        {onToggleDraw && (
          <button
            className={"cp-review-tool" + (drawActive ? " active" : "")}
            onClick={() => { if (ensureNamed()) onToggleDraw(); }}
            title={drawActive ? "Stop drawing" : "Draw on the frame"}
            aria-label="Draw on the frame"
          >
            <PencilGlyph />
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
          className={"cp-review-tool" + (rangeIn != null || rangeOut != null ? " active" : "")}
          onClick={() => { if (ensureNamed()) onRangeTap(); }}
          title={rangeIn == null && rangeOut == null
                 ? "Set a comment time range — mark IN at the playhead (⇧I / ⇧O)"
                 : rangeIn == null || rangeOut == null
                   ? "Mark the other end at the playhead (⇧I / ⇧O)"
                   : "Range set — tap to start a new one"}
          aria-label="Set comment time range"
        >
          <IconRange size={16} className="cp-review-glyph" />
        </button>
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
          placeholder={drawActive ? "Describe the drawing…" : `Comment at ${secondsToHms(currentSec ?? 0).replace(/^0(?=\d)/, "")}`}
        />
        <button className="btn btn-primary btn-compact" onClick={submit} disabled={!text.trim() && !hasDraft}>Post</button>
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
  return (
    <div className="cp-review-namegate" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cp-review-namegate-card">
        <Avatar name={nameInput.trim() || author || "?"} size={44} color={authorColor} />
        <h3>What's your name?</h3>
        <p>Shown on every note you leave — stored locally, no account.</p>
        <input
          autoFocus
          value={nameInput}
          onChange={(e) => setNameInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onSave(nameInput); if (e.key === "Escape") onClose(); }}
          placeholder="e.g. Gasper"
        />
        <div className="cp-review-namegate-colors">
          {AVATAR_COLORS.map((c) => (
            <button
              key={c}
              className={"cp-review-colordot" + (c === authorColor ? " active" : "")}
              style={{ background: c }}
              onClick={() => onPickColor(c)}
              title="Avatar colour"
              aria-label={`Avatar colour ${c}`}
            />
          ))}
        </div>
        <button className="btn btn-primary" onClick={() => onSave(nameInput)} disabled={!nameInput.trim()}>Start reviewing</button>
      </div>
    </div>
  );
}

function CommentRow({
  c, now, fps, myName, myColor, replies, onSeek, onShowAnnotation, onResolve, onDelete, onEdit, onLike,
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
  onShowAnnotation?: (a: AnnotationStrokes | null) => void;
  onResolve: () => void;
  onDelete: () => void;
  onEdit: (body: string) => void;
  onLike: () => void;
  onEditReply: (replyId: string, body: string) => void;
  onDeleteReply: (replyId: string) => void;
  onLikeReply: (replyId: string) => void;
  /** Reply thread collapsed to a one-line "N replies" row (UI state in ReviewPanel). */
  collapsed: boolean;
  onToggleCollapse: () => void;
  replyOpen: boolean;
  onToggleReply: () => void;
  replyDraft: string;
  setReplyDraft: (s: string) => void;
  onSubmitReply: () => void;
}) {
  const hasDrawing = !!c.annotation && c.annotation.strokes.length > 0;
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
          <LikeButton likes={c.likes ?? []} myName={myName} onLike={onLike} />
          <button onClick={onResolve} title={c.resolved ? "Reopen" : "Resolve"}>{c.resolved ? "Reopen" : "Resolve"}</button>
          <button onClick={() => { setEditing(true); setEditDraft(c.body); }} title="Edit">Edit</button>
          <button onClick={onDelete} title="Delete">✕</button>
        </div>
      </div>

      {/* Timecode chip (+ drawing badge) — click to jump. */}
      <div className="cp-review-chiprow">
        <button
          className={"cp-review-tc" + (c.timeEnd != null && c.timeEnd > c.timeStart ? " range" : "")}
          onClick={() => { onSeek(c.timeStart); if (hasDrawing) onShowAnnotation?.(c.annotation); }}
          title={c.timeEnd != null && c.timeEnd > c.timeStart ? "Jump to range start" : (hasDrawing ? "Jump + show drawing" : "Jump to this point")}
        >
          <ClockGlyph /> {secondsToTc(c.timeStart, fps)}
          {c.timeEnd != null && c.timeEnd > c.timeStart && <> – {secondsToTc(c.timeEnd, fps)}</>}
        </button>
        {hasDrawing && (
          <button
            className="cp-review-drawbadge"
            onClick={() => { onSeek(c.timeStart); onShowAnnotation?.(c.annotation); }}
            title="Show this drawing on the frame"
          >
            ✎ drawing
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
                onLike={() => onLikeReply(r.id)}
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
  onLike: () => void;
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
            <LikeButton likes={r.likes ?? []} myName={myName} onLike={onLike} />
            <button onClick={() => { setDraft(r.body); setEditing(true); }} title="Edit">Edit</button>
            <button onClick={onDelete} title="Delete">✕</button>
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

/** Thumbs-up toggle in a note's action cluster (comments + replies). Quiet
 *  like its Edit/× siblings; once anyone has liked, the count rides along and
 *  the button stays visible at a glance (see .has-likes in review.css). */
function LikeButton({ likes, myName, onLike }: { likes: string[]; myName: string; onLike: () => void }) {
  const liked = !!myName && likes.includes(myName);
  return (
    <button
      className={"cp-review-like" + (liked ? " liked" : "") + (likes.length > 0 ? " has-likes" : "")}
      onClick={onLike}
      aria-pressed={liked}
      title={likes.length > 0 ? `Liked by ${likes.join(", ")}` : "Like"}
    >
      <ThumbGlyph />
      {likes.length > 0 && <span className="cp-review-like-n">{likes.length}</span>}
    </button>
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

/** Thumbs-up glyph for the like toggle. */
function ThumbGlyph() {
  return (
    <svg className="cp-review-glyph" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 11v10" />
      <path d="M7 11l4-8a3 3 0 0 1 3 3v3h5a2 2 0 0 1 2 2.3l-1.3 7a2 2 0 0 1-2 1.7H7" />
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
