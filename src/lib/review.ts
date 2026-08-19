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
import { secondsToHms } from "./timecode";

export type ReviewStatusState = "pending" | "approved" | "changes";

/** A Frame.io-style text callout anchored to a point on the frame. Coords are
 *  normalized 0..1 like stroke points so the label scales with the video box. */
export type AnnotationLabel = { text: string; x: number; y: number };

/** A free-hand drawing captured on a frame, stored with a comment. Points are
 *  normalized 0..1 against the canvas it was drawn on so it scales to any size. */
export type AnnotationStrokes = {
  strokes: {
    color: string;
    size: number;
    /**
     * Normalised points, with an OPTIONAL third element: pen pressure 0..1.
     *
     * Additive for the same reason `labels` is: strokes drawn before pressure
     * existed are plain [x, y] pairs and must keep rendering, and a peer on an
     * older build destructures only the first two — so a 3-tuple degrades to a
     * constant-width line there instead of breaking. Never widen this to a
     * required field.
     */
    pts: ([number, number] | [number, number, number])[];
    /** 0..1, so a saved highlighter still reads as one. Optional: strokes drawn
     *  before tools existed have none and paint fully opaque. */
    opacity?: number;
    /** Width multiplier for broad tools. Optional for the same reason. */
    widthScale?: number;
  }[];
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
  /** Reviewer names who liked this note. LEGACY field: thumbs-up reactions
   *  from older docs; folded into `reactions` by reactionsOf. Optional so
   *  docs persisted before likes existed parse unchanged. */
  likes?: string[];
  /** Per-emoji reactions: glyph -> reviewer names. Optional for old docs. */
  reactions?: Record<string, string[]>;
  /** When each reviewer last set or cleared each emoji: glyph -> name -> op.
   *
   *  `reactions` alone is a grow-only set, and a union of two grow-only sets
   *  cannot express "Ana took hers off" - so the merge used to resurrect every
   *  removal, write it back to disk, and resurrect it again on the next
   *  reconcile. This is the missing half: the same carry-the-timestamp,
   *  later-op-wins rule `edit` / `resolve` / `status` already use.
   *
   *  Optional, and absent on every doc written before it existed - which is
   *  why the merge falls back to unioning names it has no history for. */
  reactedAt?: Record<string, Record<string, { on: boolean; at: number }>>;
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

/** True when a review key/path is a filesystem location on SOMEONE'S machine
 *  (POSIX or Windows absolute, or a file URL) — meaningless, and not ours to
 *  reveal, on a peer's machine. */
export function isHostLocalKey(s: string): boolean {
  return s.startsWith("/") || s.startsWith("file://") || /^[A-Za-z]:[\\/]/.test(s);
}

/**
 * A copy of `doc` that is safe to put ON THE WIRE (the co-review `reviewDoc`
 * broadcast). A locally-keyed doc used to ship the host's absolute file path
 * twice — as `sourceKey` (the first-review fallback before the fingerprint
 * index knows the file) and inside every version's `path` — so guests
 * received, and then persisted docs under, strings like
 * `/Users/<name>/Clients/<project>/cut.mov`. On the wire the sourceKey is the
 * session's content-fingerprint key (the identity `loadSource` already
 * announces) and local version paths are dropped; a version's shared identity
 * is its id + label. URLs pass through — the room is already watching them.
 * Host-local state (sessionDoc, persistence) must never go through this.
 */
export function sanitizeDocForWire(doc: ReviewDoc, wireKey: string | null): ReviewDoc {
  return {
    ...doc,
    sourceKey: isHostLocalKey(doc.sourceKey) ? (wireKey || "shared-local") : doc.sourceKey,
    versions: doc.versions.map((v) => (isHostLocalKey(v.path) ? { ...v, path: "" } : v)),
  };
}

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
 * (name stem + duration + dimensions + byte size) so a MOVED copy still
 * matches, while two genuinely different clips don't collide.
 *
 * NOT rename-safe, and this comment used to claim it was. The name stem is IN
 * the hash, so renaming a file produces a different fingerprint and detaches
 * its review doc, its comments and its speaker names. That is fine today
 * because nothing renames media — but a rename feature MUST call
 * `linkFingerprint(newFp, existingKey)` at rename time, while it still holds
 * both identities, or a bulk rename silently discards every review in the
 * batch. Do not "fix" this by dropping the name from the hash: duration +
 * dimensions + size alone is exactly the collision the name was added to
 * prevent. Duration is kept
 * to tenths and byte size is included (when known) precisely to avoid the
 * collision where two distinct same-length, same-dimension clips would otherwise
 * share a key and load/overwrite each other's review.
 */
export function reviewFingerprint(
  title: string, durationSec: number, w?: number | null, h?: number | null, sizeBytes?: number | null,
): string {
  // NFC first. macOS stores filenames DECOMPOSED and a rename dialog returns
  // what the keyboard sent, which is COMPOSED, so the same file yields two
  // different fingerprints depending on which side asked. What that costs is
  // not a cache miss: the review index stops resolving, the app falls back to
  // the path, and the user opens a file they have annotated for a week and
  // finds an empty review. The notes are still on disk under the old key,
  // which makes it worse rather than better - nothing looks broken.
  const name = (title || "").normalize("NFC")
    .toLowerCase().replace(/\.[^.]+$/, "").replace(/\s+/g, " ").trim();
  const dur = Math.round((durationSec || 0) * 10); // tenths of a second
  const size = sizeBytes ? `|${sizeBytes}` : "";
  return `${name}|${dur}|${w ?? 0}x${h ?? 0}${size}`;
}

/** The review key a fingerprint maps to (null if this clip hasn't been reviewed). */
export function resolveByFingerprint(fp: string): string | null {
  const idx = loadJson<Record<string, string>>(FP_INDEX_KEY, {});
  const hit = idx[fp];
  if (hit !== undefined) return hit;
  // Miss: an entry written before fingerprints were normalised may be stored
  // under the decomposed spelling. Scanning is fine here - the index holds one
  // entry per reviewed file, and this only runs when the fast path failed.
  const want = fp.normalize("NFC");
  for (const [k, v] of Object.entries(idx)) {
    if (k.normalize("NFC") === want) return v;
  }
  return null;
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



/** SET (not toggle) the resolved flag — the idempotent form the co-review op
 *  relay needs so replaying/echoing an op converges instead of flip-flopping. */
export function setResolved(doc: ReviewDoc, id: string, resolved: boolean, now = Date.now()): ReviewDoc {
  return {
    ...doc,
    comments: doc.comments.map((c) => (c.id === id ? { ...c, resolved, updatedAt: now } : c)),
  };
}

/** Merged reaction view: the reactions map plus legacy likes folded in as
 *  thumbs-up (old docs keep rendering without a migration pass). */
export function reactionsOf(c: ReviewComment): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [emoji, names] of Object.entries(c.reactions ?? {})) {
    if (names.length) out[emoji] = [...names];
  }
  if (c.likes?.length) {
    out["👍"] = [...new Set([...(out["👍"] ?? []), ...c.likes])];
  }
  return out;
}

/** SET (not toggle) `name`'s membership in a comment's per-emoji reactions —
 *  the idempotent form for the op relay (two applies land the same place).
 *  Default 👍 keeps pre-emoji ops meaningful; removing 👍 also strips the
 *  legacy likes entry so old docs un-react cleanly. */
export function setLike(
  doc: ReviewDoc, id: string, name: string, liked: boolean, emoji = "👍", at = Date.now(),
): ReviewDoc {
  const who = name.trim();
  // Unknown ids are an identity no-op (callers rely on reference equality
  // to skip persistence).
  if (!who || !doc.comments.some((c) => c.id === id)) return doc;
  return {
    ...doc,
    comments: doc.comments.map((c) => {
      if (c.id !== id) return c;
      const cur = c.reactions?.[emoji] ?? [];
      const inLegacy = emoji === "👍" && (c.likes ?? []).includes(who);
      const has = cur.includes(who) || inLegacy;
      const known = c.reactedAt?.[emoji]?.[who];
      // Identity no-op only when the history ALREADY says this, not merely
      // when the membership happens to match. A peer applying "Ana un-reacted"
      // against a copy that never had Ana still has to record the removal, or
      // that peer is the one who resurrects it at the next merge.
      if (liked === has && !inLegacy && known?.on === liked) return c;
      const reactions = { ...(c.reactions ?? {}) };
      if (liked) {
        if (!cur.includes(who)) reactions[emoji] = [...cur, who];
      } else {
        const next = cur.filter((n) => n !== who);
        if (next.length) reactions[emoji] = next;
        else delete reactions[emoji];
      }
      const likes = inLegacy && !liked ? (c.likes ?? []).filter((n) => n !== who) : c.likes;
      // Keep the newest op per (emoji, reviewer): a replayed or out-of-order
      // relay echo must not roll the state back to an older one.
      const forEmoji = { ...(c.reactedAt?.[emoji] ?? {}) };
      if (!known || at >= known.at) forEmoji[who] = { on: liked, at };
      return {
        ...c,
        reactions: Object.keys(reactions).length ? reactions : undefined,
        likes: likes && likes.length ? likes : undefined,
        reactedAt: { ...(c.reactedAt ?? {}), [emoji]: forEmoji },
      };
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
  /** `at` is optional only for peers on a build that predates it; without
   *  one the receiver stamps arrival time, which is the best it can do. */
  | { t: "like"; id: string; name: string; liked: boolean; emoji?: string; at?: number }
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
      return setLike(doc, op.id, op.name, op.liked, op.emoji, op.at ?? Date.now());
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
      return [{ t: "like", id: op.id, name: op.name, liked: !op.liked, emoji: op.emoji }];
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
/**
 * Reconcile two copies of one comment's reactions.
 *
 * Union is the right answer for ADDS - two people reacting at the same moment
 * on different machines must both land, and that is what shipped. It is only
 * wrong for removals, which a grow-only set cannot express at all.
 *
 * So: union the membership, then let any recorded op override it, newest
 * first. Three consequences worth stating, because each is a decision:
 *
 *   · A name with no op history on either side keeps the old union
 *     behaviour. Docs written before `reactedAt` existed record WHO reacted
 *     but not WHEN, and there is nothing better to do with that.
 *   · An op beats no-op-history. If one side says "Ana cleared hers at T"
 *     and the other just lists Ana with no idea when, the side holding a
 *     time is the one that learned something.
 *   · A same-millisecond collision resolves to `on`, matching how the op
 *     relay breaks its other ties (resolved=true wins) so both peers land
 *     on the same value regardless of arrival order.
 */
function mergeReactions(
  ic: ReviewComment, lc: ReviewComment,
): { reactions?: Record<string, string[]>; reactedAt?: ReviewComment["reactedAt"] } {
  const emojiKeys = new Set([
    ...Object.keys(ic.reactions ?? {}), ...Object.keys(lc.reactions ?? {}),
    ...Object.keys(ic.reactedAt ?? {}), ...Object.keys(lc.reactedAt ?? {}),
  ]);
  if (!emojiKeys.size) return {};

  const reactions: Record<string, string[]> = {};
  const reactedAt: NonNullable<ReviewComment["reactedAt"]> = {};
  for (const e of emojiKeys) {
    const latest: Record<string, { on: boolean; at: number }> = {};
    for (const side of [ic, lc]) {
      for (const [who, op] of Object.entries(side.reactedAt?.[e] ?? {})) {
        const cur = latest[who];
        if (!cur || op.at > cur.at || (op.at === cur.at && op.on)) latest[who] = op;
      }
    }
    const names = new Set([...(ic.reactions?.[e] ?? []), ...(lc.reactions?.[e] ?? [])]);
    for (const [who, op] of Object.entries(latest)) {
      if (op.on) names.add(who);
      else names.delete(who);
    }
    if (names.size) reactions[e] = [...names];
    if (Object.keys(latest).length) reactedAt[e] = latest;
  }
  return {
    reactions: Object.keys(reactions).length ? reactions : undefined,
    reactedAt: Object.keys(reactedAt).length ? reactedAt : undefined,
  };
}

/**
 * Adopt a snapshot from the host: merge it over what we have, then replay any
 * ops we posted before we had a doc to put them in.
 *
 * PURE, and that is the whole reason it exists as a function. This logic used
 * to live inside a `setSessionDoc(prev => ...)` updater that also wrote to
 * disk and emptied `pendingOpsRef` as it went. React 18 StrictMode
 * double-invokes updaters in development precisely to surface that: the first
 * call replayed the pending ops and cleared the ref, the second call ran again
 * with the same `prev`, found the ref empty, and returned a doc WITHOUT them -
 * and the second result is the one React keeps. So the author's own
 * pre-snapshot comments vanished, which is the exact failure the replay was
 * written to prevent.
 *
 * The caller now drains the queue once, outside, and hands the ops in.
 */
export function adoptSnapshot(
  prev: ReviewDoc | null,
  incoming: ReviewDoc,
  pending: readonly ReviewOp[] = [],
): ReviewDoc {
  let next = prev ? mergeReviewDoc(prev, incoming) : incoming;
  for (const op of pending) next = applyReviewOp(next, op);
  return next;
}

export function mergeReviewDoc(local: ReviewDoc, incoming: ReviewDoc): ReviewDoc {
  // NEVER fold across sources. Without this, ending a session after the room
  // had switched sources called mergeReviewDoc(loadReview(A), docForB), which
  // unioned B's comments into A's file AND restamped that file with B's key -
  // silently corrupting the notes on a source nobody was even discussing.
  // Different key means these are two different conversations: take the
  // incoming one whole and leave `local` alone on disk.
  if (local.sourceKey !== incoming.sourceKey) return incoming;
  const byId = new Map<string, ReviewComment>(incoming.comments.map((c) => [c.id, { ...c }]));
  for (const lc of local.comments) {
    const ic = byId.get(lc.id);
    if (!ic) { byId.set(lc.id, lc); continue; } // local-only → keep it
    const base = lc.updatedAt > ic.updatedAt ? { ...lc } : { ...ic };
    const { reactions, reactedAt } = mergeReactions(ic, lc);
    // `likes` is the pre-emoji thumbs-up field, and reactionsOf folds it back
    // in as 👍 - so unioning it blindly puts a removal straight back through
    // the OLD representation, which is the exact bug reactedAt was added to
    // fix. A doc written before per-emoji reactions existed carries no
    // history of its own, so it is the recorded 👍 op that decides.
    const thumbs = reactedAt?.["👍"] ?? {};
    const likes = Array.from(new Set([...(ic.likes ?? []), ...(lc.likes ?? [])]))
      .filter((who) => thumbs[who]?.on !== false);
    base.likes = likes.length ? likes : undefined;
    if (reactions || reactedAt) {
      base.reactions = reactions;
      base.reactedAt = reactedAt;
    }
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

// ── Version stacks ───────────────────────────────────────────────────────────
// A stack IS a ReviewDoc: the doc was born with versions[] and per-version
// comments, and every doc simply had one version because a new render is a
// new file, a new key, a fresh empty doc. Stacking = adding the new render as
// a version of the OLD doc and pointing the new file's fingerprint at it, so
// the existing moved-file resolution machinery routes every future open to
// the shared doc. See _design/review-versioning.md for the Frame.io
// comparison this is modeled against (and where it deliberately diverges:
// carry-forward of unresolved notes, which Frame.io cannot do).

/** Switch which version the panel views. Persisted in the doc, so a stack
 *  re-opens where you left it. */
export function setActiveVersion(doc: ReviewDoc, versionId: string): ReviewDoc {
  if (!doc.versions.some((v) => v.id === versionId)) return doc;
  return { ...doc, activeVersionId: versionId };
}

/**
 * Take a version back out of a stack — the escape hatch for a wrong link.
 *
 * REFUSES when the version holds comments (they would be orphaned: comments
 * carry only a versionId) or when it is the last version (a doc with zero
 * versions cannot hold anything). Both refusals return the doc unchanged, so
 * a caller cannot half-apply. The active pointer moves to the newest
 * remaining version when it pointed at the removed one.
 */
export function removeVersion(doc: ReviewDoc, versionId: string): ReviewDoc {
  if (doc.versions.length < 2) return doc;
  if (!doc.versions.some((v) => v.id === versionId)) return doc;
  if (doc.comments.some((c) => c.versionId === versionId)) return doc;
  const versions = doc.versions.filter((v) => v.id !== versionId);
  const status = { ...doc.status };
  delete status[versionId];
  const activeVersionId = doc.activeVersionId === versionId
    ? versions[versions.length - 1].id
    : doc.activeVersionId;
  return { ...doc, versions, status, activeVersionId };
}

/**
 * Inverses for a whole BATCH, in the order they must be replayed to undo it.
 *
 * ORDER IS THE WHOLE POINT, and it is not the order you write. Undoing
 * [A, B, C] means running C⁻¹, then B⁻¹, then A⁻¹ — each inverse assumes the
 * document state its own op produced, so replaying them forwards walks the
 * doc through states that never existed. Two edits to one comment show it:
 * inverses computed eagerly are ["back to orig", "back to a"], and replaying
 * those in order lands on "a" — the intermediate value — instead of "orig".
 *
 * The batch import that motivated this is all independent adds, where the
 * order genuinely does not matter, which is exactly why a hand-rolled forward
 * loop looked correct and would have stayed correct until the first batch
 * containing an edit or a status change. Deciding it here, once, in a tested
 * function, is cheaper than discovering it from a corrupted review doc.
 */
export function inverseReviewOpsBatch(doc: ReviewDoc, ops: readonly ReviewOp[]): ReviewOp[] {
  const perOp: ReviewOp[][] = [];
  let cur = doc;
  for (const op of ops) {
    perOp.push(inverseReviewOps(cur, op));
    cur = applyReviewOp(cur, op);
  }
  return perOp.reverse().flat();
}

/**
 * Whether unlinking is both offerable and safe — ONE rule, used by the control
 * that offers it and the handler that performs it.
 *
 * These were two separately-written conditions and they drifted: the panel
 * asked "does the version I am VIEWING have comments", while the handler acted
 * on "the version whose path is the file that is OPEN". Viewing an older cut
 * while a newer one is loaded made those different versions, so the control
 * either removed a version other than the one "this cut" pointed at, or hit
 * the lib's refusal and silently did nothing.
 *
 * `sourcePath` is the file actually open in the player. Requiring the viewed
 * version to be that file is what makes the word "this" true.
 */
export function canUnlinkVersion(
  doc: ReviewDoc, versionId: string | null, sourcePath: string | null,
): boolean {
  if (!versionId || !sourcePath) return false;
  // A doc must keep at least one version; the last one cannot leave.
  if (doc.versions.length < 2) return false;
  // The BASE of a stack cannot unlink from itself. Linking always folds the
  // newer cut into the older cut's doc, so the doc is KEYED on the base file —
  // remove that version and the review is keyed on a file it no longer
  // contains, and the base re-opens into a stack with no entry for itself.
  // Reachable by opening v1 after stacking v2 onto it, which is ordinary.
  if (doc.sourceKey === sourcePath) return false;
  const v = doc.versions.find((x) => x.id === versionId);
  if (!v || v.path !== sourcePath) return false;
  // Comments carry only a versionId, so removing their version orphans them.
  return doc.comments.every((c) => c.versionId !== versionId);
}

/** Forget that a fingerprint resolves to a review key — the index half of
 *  unlinking a version. A no-op for an unknown fingerprint. */
export function unlinkFingerprint(fp: string): void {
  const idx = loadJson<Record<string, string>>(FP_INDEX_KEY, {});
  if (!(fp in idx)) return;
  delete idx[fp];
  saveJson(FP_INDEX_KEY, idx);
}

/**
 * Unresolved root comments from every OTHER version — the carry-forward list.
 *
 * THE reason the stack is one doc. A notes pass on v2 is exactly "check the
 * new cut against the old notes", so the old notes must be visible and LIVE
 * (resolvable) while v2 plays. Time sort, because the reviewer walks the cut
 * forward; each entry keeps enough version identity for an origin tag.
 */
export function carriedComments(
  doc: ReviewDoc, activeVersionId: string | null,
): { comment: ReviewComment; versionLabel: string }[] {
  if (doc.versions.length < 2) return [];
  const labels = new Map(doc.versions.map((v) => [v.id, v.label]));
  return doc.comments
    .filter((c) => c.versionId !== activeVersionId && c.parentId === null && !c.resolved)
    .filter((c) => labels.has(c.versionId)) // orphaned versionIds stay out
    .sort((a, b) => a.timeStart - b.timeStart || a.createdAt - b.createdAt)
    .map((c) => ({ comment: c, versionLabel: labels.get(c.versionId)! }));
}

/**
 * The title stem used to spot "the same cut, next render".
 *
 * Strips the decorations a render pass adds — version markers (v2, V03,
 * FINAL, final2), copy suffixes ("(2)", "copy"), trailing dates, cut/export
 * words — then collapses separators. "LMH_Reunion_v2_FINAL (1)" and
 * "LMH Reunion v3" both reduce to "lmh reunion", which is the identity a
 * human would give either file.
 */
export function versionStem(title: string): string {
  let s = (title || "").toLowerCase().replace(/\.[^.]+$/, "");
  s = s.replace(/[_\-.]+/g, " ");
  let prev = "";
  while (prev !== s) {
    prev = s;
    s = s
      .replace(/\s*\((\d+)\)\s*$/, " ")               // "(2)"
      .replace(/\s+(v|ver|version)\s*\d+\s*$/i, " ")  // v2, ver 03
      .replace(/\s+(final|fin|approved|locked|master|export|cut|render|copy|new)\s*\d*\s*$/i, " ")
      .replace(/\s+\d{4} \d{2} \d{2}\s*$/, " ")       // 2026 08 03 (separators already spaces)
      .replace(/\s+\d{1,2} \d{1,2} \d{2,4}\s*$/, " ") // 8 3 26
      .trim();
  }
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Review-history entries that look like earlier cuts of `title`.
 *
 * An OFFER, never an auto-link: two genuinely different clips can share a
 * series name, and misfiling a review is worse than asking. Excludes the
 * file's own key (already its own doc) and anything with an empty stem.
 */
export function versionCandidates(
  title: string, ownKey: string | null, history: ReviewHistoryEntry[],
): ReviewHistoryEntry[] {
  const stem = versionStem(title);
  if (!stem) return [];
  return history
    .filter((h) => h.key !== ownKey)
    .filter((h) => versionStem(h.title) === stem)
    .sort((a, b) => b.updatedAt - a.updatedAt);
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




/**
 * Rewrite the identity fields of a REMOTE review op to the name the host
 * attributes to its sender.
 *
 * Why this exists: a ReviewOp names its own author in the payload
 * (`comment.author`, `like.name`, `status.reviewer`), and the relay treats
 * the payload as opaque. So before the host began stamping the sending
 * connection's member id, any peer could post, edit or delete review content
 * — or stamp the source-level verdict — signed as somebody else. The wire id
 * is the only trustworthy identity in the room, so the receiver overwrites
 * what the payload claims with the name that id resolves to.
 *
 * `senderName` empty (an older peer that sends no `from`) leaves the op
 * untouched: unattributed is not the same as forged, and dropping it would
 * silently lose that person's notes.
 *
 * Ops with no identity field (`edit`, `del`, `resolve`, reply edits/deletes)
 * pass through unchanged — they address an existing comment by id, and who
 * MAY perform them is an authorization question this room does not model
 * (everyone present can edit the shared doc, exactly like a shared document).
 */
export function attributeReviewOp(op: ReviewOp, senderName: string): ReviewOp {
  if (!senderName) return op;
  switch (op.t) {
    case "add":
      return op.comment.author === senderName
        ? op
        : { ...op, comment: { ...op.comment, author: senderName } };
    case "like":
      return op.name === senderName ? op : { ...op, name: senderName };
    case "status":
      return op.reviewer === senderName ? op : { ...op, reviewer: senderName };
    default:
      return op;
  }
}
