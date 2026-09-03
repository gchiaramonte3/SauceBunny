import type { ReviewComment } from "./review";
import type { ScreeningDoc } from "./screening";

/**
 * THE LEDGER: which session each note on a source was written in.
 *
 * The question it answers is "we watched this cut three times - show me what
 * was said the first time". Nothing could answer it before, and the reason is
 * worth stating because it is not a bug: every note about a source lands in
 * ONE review doc, and the panel showed that doc whole. So opening a second
 * session over the same clip opened on the first session's notes, with nothing
 * to say they were from another day. The notes were not leaking between
 * sessions; there was simply no such thing as a session, as far as the review
 * panel was concerned.
 *
 * WHAT THIS IS NOT, and each of these was a live option:
 *
 *   · NOT a second copy of the notes, and not a partition of them. A note
 *     lives in exactly one place - the source's own ReviewDoc - because
 *     opening that source SOLO must still show everything ever said about it.
 *     This is a read-only index over notes that already exist, so nothing here
 *     can lose one, and a source with no screening files at all still shows
 *     every note under "All notes".
 *
 *   · NOT a version. A version is a new CUT of the media: it owns its own
 *     approval state, and `carriedComments` deliberately carries unresolved
 *     notes forward across one. Three sessions watching the SAME cut are one
 *     version, and minting a version per session would fork approval and start
 *     carrying notes into a cut that never changed. "Automatic versioning" is
 *     the right instinct pointed at the wrong axis: the thing that changed
 *     between session 1 and session 3 is the ROOM, not the picture.
 *
 * WHY IT READS `segment.commentIds` AND NOT `comment.sessionId`.
 *
 * Both exist, both are already written, and only one of them is right here -
 * the wrong one looks perfect until a second person joins:
 *
 *   · `comment.sessionId` is stamped by the note's AUTHOR, on the author's
 *     machine, with the author's screening id (see stampOpWithSession). Those
 *     ids are deliberately machine-local random UUIDs - ScreeningDoc.id says
 *     so, because nothing needed to correlate two attendees' files. So a note
 *     that arrived from a peer carries an id matching NO screening on this
 *     Mac. A ledger keyed on it would quietly show only the notes you wrote
 *     yourself, which is the one failure a reviewer would never think to
 *     check: the list looks complete.
 *
 *   · `segment.commentIds` is recorded locally for every note this machine
 *     saw, whoever wrote it ("Everyone's notes belong to the screening, not
 *     just ours"). It is the complete local record, and it is what this reads.
 *
 * `sessionId` still earns its place as a FALLBACK: it recovers your own notes
 * from a session whose screening file was never written (one that ended before
 * it was worth keeping). Between the two, a note is attributed if either
 * source knows about it.
 */

export type LedgerSession = {
  /** Screening id, local to this machine. */
  id: string;
  title: string;
  startedAt: number;
  endedAt: number;
  participants: string[];
  /** Root-comment ids from this session that still exist in the doc. */
  commentIds: Set<string>;
};

export type Ledger = {
  /** Newest first: a ledger is read backwards. */
  sessions: LedgerSession[];
  /** Root notes belonging to no session - written alone. */
  soloIds: Set<string>;
};

export const EMPTY_LEDGER: Ledger = { sessions: [], soloIds: new Set() };

/** Every source key a screening watched. Also what the index stores so the
 *  panel can skip screenings that never saw this source without reading them. */
export function screeningSourceKeys(doc: ScreeningDoc): string[] {
  const out: string[] = [];
  for (const s of doc.segments) {
    if (s.localSourceKey && !out.includes(s.localSourceKey)) out.push(s.localSourceKey);
  }
  return out;
}

/**
 * Build the ledger for ONE source.
 *
 * Only ROOT comments are placed: a reply belongs to whatever its parent
 * belongs to, and bucketing replies separately would let a thread appear in
 * two sessions at once. Ids no longer in the doc are dropped, so a deleted
 * note leaves no phantom in a session's count.
 */
export function buildLedger(
  screenings: readonly ScreeningDoc[], sourceKey: string, comments: readonly ReviewComment[],
): Ledger {
  const roots = comments.filter((c) => !c.parentId);
  const rootIds = new Set(roots.map((c) => c.id));
  const claimed = new Set<string>();
  const sessions: LedgerSession[] = [];

  for (const sc of screenings) {
    const watched = sc.segments.some((s) => s.localSourceKey === sourceKey);
    const ids = new Set<string>();
    for (const seg of sc.segments) {
      if (seg.localSourceKey !== sourceKey) continue;
      for (const id of seg.commentIds) if (rootIds.has(id)) ids.add(id);
    }
    // The fallback: our own note, in a session whose record missed it.
    for (const c of roots) if (c.sessionId === sc.id) ids.add(c.id);
    // A session that watched this source and collected nothing still belongs
    // in the ledger. "We watched it and said nothing" is a fact about that
    // session, and hiding it would make the list disagree with what happened.
    if (!watched && ids.size === 0) continue;
    for (const id of ids) claimed.add(id);
    sessions.push({
      id: sc.id,
      title: sc.title,
      startedAt: sc.startedAt,
      endedAt: sc.endedAt,
      participants: sc.participants.map((p) => p.name),
      commentIds: ids,
    });
  }

  sessions.sort((a, b) => b.startedAt - a.startedAt);
  const soloIds = new Set<string>();
  for (const c of roots) if (!claimed.has(c.id)) soloIds.add(c.id);
  return { sessions, soloIds };
}

/** What the panel is looking through. */
export type LedgerLens =
  | { kind: "all" }
  | { kind: "solo" }
  | { kind: "session"; id: string };

export const ALL_NOTES: LedgerLens = { kind: "all" };

/** Does this ROOT comment belong in the current lens? */
export function inLens(lens: LedgerLens, ledger: Ledger, commentId: string): boolean {
  if (lens.kind === "all") return true;
  if (lens.kind === "solo") return ledger.soloIds.has(commentId);
  const s = ledger.sessions.find((x) => x.id === lens.id);
  return !!s && s.commentIds.has(commentId);
}

/** How many notes a lens shows, for the picker's own labels. */
export function lensCount(lens: LedgerLens, ledger: Ledger, totalRoots: number): number {
  if (lens.kind === "all") return totalRoots;
  if (lens.kind === "solo") return ledger.soloIds.size;
  return ledger.sessions.find((x) => x.id === lens.id)?.commentIds.size ?? 0;
}

/** The words on the picker's button. */
export function lensLabel(lens: LedgerLens, ledger: Ledger): string {
  if (lens.kind === "all") return "All notes";
  if (lens.kind === "solo") return "Outside a session";
  return ledger.sessions.find((x) => x.id === lens.id)?.title || "This session";
}

/**
 * A lens that no longer exists must not silently show an empty list. Sessions
 * arrive asynchronously, and a doc can be re-keyed under the panel, so the
 * selected lens can outlive the thing it named.
 */
export function lensStillValid(lens: LedgerLens, ledger: Ledger): boolean {
  if (lens.kind === "all") return true;
  if (lens.kind === "solo") return ledger.soloIds.size > 0;
  return ledger.sessions.some((x) => x.id === lens.id);
}
