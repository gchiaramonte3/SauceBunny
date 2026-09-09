import { useMemo, useSyncExternalStore } from "react";
import type { ScreeningDoc, ScreeningSegment } from "../lib/screening";
import { allReviewDocs, getReviewDoc, subscribeReviewDoc } from "../lib/review-store";
import { annotationHasContent } from "../lib/review";
import { sessionMediaPath, sessionNotes, sessionReview } from "../lib/saved-session";
import { noteTimingLabel } from "../lib/live-review";
import { secondsToHms } from "../lib/timecode";

export function SavedSessionNotes({ session, segment, onOpenMedia }: {
  session: ScreeningDoc;
  segment: ScreeningSegment;
  onOpenMedia: (path: string) => void;
}) {
  const key = useMemo(() => sessionReview(segment, [...allReviewDocs()])?.sourceKey, [segment]);
  const subscribe = useMemo(() => (cb: () => void) => key ? subscribeReviewDoc(key, cb) : () => {}, [key]);
  const doc = useSyncExternalStore(subscribe, () => key ? getReviewDoc(key) : undefined);
  const notes = useMemo(() => doc ? sessionNotes(session, segment, doc) : [], [doc, session, segment]);
  const roots = notes.filter(c => !c.parentId);
  const replies = new Map<string, typeof notes>();
  for (const c of notes) if (c.parentId) {
    const thread = replies.get(c.parentId) ?? [];
    thread.push(c);
    replies.set(c.parentId, thread);
  }
  const mediaPath = sessionMediaPath(session, segment, doc ?? null);
  const live = segment.kind === "ndi";
  const premiere = live && (/\bpremiere\b/i.test(segment.title) || notes.some(c => c.premiere));
  const label = premiere ? "Premiere Pro" : live ? "NDI" : "Source video";
  return <div className="cp-session-reader-body">
    <section className="cp-session-source" aria-label="Session source">
      <span className="cp-session-source-badge">{label}</span>
      <h3>{segment.title}</h3>
      <p>{live
        ? `This was a ${label} live session. The live feed is not a saved source video. Read the saved notes on the right; Premiere is not required to read them.`
        : "Saved session notes are on the right. Open the source separately in Clip to view available media."}</p>
      {live && <p>Manual timecodes are unverified. A saved note does not mean a marker was added to Premiere.</p>}
      {!live && mediaPath && <button type="button" className="btn" onClick={() => onOpenMedia(mediaPath)}>Open source in Clip</button>}
      {!live && !mediaPath && <p>No unambiguous source path is recorded. Notes remain available independently of the video.</p>}
    </section>
    <section className="cp-session-notes" aria-label="Saved session notes">
      <h3>Notes <span>({roots.length})</span></h3>
      {!doc && <p role="status">{segment.commentIds.length
        ? "The session references notes, but their review document is unavailable on this Mac. The saved session has not been changed."
        : "No saved review document is linked to this source."}</p>}
      {doc && roots.length === 0 && <p>No remaining notes from this session for this source.</p>}
      {roots.map(c => <article key={c.id} className="cp-session-note">
        <header><strong>{c.author || "Reviewer"}</strong><span>{c.resolved ? "Resolved" : "Open"}</span></header>
        <p className="cp-session-note-time">{noteTimingLabel(c, live ? "Timeline position not recorded"
          : `${secondsToHms(c.timeStart)}${c.timeEnd !== null ? ` to ${secondsToHms(c.timeEnd)}` : ""}`)}{c.timing?.kind === "manual" ? " · Unverified" : ""}</p>
        <p className="cp-session-note-text">{c.body}</p>
        {annotationHasContent(c.annotation) && <details><summary>Saved annotation (source frame unavailable)</summary>
          <p>{c.annotation?.strokes.length ?? 0} drawing strokes saved.</p>
          {c.annotation?.labels?.map((label, i) => <p key={i}>{label.text}</p>)}
        </details>}
        {(replies.get(c.id) ?? []).map(reply => <div className="cp-session-reply" key={reply.id}>
          <strong>{reply.author || "Reviewer"}</strong><p className="cp-session-note-text">{reply.body}</p>
        </div>)}
      </article>)}
    </section>
  </div>;
}
