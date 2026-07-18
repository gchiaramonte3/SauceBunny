/**
 * Local-first video review model — a self-hosted "Frame.io" for Sauce Bunny.
 *
 * This is a native re-implementation of the portable core of FreeFrame's review
 * domain (MIT) adapted to Sauce Bunny's constraints: no server, no DB, no auth —
 * everything persists locally, keyed per source. The shape mirrors
 * FreeFrame (timecode_start/end seconds, threaded comments via parentId,
 * per-version approval) so the UX maps 1:1, minus the multi-user/cloud pieces
 * (share tokens, guests, notifications, RBAC) which a local app can't do.
 *
 * Pure ops return a NEW ReviewDoc (never mutate) so React state updates are
 * clean and the logic is unit-testable. Docs persist as real files in
 * `~/Documents/Sauce Bunny/Reviews/` through lib/review-store.ts (hydrated at
 * boot, write-through on save) — localStorage's ~5 MB quota was a ceiling
 * annotation-heavy docs would hit. Small prefs (reviewer identity, history,
 * fingerprint index) stay in localStorage.
 */

import { loadJson, saveJson } from "./storage";
import { getReviewDoc, putReviewDoc } from "./review-store";
import { secondsToHms, secondsToTc } from "./timecode";

export type ReviewStatusState = "pending" | "approved" | "changes";

/** A Frame.io-style text callout anchored to a point on the frame. Coords are
 *  normalized 0..1 like stroke points so the label scales with the video box. */
export type AnnotationLabel = { text: string; x: number; y: number };

/** A free-hand drawing captured on a frame, stored with a comment. Points are
 *  normalized 0..1 against the canvas it was drawn on so it scales to any size. */
export type AnnotationStrokes = {
  strokes: { color: string; size: number; pts: [number, number][] }[];
  /** Optional text labels riding the same annotation payload as the strokes.
   *  ADDITIVE + OPTIONAL on purpose: docs persisted (or peers running) before
   *  labels existed simply lack the field, and old clients parsing a labeled
   *  doc ignore it — never rename/repurpose `strokes` for this reason. */
  labels?: AnnotationLabel[];
};

/** True when an annotation has anything to show — strokes OR labels. Old
 *  callsites checked `strokes.length > 0`, which would drop a labels-only
 *  annotation; route every "is there a drawing?" question through this. */
export function annotationHasContent(a: AnnotationStrokes | null | undefined): boolean {
  return !!a && (a.strokes.length > 0 || (a.labels?.length ?? 0) > 0);
}

export type ReviewComment = {
  id: string;
  versionId: string;
  /** null = a root comment; otherwise the id of the comment it replies to. */
  parentId: string | null;
  /** Anchor time in seconds (matches FreeFrame's timecode_start). */
  timeStart: number;
  /** Optional range end in seconds (timecode_end); null = a point comment. */
  timeEnd: number | null;
  body: string;
  resolved: boolean;
  author: string;
  createdAt: number;
  updatedAt: number;
  annotation: AnnotationStrokes | null;
  /** Reviewer names who liked this note. Optional so docs persisted before
   *  likes existed parse unchanged (absent = no likes). */
  likes?: string[];
};

export type ReviewVersion = {
  id: string;
  label: string;   // "V1", "V2", or a filename
  path: string;    // local file path or source URL
  addedAt: number;
};

export type ReviewStatus = {
  state: ReviewStatusState;
  note: string;
  updatedAt: number;
  /** Who set it ("Approved · Nika"). Empty on legacy docs. */
  reviewer: string;
};

export type ReviewDoc = {
  sourceKey: string;
  versions: ReviewVersion[];
  activeVersionId: string | null;
  comments: ReviewComment[];
  /** Per-version approval state, keyed by versionId. */
  status: Record<string, ReviewStatus>;
};

export type CommentSort = "time" | "newest" | "oldest";

// ── ids + clock (kept tiny + swappable) ──────────────────────────────────────
function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `r_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
  }
}

// ── persistence ──────────────────────────────────────────────────────────────
// Docs live in review-store's in-memory Map (hydrated from
// ~/Documents/Sauce Bunny/Reviews/ at boot), which is what keeps loadReview
// SYNCHRONOUS for its many call sites; saves write through to disk debounced.

export function emptyDoc(sourceKey: string): ReviewDoc {
  return { sourceKey, versions: [], activeVersionId: null, comments: [], status: {} };
}

export function loadReview(sourceKey: string): ReviewDoc {
  return ensureCommentIds(getReviewDoc(sourceKey) ?? emptyDoc(sourceKey));
}

/** Backward-compatible read repair: assign an id to any persisted comment that
 *  lacks one (docs written before ids were guaranteed on replies), so ops that
 *  address replies by id (editReply/removeReply) always have a stable handle.
 *  Returns the doc untouched (same reference) when nothing needs repair. */
export function ensureCommentIds(doc: ReviewDoc): ReviewDoc {
  if (doc.comments.every((c) => !!c.id)) return doc;
  return { ...doc, comments: doc.comments.map((c) => (c.id ? c : { ...c, id: newId() })) };
}

/** Fired after any review mutation so other views (e.g. the timeline markers)
 *  can re-read. Mirrors the speaker-overrides change event. */
export const REVIEW_CHANGED_EVENT = "saucebunny:review-changed";

export function saveReview(doc: ReviewDoc): void {
  putReviewDoc(doc);
  try { window.dispatchEvent(new CustomEvent(REVIEW_CHANGED_EVENT, { detail: { sourceKey: doc.sourceKey } })); }
  catch { /* non-DOM context (tests) */ }
}

// ── versions ─────────────────────────────────────────────────────────────────

/**
 * Ensure the doc has a version for `path`; returns the (possibly new) doc + the
 * matching versionId. Re-importing the same path reuses its version. The first
 * version added becomes the active one.
 */
export function ensureVersion(
  doc: ReviewDoc, path: string, label?: string, now = Date.now(),
): { doc: ReviewDoc; versionId: string } {
  const existing = doc.versions.find((v) => v.path === path);
  if (existing) {
    const next = doc.activeVersionId ? doc : { ...doc, activeVersionId: existing.id };
    return { doc: next, versionId: existing.id };
  }
  const version: ReviewVersion = {
    id: newId(),
    label: label ?? `V${doc.versions.length + 1}`,
    path,
    addedAt: now,
  };
  const next: ReviewDoc = {
    ...doc,
    versions: [...doc.versions, version],
    activeVersionId: doc.activeVersionId ?? version.id,
  };
  return { doc: next, versionId: version.id };
}

export function setActiveVersion(doc: ReviewDoc, versionId: string): ReviewDoc {
  return doc.versions.some((v) => v.id === versionId) ? { ...doc, activeVersionId: versionId } : doc;
}

// ── fingerprint index + review history ───────────────────────────────────────
// Reviews are keyed by source path/URL, but the SAME clip can live at a
// different location. A content fingerprint (filename + duration + dimensions,
// location-independent) maps to the review's key, so re-opening a clip you've
// reviewed before — even moved/renamed-folder — re-loads its notes. The history
// list powers the panel's "past reviews" popover.

const FP_INDEX_KEY = "saucebunny.review.fpindex";
const HISTORY_KEY = "saucebunny.review.history";

/**
 * Location-independent fingerprint for a clip. Built from intrinsic properties
 * (name stem + duration + dimensions + byte size) so a moved/renamed copy still
 * matches, while two genuinely different clips don't collide. Duration is kept
 * to tenths and byte size is included (when known) precisely to avoid the
 * collision where two distinct same-length, same-dimension clips would otherwise
 * share a key and load/overwrite each other's review.
 */
export function reviewFingerprint(
  title: string, durationSec: number, w?: number | null, h?: number | null, sizeBytes?: number | null,
): string {
  const name = (title || "").toLowerCase().replace(/\.[^.]+$/, "").replace(/\s+/g, " ").trim();
  const dur = Math.round((durationSec || 0) * 10); // tenths of a second
  const size = sizeBytes ? `|${sizeBytes}` : "";
  return `${name}|${dur}|${w ?? 0}x${h ?? 0}${size}`;
}

/** The review key a fingerprint maps to (null if this clip hasn't been reviewed). */
export function resolveByFingerprint(fp: string): string | null {
  return loadJson<Record<string, string>>(FP_INDEX_KEY, {})[fp] ?? null;
}

/** Remember that this fingerprint belongs to this review key. */
export function linkFingerprint(fp: string, key: string): void {
  const idx = loadJson<Record<string, string>>(FP_INDEX_KEY, {});
  if (idx[fp] === key) return;
  idx[fp] = key;
  saveJson(FP_INDEX_KEY, idx);
}

export type ReviewHistoryEntry = { key: string; title: string; path: string; updatedAt: number; count: number };

export function loadReviewHistory(): ReviewHistoryEntry[] {
  return loadJson<ReviewHistoryEntry[]>(HISTORY_KEY, []).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Insert or update a past-review entry (keyed by review key). */
export function upsertReviewHistory(entry: ReviewHistoryEntry): void {
  const list = loadJson<ReviewHistoryEntry[]>(HISTORY_KEY, []).filter((e) => e.key !== entry.key);
  list.push(entry);
  saveJson(HISTORY_KEY, list);
}

export function removeReviewHistory(key: string): void {
  saveJson(HISTORY_KEY, loadJson<ReviewHistoryEntry[]>(HISTORY_KEY, []).filter((e) => e.key !== key));
}

/** Drop the whole past-reviews list in one go. History entries are only
 *  pointers (key/title/path) — clearing them never deletes the review docs. */
export function clearReviewHistory(): void {
  saveJson(HISTORY_KEY, []);
}

// ── comments ─────────────────────────────────────────────────────────────────

export type NewComment = {
  versionId: string;
  timeStart: number;
  timeEnd?: number | null;
  body: string;
  author: string;
  parentId?: string | null;
  annotation?: AnnotationStrokes | null;
};

/** Build a fully-stamped comment (id + timestamps) WITHOUT inserting it. The
 *  co-review path needs the finished comment up front so the SAME id/time is
 *  carried in the op and applied identically on every peer. */
export function buildComment(c: NewComment, now = Date.now()): ReviewComment {
  return {
    id: newId(),
    versionId: c.versionId,
    parentId: c.parentId ?? null,
    timeStart: c.timeStart,
    timeEnd: c.timeEnd ?? null,
    body: c.body,
    resolved: false,
    author: c.author,
    createdAt: now,
    updatedAt: now,
    annotation: c.annotation ?? null,
  };
}

/** Append a pre-built comment; a no-op if its id is already present (so
 *  replaying/echoing an op can't duplicate it — the co-review convergence
 *  guarantee for add-ops). */
export function insertComment(doc: ReviewDoc, comment: ReviewComment): ReviewDoc {
  if (doc.comments.some((c) => c.id === comment.id)) return doc;
  return { ...doc, comments: [...doc.comments, comment] };
}

export function addComment(doc: ReviewDoc, c: NewComment, now = Date.now()): ReviewDoc {
  return insertComment(doc, buildComment(c, now));
}

export function editComment(doc: ReviewDoc, id: string, body: string, now = Date.now()): ReviewDoc {
  return {
    ...doc,
    comments: doc.comments.map((c) => (c.id === id ? { ...c, body, updatedAt: now } : c)),
  };
}

/** Delete a comment and (if it's a root) all of its replies. */
export function deleteComment(doc: ReviewDoc, id: string): ReviewDoc {
  return {
    ...doc,
    comments: doc.comments.filter((c) => c.id !== id && c.parentId !== id),
  };
}

/** Edit a reply's body. The reply is addressed through its full path
 *  (version → parent comment → reply) so a stale/foreign id can't edit the
 *  wrong note; any mismatch is a no-op (returns the doc unchanged). */
export function editReply(
  doc: ReviewDoc, versionId: string, commentId: string, replyId: string, newBody: string, now = Date.now(),
): ReviewDoc {
  const match = (c: ReviewComment) =>
    c.id === replyId && c.parentId === commentId && c.versionId === versionId;
  if (!doc.comments.some(match)) return doc;
  return {
    ...doc,
    comments: doc.comments.map((c) => (match(c) ? { ...c, body: newBody, updatedAt: now } : c)),
  };
}

/** Delete a single reply (parity with deleteComment for roots). Addressed by
 *  full path like editReply; unknown ids are a no-op. */
export function removeReply(
  doc: ReviewDoc, versionId: string, commentId: string, replyId: string,
): ReviewDoc {
  const match = (c: ReviewComment) =>
    c.id === replyId && c.parentId === commentId && c.versionId === versionId;
  if (!doc.comments.some(match)) return doc;
  return { ...doc, comments: doc.comments.filter((c) => !match(c)) };
}

/** Toggle `name` in a comment's likes. Roots and replies both live in the
 *  flat comments array, so one op covers both. The name is trimmed; an empty
 *  name or unknown id is a no-op (returns the doc unchanged). Deliberately
 *  does NOT bump updatedAt — someone else's like isn't an edit of the note. */
export function toggleLike(doc: ReviewDoc, commentId: string, name: string): ReviewDoc {
  const who = name.trim();
  if (!who || !doc.comments.some((c) => c.id === commentId)) return doc;
  return {
    ...doc,
    comments: doc.comments.map((c) => {
      if (c.id !== commentId) return c;
      const likes = c.likes ?? [];
      return { ...c, likes: likes.includes(who) ? likes.filter((n) => n !== who) : [...likes, who] };
    }),
  };
}

export function toggleResolved(doc: ReviewDoc, id: string, now = Date.now()): ReviewDoc {
  return {
    ...doc,
    comments: doc.comments.map((c) =>
      c.id === id ? { ...c, resolved: !c.resolved, updatedAt: now } : c),
  };
}

/** SET (not toggle) the resolved flag — the idempotent form the co-review op
 *  relay needs so replaying/echoing an op converges instead of flip-flopping. */
export function setResolved(doc: ReviewDoc, id: string, resolved: boolean, now = Date.now()): ReviewDoc {
  return {
    ...doc,
    comments: doc.comments.map((c) => (c.id === id ? { ...c, resolved, updatedAt: now } : c)),
  };
}

/** SET (not toggle) `name`'s membership in a comment's likes — the idempotent
 *  form for the op relay (two applies land the same place). */
export function setLike(doc: ReviewDoc, id: string, name: string, liked: boolean): ReviewDoc {
  const who = name.trim();
  if (!who) return doc;
  return {
    ...doc,
    comments: doc.comments.map((c) => {
      if (c.id !== id) return c;
      const likes = c.likes ?? [];
      const has = likes.includes(who);
      if (liked && !has) return { ...c, likes: [...likes, who] };
      if (!liked && has) return { ...c, likes: likes.filter((n) => n !== who) };
      return c;
    }),
  };
}

// ── co-review op relay ───────────────────────────────────────────────────────
// A ReviewOp is the serializable, order-independent unit that flows over the
// P2P session (App applies it to the shared session doc; the host relays it to
// peers). Design for convergence with a host-authoritative relay + 2-4 people:
//   • `add` carries the FULLY-BUILT comment (id + timestamps stamped once by
//     the author) so every peer inserts the identical row; idempotent by id.
//   • `resolve` / `like` are SET (not toggle) so echoes/replays are idempotent.
//   • `edit` / `resolve` / `editReply` guard on the carried timestamp (LWW) so
//     the rare concurrent edit of the SAME comment converges to the later one
//     instead of diverging per-peer.
//   • `del` / `delReply` are naturally idempotent (filter).
export type ReviewOp =
  | { t: "add"; comment: ReviewComment }
  | { t: "edit"; id: string; body: string; at: number }
  | { t: "del"; id: string }
  | { t: "resolve"; id: string; resolved: boolean; at: number }
  | { t: "like"; id: string; name: string; liked: boolean }
  | { t: "editReply"; versionId: string; commentId: string; replyId: string; body: string; at: number }
  | { t: "delReply"; versionId: string; commentId: string; replyId: string }
  /** Source-level verdict (per active version). LWW like edits; relayed in
   *  co-review with zero Rust changes (the star is payload-agnostic). */
  | { t: "status"; versionId: string; state: ReviewStatusState; reviewer: string; at: number };

// LWW with a deterministic tiebreak: a stale op (older timestamp) is skipped;
// a same-millisecond collision from two machines is broken by a value both
// peers agree on (lexical body / resolved=true wins) so the result converges
// regardless of the order the two ops happened to be applied in.
function editLoses(op: { at: number; body: string }, cur: ReviewComment): boolean {
  return op.at < cur.updatedAt || (op.at === cur.updatedAt && op.body <= cur.body);
}

/** Apply one op to the shared doc. Pure; safe to replay (idempotent adds/sets,
 *  LWW-guarded edits). Unknown op shapes return the doc unchanged. */
export function applyReviewOp(doc: ReviewDoc, op: ReviewOp): ReviewDoc {
  switch (op.t) {
    case "status": {
      const cur = statusOf(doc, op.versionId);
      // LWW; same-millisecond collisions break on the state string so both
      // sides converge no matter the arrival order.
      if (op.at < cur.updatedAt || (op.at === cur.updatedAt && op.state <= cur.state)) return doc;
      return {
        ...doc,
        status: {
          ...doc.status,
          [op.versionId]: { state: op.state, note: cur.note, updatedAt: op.at, reviewer: op.reviewer },
        },
      };
    }
    case "add":
      return insertComment(doc, op.comment);
    case "edit": {
      const cur = doc.comments.find((c) => c.id === op.id);
      if (cur && editLoses(op, cur)) return doc;
      return editComment(doc, op.id, op.body, op.at);
    }
    case "del":
      return deleteComment(doc, op.id);
    case "resolve": {
      const cur = doc.comments.find((c) => c.id === op.id);
      // On a true timestamp tie, resolved=true wins deterministically.
      if (cur && (op.at < cur.updatedAt || (op.at === cur.updatedAt && !op.resolved))) return doc;
      return setResolved(doc, op.id, op.resolved, op.at);
    }
    case "like":
      return setLike(doc, op.id, op.name, op.liked);
    case "editReply": {
      const cur = doc.comments.find((c) => c.id === op.replyId);
      if (cur && editLoses(op, cur)) return doc;
      return editReply(doc, op.versionId, op.commentId, op.replyId, op.body, op.at);
    }
    case "delReply":
      return removeReply(doc, op.versionId, op.commentId, op.replyId);
    default:
      return doc;
  }
}

/** Ops that reverse `op`, given the doc as it was BEFORE the op applied.
 *  Powers the local-user undo stack (lib/undo.ts): the panel snapshots the
 *  pre-op doc when it dispatches, and computes the inverse lazily at undo
 *  time. `at` must be stamped at EXECUTION time (a fresh Date.now()) so the
 *  inverse beats the LWW guard of the op it reverses. Re-adds carry the
 *  ORIGINAL comment (same id/timestamps — insertComment is idempotent by id),
 *  so an undo-of-delete converges in co-review exactly like a normal add.
 *  Unknown targets return [] (nothing to reverse). */
export function inverseReviewOps(before: ReviewDoc, op: ReviewOp, at = Date.now()): ReviewOp[] {
  switch (op.t) {
    case "add":
      // Works for roots and replies alike: deleteComment drops replies only
      // via parentId === id, and a reply's id is never another's parentId.
      return [{ t: "del", id: op.comment.id }];
    case "del": {
      // deleteComment removes the root AND its replies — resurrect all of
      // them (peers' replies included, authorship intact).
      const removed = before.comments.filter((c) => c.id === op.id || c.parentId === op.id);
      return removed.map((c) => ({ t: "add", comment: c }));
    }
    case "delReply": {
      const r = before.comments.find(
        (c) => c.id === op.replyId && c.parentId === op.commentId && c.versionId === op.versionId);
      return r ? [{ t: "add", comment: r }] : [];
    }
    case "edit": {
      const cur = before.comments.find((c) => c.id === op.id);
      return cur ? [{ t: "edit", id: op.id, body: cur.body, at }] : [];
    }
    case "editReply": {
      const cur = before.comments.find((c) => c.id === op.replyId);
      return cur
        ? [{ t: "editReply", versionId: op.versionId, commentId: op.commentId, replyId: op.replyId, body: cur.body, at }]
        : [];
    }
    case "resolve": {
      const cur = before.comments.find((c) => c.id === op.id);
      return [{ t: "resolve", id: op.id, resolved: cur ? cur.resolved : !op.resolved, at }];
    }
    case "like":
      return [{ t: "like", id: op.id, name: op.name, liked: !op.liked }];
    case "status": {
      const prev = statusOf(before, op.versionId);
      return [{ t: "status", versionId: op.versionId, state: prev.state, reviewer: prev.reviewer, at }];
    }
    default:
      return [];
  }
}

/** Re-stamp an op's LWW timestamp for replay (redo): its own undo just wrote
 *  a NEWER updatedAt, so replaying the op verbatim would lose the LWW guard
 *  and no-op. Ops without `at` are returned unchanged. */
export function restampReviewOp(op: ReviewOp, at: number): ReviewOp {
  switch (op.t) {
    case "edit":
    case "resolve":
    case "editReply":
      return { ...op, at };
    default:
      return op;
  }
}

/** Merge an incoming (authoritative) snapshot with the local doc so a local op
 *  that hasn't been echoed back yet survives a snapshot re-adopt (the host
 *  re-broadcasts a full doc on every join; without this an existing peer's
 *  in-flight comment/edit would silently vanish). Starts from `incoming`;
 *  re-folds any local-only comment (idempotent add), keeps the newer of a
 *  shared comment by updatedAt, and UNIONs likes (which don't bump updatedAt)
 *  so a not-yet-echoed like isn't dropped. */
export function mergeReviewDoc(local: ReviewDoc, incoming: ReviewDoc): ReviewDoc {
  const byId = new Map<string, ReviewComment>(incoming.comments.map((c) => [c.id, { ...c }]));
  for (const lc of local.comments) {
    const ic = byId.get(lc.id);
    if (!ic) { byId.set(lc.id, lc); continue; } // local-only → keep it
    const base = lc.updatedAt > ic.updatedAt ? { ...lc } : { ...ic };
    const likes = Array.from(new Set([...(ic.likes ?? []), ...(lc.likes ?? [])]));
    base.likes = likes.length ? likes : undefined;
    byId.set(lc.id, base);
  }
  const status: Record<string, ReviewStatus> = { ...incoming.status };
  for (const [vid, st] of Object.entries(local.status)) {
    const other = status[vid];
    if (!other || st.updatedAt > other.updatedAt) status[vid] = st;
  }
  return { ...incoming, comments: Array.from(byId.values()), status };
}

// ── approval status ──────────────────────────────────────────────────────────

export function setStatus(
  doc: ReviewDoc, versionId: string, state: ReviewStatusState, note = "", now = Date.now(), reviewer = "",
): ReviewDoc {
  return { ...doc, status: { ...doc.status, [versionId]: { state, note, updatedAt: now, reviewer } } };
}

export function statusOf(doc: ReviewDoc, versionId: string | null): ReviewStatus {
  const st = (versionId && doc.status[versionId]) || { state: "pending" as const, note: "", updatedAt: 0 };
  // Legacy docs predate the reviewer field.
  return { reviewer: "", ...st };
}

// ── selectors (pure, for the panel + timeline markers) ───────────────────────

/** Root comments for a version (no replies), sorted. */
export function rootComments(doc: ReviewDoc, versionId: string | null, sort: CommentSort = "time"): ReviewComment[] {
  const roots = doc.comments.filter((c) => c.versionId === versionId && c.parentId === null);
  return sortComments(roots, sort);
}

export function repliesOf(doc: ReviewDoc, parentId: string): ReviewComment[] {
  return doc.comments
    .filter((c) => c.parentId === parentId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function sortComments(list: ReviewComment[], sort: CommentSort): ReviewComment[] {
  const copy = [...list];
  if (sort === "time") copy.sort((a, b) => a.timeStart - b.timeStart || a.createdAt - b.createdAt);
  else if (sort === "newest") copy.sort((a, b) => b.createdAt - a.createdAt);
  else copy.sort((a, b) => a.createdAt - b.createdAt);
  return copy;
}

/** Marker positions for the monitor timeline (root comments only). Carries the
 *  author so the dot can be tinted to that reviewer's colour + show initials. */
export function commentMarkers(
  doc: ReviewDoc, versionId: string | null,
): { id: string; time: number; timeEnd: number | null; resolved: boolean; author: string }[] {
  return doc.comments
    .filter((c) => c.versionId === versionId && c.parentId === null)
    .map((c) => ({ id: c.id, time: c.timeStart, timeEnd: c.timeEnd, resolved: c.resolved, author: c.author }));
}

// ── reviewer identity (name + avatar colour) ─────────────────────────────────
// Shared so both the Review panel and the timeline markers resolve the same
// colour/initials for a given author. Single local reviewer for now; the
// per-author fallback colour means future multi-reviewer "just works".

export const AUTHOR_KEY = "saucebunny.review.author";
export const AUTHOR_COLOR_KEY = "saucebunny.review.authorColor";

/** Palette for avatar colours + the name-modal colour picker. Index 0 is the
 *  first-run default, so it leads with the panel's blue (#4dabf7 — the same
 *  hue as the timecode chips); pink/magenta sit at the end of the list. */
export const AVATAR_COLORS = ["#4dabf7", "#f5a623", "#7b61ff", "#2dd4bf", "#ff6b6b", "#34d399", "#e879f9", "#fb7185"];

/** Stable per-name avatar colour (each person gets a consistent hue). */
export function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/** Two-letter initials for the avatar chip. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** The current local reviewer (name + chosen colour) from localStorage.
 *  A first-run (unnamed) reviewer defaults to AVATAR_COLORS[0] (blue) rather
 *  than a hash of a placeholder name, which used to land on pink. */
export function loadReviewer(): { name: string; color: string } {
  const name = loadJson<string>(AUTHOR_KEY, "");
  return { name, color: loadJson<string>(AUTHOR_COLOR_KEY, name ? avatarColor(name) : AVATAR_COLORS[0]) };
}

/** Resolve an author's avatar colour: the current reviewer's chosen colour for
 *  their own notes, else a stable per-name hue. */
export function reviewerColorFor(author: string, me: { name: string; color: string }): string {
  return author && author === me.name ? me.color : avatarColor(author);
}

export function openCount(doc: ReviewDoc, versionId: string | null): number {
  return doc.comments.filter((c) => c.versionId === versionId && c.parentId === null && !c.resolved).length;
}

/** Saved drawings for a version (time + strokes/labels) — drives the on-frame
 *  proximity fade: the overlay shows a drawing as the playhead nears its time.
 *  Carries the author so label chips can be tinted to that reviewer's colour. */
export function annotationsOf(
  doc: ReviewDoc, versionId: string | null,
): { id: string; time: number; author: string; strokes: AnnotationStrokes }[] {
  return doc.comments
    .filter((c) => c.versionId === versionId && c.parentId === null && annotationHasContent(c.annotation))
    .map((c) => ({ id: c.id, time: c.timeStart, author: c.author, strokes: c.annotation as AnnotationStrokes }));
}

// ── export (the local stand-in for Frame.io's share link) ────────────────────
// A local app can't host a public review URL, so instead we export the review to
// portable artifacts: human-readable notes (Markdown), a marker spreadsheet
// (CSV), and an NLE marker list (CMX3600 EDL — Resolve/Premiere import markers).

export const STATUS_LABEL: Record<ReviewStatusState, string> = {
  pending: "Pending", approved: "Approved", changes: "Changes requested",
};

/** Keep exported comment text / names literal in Markdown: collapse newlines
 *  (which would otherwise inject a stray heading, list item, or code fence) and
 *  escape the inline formatters. These files are deliberately handed to others. */
function mdInline(s: string): string {
  return s.replace(/[\r\n]+/g, " ").replace(/[`*_\[\]]/g, "\\$&").trim();
}

/** Render a comment's annotation labels for the exports, appended to the
 *  comment line: ` [label: "Fix this"] [label: "And this"]`. Strokes have no
 *  textual form so they stay export-invisible (as before); labels are text, so
 *  they carry. `esc` lets each format escape the label text its own way (the
 *  Markdown export passes mdInline; CSV/EDL escape the whole line downstream). */
export function labelSuffix(c: ReviewComment, esc: (s: string) => string = (s) => s): string {
  const labels = c.annotation?.labels ?? [];
  return labels.map((l) => ` [label: "${esc(l.text)}"]`).join("");
}

/** Human-readable review notes for the active version. */
export function reviewToMarkdown(doc: ReviewDoc, title = "Review"): string {
  const v = doc.versions.find((x) => x.id === doc.activeVersionId);
  const roots = rootComments(doc, doc.activeVersionId, "time");
  const st = statusOf(doc, doc.activeVersionId);
  const out: string[] = [
    `# Review — ${mdInline(title)}`,
    "",
    `**Status:** ${STATUS_LABEL[st.state]}${st.note ? ` — ${mdInline(st.note)}` : ""}`,
    v ? `**Version:** ${mdInline(v.label)}` : "",
    `**Comments:** ${roots.length}`,
    "",
  ];
  for (const c of roots) {
    out.push(`- **[${secondsToHms(c.timeStart)}]** ${mdInline(c.body)}${labelSuffix(c, mdInline)} — ${mdInline(c.author)}${c.resolved ? "  _(resolved)_" : ""}`);
    for (const r of repliesOf(doc, c.id)) out.push(`  - ↳ ${mdInline(r.body)} — ${mdInline(r.author)}`);
  }
  return out.filter((l) => l !== "").join("\n") + "\n";
}

function csvCell(s: string): string {
  // Neutralize spreadsheet formula injection: Excel/Numbers/LibreOffice evaluate
  // a cell whose text starts with = + - @ (or a tab/CR) even when it's quoted.
  // These exports are deliberately handed to other people, so prefix such a cell
  // with a single quote to force it to plain text.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""').replace(/[\r\n]+/g, " ")}"`;
}

/** Marker spreadsheet (timecode, status, author, comment) for the active version. */
export function reviewToCsv(doc: ReviewDoc, fps: number): string {
  const rows = ["Timecode,Resolved,Author,Comment"];
  for (const c of rootComments(doc, doc.activeVersionId, "time")) {
    rows.push([secondsToTc(c.timeStart, fps), c.resolved ? "yes" : "no", csvCell(c.author), csvCell(c.body + labelSuffix(c))].join(","));
  }
  return rows.join("\n") + "\n";
}

/** CMX3600 EDL whose events carry the comments as timeline markers (Resolve/Premiere). */
export function reviewToEdl(doc: ReviewDoc, fps: number, title = "Sauce Bunny Review"): string {
  // TITLE must be a single line per CMX3600 — strip newlines from the source name.
  const safeTitle = title.replace(/[\r\n]+/g, " ");
  const lines = [`TITLE: ${safeTitle}`, "FCM: NON-DROP FRAME", ""];
  let n = 1;
  for (const c of rootComments(doc, doc.activeVersionId, "time")) {
    const inTc = secondsToTc(c.timeStart, fps);
    const outTc = secondsToTc(c.timeStart + 1 / Math.max(1, Math.round(fps)), fps);
    const ev = String(n++).padStart(3, "0");
    const color = c.resolved ? "ResolveColorGreen" : "ResolveColorRed";
    const note = (c.body + labelSuffix(c)).replace(/[\r\n]+/g, " ");
    lines.push(`${ev}  AX       V     C        ${inTc} ${outTc} ${inTc} ${outTc}`);
    lines.push(` |C:${color} |M:${note} |D:1`);
  }
  return lines.join("\n") + "\n";
}
