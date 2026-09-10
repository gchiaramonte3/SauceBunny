import { applyReviewOp, attributeReviewOp, type ReviewDoc, type ReviewOp } from "./review";
import { copyPremiereAnchor, isPremiereAnchor, isPremiereRoomScope, type PremiereRoomScope } from "./premiere-notes";

export type ReviewEnvelope = {
  t: "review-submit" | "review-commit";
  protocol: 1;
  opId: string;
  reviewKey: string;
  versionId: string;
  sessionId: string;
  revision: number;
  clock: number;
  op: ReviewOp;
  premiereContext?: PremiereRoomScope;
};
export type ReviewAck = {
  t: "review-ack"; protocol: 1; opId: string; reviewKey: string; sessionId: string; revision: number;
};

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 4096;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Validate the opaque JSON at its trust boundary, before applying any domain op. */
export function isReviewOp(value: unknown): value is ReviewOp {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  switch (v.t) {
    case "add": {
      const c = v.comment as Record<string, unknown> | null;
      const timing = c?.timing as Record<string, unknown> | undefined;
      if (c?.premiere !== undefined && (!isPremiereAnchor(c.premiere) || !timing
        || c.premiere.sourceId !== timing.sourceId || c.parentId !== null)) return false;
      if (timing !== undefined && (!timing || !["general", "manual"].includes(String(timing.kind))
        || !str(timing.sourceId) || typeof timing.pass !== "string" || !timing.pass.trim() || timing.pass.length > 120
        || (timing.kind === "manual" && (typeof timing.timecode !== "string"
          || !/^\d{2}:[0-5]\d:[0-5]\d[:;][0-5]\d$/.test(timing.timecode))))) return false;
      return !!c && str(c.id) && str(c.versionId) && (c.parentId === null || str(c.parentId))
        && num(c.timeStart) && (c.timeEnd === null || num(c.timeEnd))
        && typeof c.body === "string" && typeof c.author === "string"
        && num(c.createdAt) && num(c.updatedAt) && typeof c.resolved === "boolean"
        && (c.annotation === null || (typeof c.annotation === "object"
          && Array.isArray((c.annotation as { strokes?: unknown }).strokes)));
    }
    case "del": return str(v.id) && (v.at === undefined || num(v.at));
    case "edit": return str(v.id) && typeof v.body === "string" && num(v.at);
    case "resolve": return str(v.id) && typeof v.resolved === "boolean" && num(v.at);
    case "like": return str(v.id) && typeof v.name === "string" && typeof v.liked === "boolean"
      && (v.at === undefined || num(v.at)) && (v.emoji === undefined || typeof v.emoji === "string");
    case "editReply": return str(v.versionId) && str(v.commentId) && str(v.replyId)
      && typeof v.body === "string" && num(v.at);
    case "delReply": return str(v.versionId) && str(v.commentId) && str(v.replyId)
      && (v.at === undefined || num(v.at));
    case "status": return str(v.versionId) && ["pending", "approved", "changes"].includes(String(v.state))
      && typeof v.reviewer === "string" && num(v.at);
    default: return false;
  }
}

export function isReviewEnvelope(value: unknown): value is ReviewEnvelope {
  if (!value || typeof value !== "object") return false;
  const v = value as ReviewEnvelope;
  return (v.t === "review-submit" || v.t === "review-commit") && v.protocol === 1
    && str(v.opId) && str(v.reviewKey) && str(v.versionId) && str(v.sessionId)
    && Number.isSafeInteger(v.revision) && v.revision >= 0 && num(v.clock) && isReviewOp(v.op)
    && (v.premiereContext === undefined || isPremiereRoomScope(v.premiereContext));
}

/** Whitelist extension data on submissions, commits and compatibility copies. */
export function sanitizeReviewOpForWire(op: ReviewOp): ReviewOp {
  if (op.t !== "add" || !op.comment.premiere) return op;
  return { ...op, comment: { ...op.comment, premiere: copyPremiereAnchor(op.comment.premiere) } };
}

export function isReviewAck(value: unknown): value is ReviewAck {
  if (!value || typeof value !== "object") return false;
  const v = value as ReviewAck;
  return v.t === "review-ack" && v.protocol === 1 && str(v.opId) && str(v.reviewKey)
    && str(v.sessionId) && Number.isSafeInteger(v.revision) && v.revision > 0;
}

export function opVersion(doc: ReviewDoc, op: ReviewOp): string | null {
  if (op.t === "add") return op.comment.versionId;
  if ("versionId" in op) return op.versionId;
  return doc.comments.find((c) => c.id === op.id)?.versionId ?? doc.activeVersionId;
}

export function createReviewEnvelope(doc: ReviewDoc, op: ReviewOp, reviewKey: string, sessionId: string): ReviewEnvelope {
  const versionId = opVersion(doc, op);
  if (!versionId || !reviewKey || !sessionId) throw new Error("Wait for the shared review to finish opening before posting a note.");
  return { t: "review-submit", protocol: 1, opId: crypto.randomUUID(), reviewKey, sessionId,
    versionId, revision: 0, clock: 0, op };
}

/** Stamp mutations on the host's logical clock, not the sender's wall clock. */
export function prepareCommit(doc: ReviewDoc, envelope: ReviewEnvelope, author: string): ReviewEnvelope {
  const targetId = "id" in envelope.op ? envelope.op.id : null;
  const knownTarget = !targetId || doc.comments.some((c) => c.id === targetId);
  if (!doc.versions.some((v) => v.id === envelope.versionId)
    || (knownTarget && opVersion(doc, envelope.op) !== envelope.versionId)) throw new Error("This note belongs to a different cut.");
  const clock = doc.comments.reduce((at, c) => Math.max(at, c.updatedAt + 1),
    Math.max(Date.now(), (doc.sync?.clock ?? 0) + 1));
  let op = attributeReviewOp(envelope.op, author);
  if (op.t === "add") op = { ...op, comment: { ...op.comment,
    // A sender cannot make its note immune to future edits by supplying a
    // revision higher than the host's. Only the host assigns this coordinate.
    revision: (doc.sync?.revision ?? 0) + 1,
    sessionId: envelope.sessionId,
    updatedAt: clock, ...(op.comment.restoredAt ? { restoredAt: clock } : {}),
  } };
  else op = { ...op, at: clock };
  return { ...envelope, t: "review-commit", revision: (doc.sync?.revision ?? 0) + 1, clock, op };
}

/** A host revision outranks optimistic timestamps; retries never apply twice. */
export function applyCommit(doc: ReviewDoc, commit: ReviewEnvelope): ReviewDoc {
  if (doc.sync?.operations[commit.opId]) return doc;
  const op = commit.op;
  const id = op.t === "add" ? op.comment.id : "id" in op ? op.id : "replyId" in op ? op.replyId : null;
  const current = doc.comments.find((c) => c.id === id);
  let base = doc;
  if (current && (current.revision ?? 0) < commit.revision) {
    base = { ...doc, comments: doc.comments.map((c) => c.id === id ? { ...c, updatedAt: 0 } : c) };
    if (op.t === "add") base = { ...base, comments: base.comments.filter((c) => c.id !== id) };
  }
  const next = current && (current.revision ?? 0) >= commit.revision ? doc : applyReviewOp(base, op);
  return { ...next,
    comments: next.comments.map((c) => c.id === id && (c.revision ?? 0) < commit.revision ? { ...c, revision: commit.revision } : c),
    sync: { sessionId: commit.sessionId, revision: Math.max(doc.sync?.revision ?? 0, commit.revision),
      clock: Math.max(doc.sync?.clock ?? 0, commit.clock),
      operations: { ...doc.sync?.operations, [commit.opId]: commit.revision },
    },
  };
}

export type DeliveryDeps = {
  load: (reviewKey: string) => ReviewDoc | null;
  save: (doc: ReviewDoc) => Promise<void>;
  publish: (doc: ReviewDoc) => void;
  send: (message: ReviewEnvelope | ReviewAck) => Promise<unknown>;
  /** Runs inside the serial commit, before persistence; may reject stale intent. */
  authorize?: (envelope: ReviewEnvelope) => ReviewEnvelope;
};

/** Serial host commits. No acknowledgement is emitted before both durable writes finish. */
export function createReviewDelivery(deps: DeliveryDeps) {
  let tail = Promise.resolve();
  return {
    commit(envelope: ReviewEnvelope, author: string): Promise<void> {
      const task = tail.then(async () => {
        const doc = deps.load(envelope.reviewKey);
        if (!doc) throw new Error("The host has not opened this review. Your note remains queued.");
        const revision = doc.sync?.operations[envelope.opId];
        if (revision) {
          await deps.save(doc);
          deps.publish(doc);
          const recorded = doc.sync?.commits?.[envelope.opId];
          if (recorded) await deps.send({ ...envelope, ...recorded, t: "review-commit" });
          else await deps.send({ t: "review-ack", protocol: 1, opId: envelope.opId,
            reviewKey: envelope.reviewKey, sessionId: envelope.sessionId, revision });
          return;
        }
        const commit = prepareCommit(doc, deps.authorize?.(envelope) ?? envelope, author);
        const next = applyCommit(doc, commit);
        next.sync = { ...next.sync!, commits: { ...doc.sync?.commits,
          [commit.opId]: { op: commit.op, revision: commit.revision, clock: commit.clock, versionId: commit.versionId },
        } };
        await deps.save(next);
        deps.publish(next);
        await deps.send(commit);
      });
      tail = task.catch(() => {});
      return task;
    },
  };
}
