import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { DictateDoneEvent } from "../types";
import { secondsToTc } from "../lib/timecode";
import { loadJson, saveJson } from "../lib/storage";
import { formatError } from "../lib/error-format";
import {
  loadReview, saveReview, ensureVersion,
  addComment, editComment, deleteComment,
  toggleResolved, rootComments, repliesOf, openCount,
  reviewToMarkdown, reviewToCsv, reviewToEdl,
  avatarColor, initialsOf, AVATAR_COLORS, AUTHOR_KEY, AUTHOR_COLOR_KEY, REVIEW_CHANGED_EVENT,
  loadReviewHistory, removeReviewHistory,
  type ReviewDoc, type ReviewComment, type CommentSort, type AnnotationStrokes, type ReviewHistoryEntry,
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
  currentSec,
  fps,
  onSeek,
  drawActive = false,
  draft = null,
  onToggleDraw,
  onDraftConsumed,
  onShowAnnotation,
  onOpenReview,
}: {
  /** Stable id for the current source (local path or URL); null when none loaded. */
  sourceKey: string | null;
  /** Human label for the source (for the version row). */
  sourceTitle?: string | null;
  /** Live playhead in seconds (null when nothing is loaded). */
  currentSec: number | null;
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
}) {
  const [doc, setDoc] = useState<ReviewDoc | null>(null);
  const [sort, setSort] = useState<CommentSort>("time");
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [author, setAuthor] = useState(() => loadJson<string>(AUTHOR_KEY, ""));
  // Chosen avatar colour — stable + user-picked (NOT derived from the live-typed
  // name, which used to recolour on every keystroke). Defaults off the saved name.
  const [authorColor, setAuthorColor] = useState(() =>
    loadJson<string>(AUTHOR_COLOR_KEY, avatarColor(loadJson<string>(AUTHOR_KEY, "") || "You")));
  const [nameModal, setNameModal] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [filter, setFilter] = useState<"all" | "open" | "resolved">("all");
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<ReviewHistoryEntry[]>([]);
  const composerRef = useRef<HTMLTextAreaElement>(null);
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

  useEffect(() => {
    const un = listen<DictateDoneEvent>("dictate-done", (e) => {
      if (e.payload.job_id !== dictJobRef.current) return;
      dictJobRef.current = null;
      setRecording(false);
      setTranscribing(false);
      if (e.payload.success) {
        const t = (e.payload.text ?? "").trim();
        if (t) {
          setText((prev) => (prev.trim() ? prev.replace(/\s*$/, "") + " " + t : t));
          requestAnimationFrame(autosizeComposer);
        }
        setDictNote(e.payload.note ?? null); // e.g. hit the 5-minute cap
      } else if (e.payload.error && e.payload.error !== "Cancelled") {
        setDictError(e.payload.error);
      }
    });
    return () => { un.then((f) => f()); };
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
    try {
      const job = await invoke<string>("new_job_id");
      dictJobRef.current = job;
      await invoke("dictate_start", { jobId: job });
      setRecording(true);
    } catch (e) {
      dictJobRef.current = null;
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
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 140) + "px";
  };

  // Load (and ensure a version exists) whenever the source changes.
  useEffect(() => {
    // Clear transient dictation banners so a previous clip's error/note doesn't
    // linger over the new one.
    setDictError(null);
    setDictNote(null);
    if (!sourceKey) { setDoc(null); return; }
    const { doc: d } = ensureVersion(loadReview(sourceKey), sourceKey, sourceTitle ?? undefined);
    saveReview(d);
    setDoc(d);
  }, [sourceKey, sourceTitle]);

  // One mutate helper: apply a pure op, persist, set state.
  const mutate = (fn: (d: ReviewDoc) => ReviewDoc) => {
    setDoc((prev) => {
      if (!prev) return prev;
      const next = fn(prev);
      saveReview(next);
      return next;
    });
  };

  const versionId = doc?.activeVersionId ?? null;
  const roots = useMemo(
    () => (doc ? rootComments(doc, versionId, sort) : []),
    [doc, versionId, sort],
  );
  const open = doc ? openCount(doc, versionId) : 0;
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

  if (!sourceKey || !doc || !versionId) {
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
    mutate((d) => addComment(d, {
      versionId,
      timeStart: currentSec ?? 0,
      body: body || "(drawing)",
      author,
      annotation: hasDrawing ? draft : null,
    }));
    setText("");
    if (composerRef.current) composerRef.current.style.height = "auto";
    if (hasDrawing) onDraftConsumed?.();
  };
  const submitReply = (parentId: string, atTime: number) => {
    const body = replyDraft.trim();
    if (!body) return;
    if (!ensureNamed()) return; // gate like submit() — no empty-author replies
    mutate((d) => addComment(d, { versionId, timeStart: atTime, body, author, parentId }));
    setReplyDraft("");
    setReplyTo(null);
  };

  const doExport = async (kind: "md" | "csv" | "edl") => {
    setExportOpen(false);
    if (!doc) return;
    const f = {
      md:  { ext: "md",  name: "Markdown", text: reviewToMarkdown(doc, sourceTitle ?? "Review") },
      csv: { ext: "csv", name: "CSV",      text: reviewToCsv(doc, fps) },
      edl: { ext: "edl", name: "EDL",      text: reviewToEdl(doc, fps, sourceTitle ?? "Sauce Bunny Review") },
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
    <div className="cp-review">
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
            replies={repliesOf(doc, c.id)}
            onSeek={onSeek}
            onShowAnnotation={onShowAnnotation}
            onResolve={() => mutate((d) => toggleResolved(d, c.id))}
            onDelete={() => mutate((d) => deleteComment(d, c.id))}
            onEdit={(body) => mutate((d) => editComment(d, c.id, body))}
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
        text={text} setText={setText}
        composerRef={composerRef} autosize={autosizeComposer}
        submit={submit} hasDraft={!!draft && draft.strokes.length > 0}
        currentSec={currentSec} fps={fps}
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
          <button
            className="cp-review-export-btn"
            onClick={() => setExportOpen((o) => !o)}
            disabled={exportDisabled}
            title="Export the review (the local stand-in for a share link)"
          >
            Export ▾
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
          <Avatar name={author || "?"} size={24} color={authorColor} />
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
  toggleDictation,
  text, setText, composerRef, autosize,
  submit, hasDraft, currentSec, fps,
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
  text: string;
  setText: (s: string) => void;
  composerRef: React.RefObject<HTMLTextAreaElement>;
  autosize: () => void;
  submit: () => void;
  hasDraft: boolean;
  currentSec: number | null;
  fps: number;
}) {
  return (
    <>
      {drawActive && (
        <div className="cp-review-drawhint">
          ✎ Drawing on the frame — your comment will include it.
        </div>
      )}
      {recording && (
        <div className="cp-review-drawhint recording">
          ● Recording — tap the mic again to transcribe.
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
      {/* Composer — draw + voice + comment, anchored at the current playhead. */}
      <div className="cp-review-composer">
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
        <textarea
          ref={composerRef}
          className="cp-review-input"
          value={text}
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onInput={autosize}
          onFocus={() => ensureNamed()}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
          placeholder={drawActive ? "Describe the drawing…" : `Comment at ${secondsToTc(currentSec ?? 0, fps)}…`}
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
  c, now, fps, myName, myColor, replies, onSeek, onShowAnnotation, onResolve, onDelete, onEdit,
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
  replyOpen: boolean;
  onToggleReply: () => void;
  replyDraft: string;
  setReplyDraft: (s: string) => void;
  onSubmitReply: () => void;
}) {
  const hasDrawing = !!c.annotation && c.annotation.strokes.length > 0;
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(c.body);
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
          <button onClick={onResolve} title={c.resolved ? "Reopen" : "Resolve"}>{c.resolved ? "Reopen" : "Resolve"}</button>
          <button onClick={() => { setEditing(true); setEditDraft(c.body); }} title="Edit">Edit</button>
          <button onClick={onDelete} title="Delete">✕</button>
        </div>
      </div>

      {/* Timecode chip (+ drawing badge) — click to jump. */}
      <div className="cp-review-chiprow">
        <button
          className="cp-review-tc"
          onClick={() => { onSeek(c.timeStart); if (hasDrawing) onShowAnnotation?.(c.annotation); }}
          title={hasDrawing ? "Jump + show drawing" : "Jump to this point"}
        >
          <ClockGlyph /> {secondsToTc(c.timeStart, fps)}
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

      {replies.map((r) => (
        <div className="cp-review-reply" key={r.id}>
          <Avatar name={r.author} size={20} color={r.author === myName ? myColor : undefined} />
          <div className="cp-review-reply-main">
            <span className="cp-review-author">{r.author}</span>
            <span className="cp-review-ago">{timeAgo(r.createdAt, now)}</span>
            <div className="cp-review-body">{r.body}</div>
          </div>
        </div>
      ))}

      {replyOpen ? (
        <div className="cp-review-reply-input">
          <input value={replyDraft} onChange={(e) => setReplyDraft(e.target.value)} autoFocus
            placeholder="Reply…"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onSubmitReply(); } if (e.key === "Escape") onToggleReply(); }} />
          <button className="btn btn-ghost btn-compact" onClick={onSubmitReply} disabled={!replyDraft.trim()}>Reply</button>
        </div>
      ) : (
        <button className="cp-review-replylink" onClick={onToggleReply}>Reply</button>
      )}
    </div>
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
