/**
 * Local-first video review model — a self-hosted "Frame.io" for Sauce Bunny.
 *
 * This is a native re-implementation of the portable core of FreeFrame's review
 * domain (MIT) adapted to Sauce Bunny's constraints: no server, no DB, no auth —
 * everything persists to localStorage, keyed per source. The shape mirrors
 * FreeFrame (timecode_start/end seconds, threaded comments via parentId,
 * per-version approval) so the UX maps 1:1, minus the multi-user/cloud pieces
 * (share tokens, guests, notifications, RBAC) which a local app can't do.
 *
 * Pure ops return a NEW ReviewDoc (never mutate) so React state updates are
 * clean and the logic is unit-testable; persistence is a thin localStorage wrap.
 */

import { loadJson, saveJson } from "./storage";
import { secondsToHms, secondsToTc } from "./timecode";

export type ReviewStatusState = "pending" | "approved" | "changes";

/** A free-hand drawing captured on a frame, stored with a comment. Points are
 *  normalized 0..1 against the canvas it was drawn on so it scales to any size. */
export type AnnotationStrokes = {
  strokes: { color: string; size: number; pts: [number, number][] }[];
};

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
};

export type ReviewVersion = {
  id: string;
  label: string;   // "V1", "V2", or a filename
  path: string;    // local file path or source URL
  addedAt: number;
};

export type ReviewStatus = { state: ReviewStatusState; note: string; updatedAt: number };

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
const KEY_PREFIX = "saucebunny.review.";
const reviewKey = (sourceKey: string) => KEY_PREFIX + sourceKey;

export function emptyDoc(sourceKey: string): ReviewDoc {
  return { sourceKey, versions: [], activeVersionId: null, comments: [], status: {} };
}

export function loadReview(sourceKey: string): ReviewDoc {
  return loadJson<ReviewDoc>(reviewKey(sourceKey), emptyDoc(sourceKey));
}

/** Fired after any review mutation so other views (e.g. the timeline markers)
 *  can re-read. Mirrors the speaker-overrides change event. */
export const REVIEW_CHANGED_EVENT = "saucebunny:review-changed";

export function saveReview(doc: ReviewDoc): void {
  saveJson(reviewKey(doc.sourceKey), doc);
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

export function addComment(doc: ReviewDoc, c: NewComment, now = Date.now()): ReviewDoc {
  const comment: ReviewComment = {
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

export function toggleResolved(doc: ReviewDoc, id: string, now = Date.now()): ReviewDoc {
  return {
    ...doc,
    comments: doc.comments.map((c) =>
      c.id === id ? { ...c, resolved: !c.resolved, updatedAt: now } : c),
  };
}

// ── approval status ──────────────────────────────────────────────────────────

export function setStatus(
  doc: ReviewDoc, versionId: string, state: ReviewStatusState, note = "", now = Date.now(),
): ReviewDoc {
  return { ...doc, status: { ...doc.status, [versionId]: { state, note, updatedAt: now } } };
}

export function statusOf(doc: ReviewDoc, versionId: string | null): ReviewStatus {
  return (versionId && doc.status[versionId]) || { state: "pending", note: "", updatedAt: 0 };
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
): { id: string; time: number; resolved: boolean; author: string }[] {
  return doc.comments
    .filter((c) => c.versionId === versionId && c.parentId === null)
    .map((c) => ({ id: c.id, time: c.timeStart, resolved: c.resolved, author: c.author }));
}

// ── reviewer identity (name + avatar colour) ─────────────────────────────────
// Shared so both the Review panel and the timeline markers resolve the same
// colour/initials for a given author. Single local reviewer for now; the
// per-author fallback colour means future multi-reviewer "just works".

export const AUTHOR_KEY = "saucebunny.review.author";
export const AUTHOR_COLOR_KEY = "saucebunny.review.authorColor";

/** Palette for avatar colours + the name-modal colour picker. */
export const AVATAR_COLORS = ["#f5a623", "#7b61ff", "#2dd4bf", "#ff6b6b", "#4dabf7", "#e879f9", "#34d399", "#fb7185"];

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

/** The current local reviewer (name + chosen colour) from localStorage. */
export function loadReviewer(): { name: string; color: string } {
  const name = loadJson<string>(AUTHOR_KEY, "");
  return { name, color: loadJson<string>(AUTHOR_COLOR_KEY, avatarColor(name || "You")) };
}

/** Resolve an author's avatar colour: the current reviewer's chosen colour for
 *  their own notes, else a stable per-name hue. */
export function reviewerColorFor(author: string, me: { name: string; color: string }): string {
  return author && author === me.name ? me.color : avatarColor(author);
}

export function openCount(doc: ReviewDoc, versionId: string | null): number {
  return doc.comments.filter((c) => c.versionId === versionId && c.parentId === null && !c.resolved).length;
}

/** Saved drawings for a version (time + strokes) — drives the on-frame
 *  proximity fade: the overlay shows a drawing as the playhead nears its time. */
export function annotationsOf(
  doc: ReviewDoc, versionId: string | null,
): { id: string; time: number; strokes: AnnotationStrokes }[] {
  return doc.comments
    .filter((c) => c.versionId === versionId && c.parentId === null && c.annotation && c.annotation.strokes.length > 0)
    .map((c) => ({ id: c.id, time: c.timeStart, strokes: c.annotation as AnnotationStrokes }));
}

// ── export (the local stand-in for Frame.io's share link) ────────────────────
// A local app can't host a public review URL, so instead we export the review to
// portable artifacts: human-readable notes (Markdown), a marker spreadsheet
// (CSV), and an NLE marker list (CMX3600 EDL — Resolve/Premiere import markers).

const STATUS_LABEL: Record<ReviewStatusState, string> = {
  pending: "Pending", approved: "Approved", changes: "Changes requested",
};

/** Human-readable review notes for the active version. */
export function reviewToMarkdown(doc: ReviewDoc, title = "Review"): string {
  const v = doc.versions.find((x) => x.id === doc.activeVersionId);
  const roots = rootComments(doc, doc.activeVersionId, "time");
  const st = statusOf(doc, doc.activeVersionId);
  const out: string[] = [
    `# Review — ${title}`,
    "",
    `**Status:** ${STATUS_LABEL[st.state]}${st.note ? ` — ${st.note}` : ""}`,
    v ? `**Version:** ${v.label}` : "",
    `**Comments:** ${roots.length}`,
    "",
  ];
  for (const c of roots) {
    out.push(`- **[${secondsToHms(c.timeStart)}]** ${c.body} — ${c.author}${c.resolved ? "  _(resolved)_" : ""}`);
    for (const r of repliesOf(doc, c.id)) out.push(`  - ↳ ${r.body} — ${r.author}`);
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
    rows.push([secondsToTc(c.timeStart, fps), c.resolved ? "yes" : "no", csvCell(c.author), csvCell(c.body)].join(","));
  }
  return rows.join("\n") + "\n";
}

/** CMX3600 EDL whose events carry the comments as timeline markers (Resolve/Premiere). */
export function reviewToEdl(doc: ReviewDoc, fps: number, title = "Sauce Bunny Review"): string {
  const lines = [`TITLE: ${title}`, "FCM: NON-DROP FRAME", ""];
  let n = 1;
  for (const c of rootComments(doc, doc.activeVersionId, "time")) {
    const inTc = secondsToTc(c.timeStart, fps);
    const outTc = secondsToTc(c.timeStart + 1 / Math.max(1, Math.round(fps)), fps);
    const ev = String(n++).padStart(3, "0");
    const color = c.resolved ? "ResolveColorGreen" : "ResolveColorRed";
    const note = c.body.replace(/[\r\n]+/g, " ");
    lines.push(`${ev}  AX       V     C        ${inTc} ${outTc} ${inTc} ${outTc}`);
    lines.push(` |C:${color} |M:${note} |D:1`);
  }
  return lines.join("\n") + "\n";
}
