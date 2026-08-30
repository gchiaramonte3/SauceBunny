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

/** Who was in the room, and when.
 *
 *  Display names, not identities: member ids (m0, m1) are only meaningful
 *  inside a live session, so persisting them would store something that means
 *  nothing tomorrow. Rows are therefore keyed by NAME, and two people sharing
 *  one merge into a single row spanning both their times. That is a real
 *  limitation and the honest one: the shelf shows names, so two identical rows
 *  would be indistinguishable to a reader anyway.
 *
 *  `leftAt` is 0 while someone is still in the room; closing the screening
 *  stamps whoever is left. This is one machine's OBSERVATION of the roster,
 *  not an attendance record - a guest that never sees a peer never records it.
 */
export type ScreeningParticipant = {
  name: string;
  isHost: boolean;
  joinedAt: number;
  /** 0 = still present. */
  leftAt: number;
};

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
  /** LOCAL to this machine, and deliberately so.
   *
   *  The comment here used to say "minted by the host so every attendee's
   *  record shares one id", which was never true - a guest's join code is
   *  None, so no attendee could have shared it - and the value it described
   *  was the iroh join ticket, carrying the host's node id and socket
   *  addresses into a user-visible folder.
   *
   *  A shared id has to travel on the wire, and nothing today needs one:
   *  screenings are local files that are never exchanged or synced, so
   *  correlating two machines' records buys nothing yet. Until something does
   *  need it, a local random id is honest about being local. */
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

/**
 * End the whole screening: close the running segment AND stamp everyone still
 * in the room. Without the second half every participant of every saved
 * screening reads as never having left.
 */
export function closeScreening(doc: ScreeningDoc, now = Date.now()): ScreeningDoc {
  return closeSegment(noteParticipants(doc, [], now), now);
}

/** Close the open segment, if any. Idempotent.
 *
 *  NOT exported. `closeScreening` is the only way to end a screening from
 *  outside, because ending one also has to stamp everyone still in the room -
 *  and a production caller reaching for the segment half alone is exactly how
 *  every participant of every saved screening came to read as never having
 *  left. screening-record-contract enforces the absence: an exported updater
 *  with no production caller fails it. */
function closeSegment(doc: ScreeningDoc, now = Date.now()): ScreeningDoc {
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

/**
 * The roster changed: admit anyone new, and stamp the leaving time on anyone
 * who is no longer there.
 *
 * WHY THIS EXISTS: `participants` was declared on the type, written into
 * index.json, and rendered by the shelf - and never assigned anywhere in
 * production. Every past screening listed "0 people", and
 * screeningIsWorthKeeping's `participants.length > 1` clause was unreachable,
 * so a session where two people watched nothing was discarded as empty.
 *
 * Returns `doc` UNCHANGED when nothing moved. The caller writes through on
 * every change, and the roster re-broadcasts on each join, so an identity
 * return is what keeps that from becoming a file write per broadcast.
 */
export function noteParticipants(
  doc: ScreeningDoc,
  roster: { name: string; isHost: boolean }[],
  now = Date.now(),
): ScreeningDoc {
  const present = new Set(roster.map((p) => p.name));
  let touched = false;

  const kept = doc.participants.map((p) => {
    if (present.has(p.name)) {
      // Back after a drop. Reconnects are ordinary here - a member id is
      // RECLAIMED on rejoin and its epoch bumps - so reopening the row is
      // closer to the truth than filing a second one. The gap is lost, which
      // is the trade: this record answers "who was in the room", not "how
      // long was each person connected".
      if (p.leftAt === 0) return p;
      touched = true;
      return { ...p, leftAt: 0 };
    }
    if (p.leftAt !== 0) return p;
    touched = true;
    return { ...p, leftAt: now };
  });

  const known = new Set(doc.participants.map((p) => p.name));
  const added: ScreeningParticipant[] = [];
  for (const r of roster) {
    if (known.has(r.name)) continue;
    known.add(r.name); // a duplicate name in one roster is one person here
    added.push({ name: r.name, isHost: r.isHost, joinedAt: now, leftAt: 0 });
    touched = true;
  }

  return touched ? { ...doc, participants: [...kept, ...added] } : doc;
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
