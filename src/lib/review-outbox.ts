import { loadJson, reportStorageProblem } from "./storage";
import type { ReviewOp } from "./review";
import { isReviewEnvelope, isReviewOp, type ReviewEnvelope } from "./review-delivery";

const KEY = "saucebunny.review.outbox";
/** Warning threshold only. Never evict unacknowledged user work. */
export const MAX_PER_REVIEW = 500;
type Entry = ReviewOp | ReviewEnvelope;
type Outbox = Record<string, Entry[]>;

function load(): Outbox {
  const raw = loadJson<unknown>(KEY, {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter(([, q]) => Array.isArray(q)));
}

function save(box: Outbox): void {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const previous: unknown = JSON.parse(raw);
      if (!previous || typeof previous !== "object" || Array.isArray(previous)
        || Object.values(previous).some((q) => !Array.isArray(q))) {
        throw new Error("The existing note queue is unreadable. It has been preserved for recovery.");
      }
    }
    localStorage.setItem(KEY, JSON.stringify(box));
  }
  catch (error) {
    reportStorageProblem(KEY, error);
    throw new Error("The note could not be saved locally. Check available storage; the existing queue and your draft have been preserved.", { cause: error });
  }
}

/** Legacy entries remain readable; the session upgrades them before transmission. */
export function enqueueOp(sourceKey: string, op: ReviewOp): number {
  if (!sourceKey) return 0;
  const box = load();
  box[sourceKey] = [...(box[sourceKey] ?? []), op];
  save(box);
  return box[sourceKey].length;
}

export function enqueueEnvelope(envelope: ReviewEnvelope): number {
  const box = load();
  const queue = box[envelope.reviewKey] ?? [];
  if (!queue.some((e) => isReviewEnvelope(e) && e.opId === envelope.opId)) {
    box[envelope.reviewKey] = [...queue, envelope];
    save(box);
  }
  return pendingCount();
}

export function pendingEnvelopes(sourceKey: string): ReviewEnvelope[] {
  return (load()[sourceKey] ?? []).filter(isReviewEnvelope);
}

export function pendingOps(sourceKey: string | null | undefined): ReviewOp[] {
  if (!sourceKey) return [];
  return (load()[sourceKey] ?? []).flatMap((e) => isReviewEnvelope(e) ? [e.op] : isReviewOp(e) ? [e] : []);
}

export function pendingLegacyOps(sourceKey: string): ReviewOp[] {
  return (load()[sourceKey] ?? []).filter(isReviewOp);
}

export function pendingCount(): number {
  return Object.values(load()).reduce((n, q) => n + q.length, 0);
}

/** Used only to migrate legacy entries AFTER saving their replacement envelope. */
export function clearDelivered(sourceKey: string, delivered: readonly ReviewOp[]): void {
  if (!sourceKey || !delivered.length) return;
  const box = load();
  const gone = new Set(delivered.map((o) => JSON.stringify(o)));
  const left = (box[sourceKey] ?? []).filter((e) => isReviewEnvelope(e) || !gone.has(JSON.stringify(e)));
  if (left.length) box[sourceKey] = left; else delete box[sourceKey];
  save(box);
}

/** Only a host's durable commit/ack may call this; a successful send may not. */
export function acknowledgeEnvelope(sourceKey: string, opId: string): void {
  const box = load();
  const left = (box[sourceKey] ?? []).filter((e) => !isReviewEnvelope(e) || e.opId !== opId);
  if (left.length) box[sourceKey] = left; else delete box[sourceKey];
  save(box);
}

export function discardOutbox(sourceKey: string): void {
  const box = load();
  if (!(sourceKey in box)) return;
  delete box[sourceKey];
  save(box);
}

export function __clearAllOutboxes(): void { save({}); }
