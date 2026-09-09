import type { ReviewComment, ReviewDoc } from "./review";
import type { ScreeningDoc, ScreeningSegment } from "./screening";

/** An archive is a reader over Reviews, never a second owner of note bodies. */
export function sessionNotes(session: ScreeningDoc, segment: ScreeningSegment, doc: ReviewDoc): ReviewComment[] {
  const ids = new Set(segment.commentIds);
  const roots = doc.comments.filter(c => !c.parentId && (ids.has(c.id)
    || (c.sessionId === session.id && c.segmentId === segment.id)));
  const rootIds = new Set(roots.map(c => c.id));
  return doc.comments.filter(c => rootIds.has(c.id) || (c.parentId && rootIds.has(c.parentId)));
}

/** Legacy sessions can lack a local key. Recover by identity, never by title. */
export function sessionReview(segment: ScreeningSegment, docs: readonly ReviewDoc[]): ReviewDoc | null {
  const direct = docs.find(d => d.sourceKey === segment.localSourceKey);
  if (direct) return direct;
  const ids = new Set(segment.commentIds);
  const matches = docs.filter(d => (segment.url && (d.sourceKey === segment.url
    || d.versions.some(v => v.path === segment.url)))
    || (segment.fingerprint && d.fingerprints?.includes(segment.fingerprint))
    || d.comments.some(c => ids.has(c.id)));
  return matches.length === 1 ? matches[0] : null;
}

/** A review key is not necessarily a playable path (NDI and version stacks). */
export function sessionMediaPath(session: ScreeningDoc, segment: ScreeningSegment, doc: ReviewDoc | null): string | null {
  if (segment.kind === "ndi") return null;
  if (segment.kind === "web") return /^https?:\/\//i.test(segment.url ?? "") ? segment.url : null;
  if (!doc) return segment.localSourceKey?.startsWith("/") ? segment.localSourceKey : null;
  const versionIds = new Set(sessionNotes(session, segment, doc).map(c => c.versionId));
  const versions = doc.versions.filter(v => versionIds.has(v.id));
  const path = versions.length === 1 ? versions[0].path
    : doc.versions.length === 1 ? doc.versions[0].path
    : doc.versions.length === 0 ? segment.localSourceKey : null;
  return path?.startsWith("/") ? path : null;
}

export function sessionSourceSummary(doc: ScreeningDoc) {
  return {
    sourceKinds: [...new Set(doc.segments.map(s => s.kind))],
    premiere: doc.segments.some(s => s.kind === "ndi" && /\bpremiere\b/i.test(s.title)),
  };
}
