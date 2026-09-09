import { describe, expect, it } from "vitest";
import { buildComment, emptyDoc } from "./review";
import { newScreening, openSegment, noteComment } from "./screening";
import { sessionMediaPath, sessionNotes, sessionReview, sessionSourceSummary } from "./saved-session";

const root = { ...buildComment({ versionId: "v1", author: "Guest", timeStart: 12, body: "A note" }), id: "root", sessionId: "guest-local-id" };
const reply = { ...buildComment({ versionId: "v1", author: "Host", timeStart: 12, body: "Reply", parentId: root.id }), id: "reply" };
const other = { ...root, id: "other", body: "Other session" };
const session = noteComment(openSegment(newScreening("host-local-id", "Review", "host"), {
  kind: "file", url: null, fingerprint: "fp", reviewKey: "/cut.mov", title: "Cut", duration: 60,
}, "/cut.mov"), root.id);
const segment = session.segments[0];
const doc = { ...emptyDoc("/cut.mov"), comments: [root, reply, other], fingerprints: ["fp"],
  versions: [{ id: "v1", label: "Cut", path: "/cut.mov", addedAt: 1 }] };

describe("saved session identity", () => {
  it("uses locally recorded IDs to include guest notes and their replies, not other sessions", () => {
    expect(sessionNotes(session, segment, doc).map(c => c.id)).toEqual(["root", "reply"]);
  });
  it("does not resurrect deleted roots or show orphan replies", () => {
    expect(sessionNotes(session, segment, { ...doc, comments: [reply, other] })).toEqual([]);
  });
  it("recovers legacy keys using fingerprint or recorded IDs, never the title", () => {
    expect(sessionReview({ ...segment, localSourceKey: null }, [doc])).toBe(doc);
    expect(sessionReview({ ...segment, localSourceKey: null, fingerprint: null }, [doc])).toBe(doc);
    expect(sessionReview({ ...segment, localSourceKey: null, fingerprint: null, commentIds: [] }, [doc])).toBeNull();
  });
  it("refuses ambiguous document matches", () => {
    expect(sessionReview({ ...segment, localSourceKey: null }, [doc, { ...doc, sourceKey: "/copy.mov" }])).toBeNull();
  });
  it("never treats an NDI review key as a playable file", () => {
    expect(sessionMediaPath(session, { ...segment, kind: "ndi" }, doc)).toBeNull();
  });
  it("resolves the reviewed version instead of the active version", () => {
    expect(sessionMediaPath(session, segment, { ...doc, activeVersionId: "v2", versions: [...doc.versions,
      { id: "v2", path: "/new-cut.mov", label: "V2", addedAt: 2 }] })).toBe("/cut.mov");
  });
  it("does not pick the first source version for an ambiguous segment", () => {
    expect(sessionMediaPath(session, { ...segment, commentIds: [] }, { ...doc, versions: [...doc.versions,
      { id: "v2", path: "/new.mov", label: "V2", addedAt: 2 }] })).toBeNull();
  });
  it("distinguishes known Premiere from other NDI senders", () => {
    expect(sessionSourceSummary({ ...session, segments: [{ ...segment, kind: "ndi", title: "Adobe Premiere Pro" }] }))
      .toEqual({ sourceKinds: ["ndi"], premiere: true });
    expect(sessionSourceSummary({ ...session, segments: [{ ...segment, kind: "ndi", title: "Camera" }] }).premiere).toBe(false);
  });
});
