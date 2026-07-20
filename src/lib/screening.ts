/**
 * A SCREENING is the memory of a review session: who was there, and every
 * source the room watched, in order, each with the notes made about it.
 *
 * THE ONE DECISION EVERYTHING FOLLOWS FROM: a screening is an INDEX over
 * per-source review docs. It holds ZERO comment bodies. Comments live in
 * exactly one place - the source's own ReviewDoc - so opening that source
 * solo still shows the notes made during a screening, and there are never
 * two copies to disagree with each other.
 *
 * That also makes this purely additive on disk: `Reviews/` is untouched, and
 * a user who never starts a session never grows a `Screenings/` folder.
 */

import type { SessionSource } from "../hooks/use-co-review";

/** Who was in the room. Display names, not identities: member ids (m0, m1)
 *  are only meaningful inside a live session, so persisting them would store
 *  something that means nothing tomorrow. */
export type ScreeningParticipant = { name: string; isHost: boolean };

/** One source watched during one screening. */
export type ScreeningSegment = {
  id: string;
  /** Portable content identity, straight off the wire. This is what would let
   *  a DIFFERENT machine recognise the same source. */
  kind: "web" | "file";
  url: string | null;
  fingerprint: string | null;
  /** THIS machine's review-doc key, so `loadReview(localSourceKey)` opens the
   *  notes. Null when we never managed to resolve the source locally. */
  localSourceKey: string | null;
  title: string;
  duration: number | null;
  startedAt: number;
  endedAt: number;
  /** Root-comment ids created during THIS segment, in creation order. Ids
   *  only: the bodies live in the ReviewDoc. */
  commentIds: string[];
  /** False when this machine never got the source open. The segment still
   *  lists, so the record of what the room watched stays complete. */
  watched: boolean;
};

export type ScreeningDoc = {
  /** Minted by the host so every attendee's record shares one id. */
  id: string;
  title: string;
  startedAt: number;
  endedAt: number;
  role: "host" | "guest";
  participants: ScreeningParticipant[];
  segments: ScreeningSegment[];
};

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `s_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
  }
}

export function newScreening(
  id: string, title: string, role: "host" | "guest", now = Date.now(),
): ScreeningDoc {
  return { id, title, startedAt: now, endedAt: now, role, participants: [], segments: [] };
}

/** The segment currently being watched, if any. */
export function openSegmentOf(doc: ScreeningDoc): ScreeningSegment | null {
  const last = doc.segments[doc.segments.length - 1];
  return last && last.endedAt === 0 ? last : null;
}

/**
 * The room moved to a new source. Closes whatever was open (so its comment
 * list is final) and starts a new segment. Loading the SAME source again is a
 * no-op rather than a duplicate segment.
 */
export function openSegment(
  doc: ScreeningDoc,
  src: SessionSource,
  localSourceKey: string | null,
  now = Date.now(),
): ScreeningDoc {
  if (src.kind === "none") return closeSegment(doc, now);
  const open = openSegmentOf(doc);
  const sameSource = open
    && open.kind === src.kind
    && open.url === src.url
    && open.fingerprint === src.fingerprint;
  if (sameSource) return doc;

  const closed = closeSegment(doc, now);
  const segment: ScreeningSegment = {
    id: newId(),
    kind: src.kind,
    url: src.url,
    fingerprint: src.fingerprint,
    localSourceKey,
    title: src.title ?? "Untitled",
    duration: src.duration,
    startedAt: now,
    endedAt: 0, // 0 = still open
    commentIds: [],
    watched: localSourceKey != null,
  };
  return { ...closed, endedAt: now, segments: [...closed.segments, segment] };
}

/** Close the open segment, if any. Idempotent. */
export function closeSegment(doc: ScreeningDoc, now = Date.now()): ScreeningDoc {
  const open = openSegmentOf(doc);
  if (!open) return doc;
  const segments = doc.segments.slice(0, -1).concat({ ...open, endedAt: now });
  return { ...doc, segments, endedAt: now };
}

/** Record that a comment was made during the open segment. Ignores duplicates
 *  so a replayed op can't inflate the count. */
export function noteComment(doc: ScreeningDoc, commentId: string): ScreeningDoc {
  const open = openSegmentOf(doc);
  if (!open || open.commentIds.includes(commentId)) return doc;
  const segments = doc.segments.slice(0, -1)
    .concat({ ...open, commentIds: [...open.commentIds, commentId] });
  return { ...doc, segments };
}

/** A comment was deleted: drop it from whichever segment claimed it, so the
 *  count never outruns what the review doc actually holds. */
export function unnoteComment(doc: ScreeningDoc, commentId: string): ScreeningDoc {
  let touched = false;
  const segments = doc.segments.map((s) => {
    if (!s.commentIds.includes(commentId)) return s;
    touched = true;
    return { ...s, commentIds: s.commentIds.filter((id) => id !== commentId) };
  });
  return touched ? { ...doc, segments } : doc;
}

/** Mark the open segment as actually watched (the source resolved locally). */
export function markWatched(doc: ScreeningDoc, localSourceKey: string): ScreeningDoc {
  const open = openSegmentOf(doc);
  if (!open || open.watched) return doc;
  const segments = doc.segments.slice(0, -1)
    .concat({ ...open, watched: true, localSourceKey });
  return { ...doc, segments };
}

/**
 * Is this worth keeping? "Started a session and ended it having watched
 * nothing, alone" should not litter the library. Anything with a real source
 * or a second person is a memory worth having.
 */
export function screeningIsWorthKeeping(doc: ScreeningDoc): boolean {
  const hasSource = doc.segments.some((s) => s.localSourceKey || s.fingerprint || s.url);
  return hasSource || doc.participants.length > 1;
}

/** Total comments across every segment - the number a library card shows. */
export function screeningCommentCount(doc: ScreeningDoc): number {
  return doc.segments.reduce((n, s) => n + s.commentIds.length, 0);
}
