import { describe, expect, it, vi } from "vitest";
import { applyCommit, createReviewDelivery, createReviewEnvelope, isReviewEnvelope, type ReviewEnvelope, type ReviewAck } from "./review-delivery";
import { buildComment, emptyDoc, type ReviewDoc } from "./review";

function fixture() {
  let doc: ReviewDoc = { ...emptyDoc("local-A"), versions: [{ id: "v", path: "", label: "V1", addedAt: 0 }], activeVersionId: "v" };
  const op = { t: "add" as const, comment: buildComment({ versionId: "v", timeStart: 1, body: "Note", author: "Claimed" }) };
  const envelope = createReviewEnvelope(doc, op, "wire-A", "session");
  const send = vi.fn(async (_message: ReviewEnvelope | ReviewAck) => {});
  const save = vi.fn(async (next: ReviewDoc) => { doc = next; });
  const delivery = createReviewDelivery({ load: (key) => key === "wire-A" ? doc : null, save, send, publish: vi.fn() });
  return { delivery, save, send, envelope, doc: () => doc };
}

describe("durable review delivery", () => {
  it("does not acknowledge a failed disk write; a retry commits exactly once", async () => {
    const f = fixture();
    f.save.mockRejectedValueOnce(new Error("disk full"));
    await expect(f.delivery.commit(f.envelope, "Actual peer")).rejects.toThrow("disk full");
    expect(f.send).not.toHaveBeenCalled();
    await f.delivery.commit(f.envelope, "Actual peer");
    await f.delivery.commit(f.envelope, "Actual peer");
    expect(f.doc().comments).toHaveLength(1);
    expect(f.doc().comments[0].author).toBe("Actual peer");
    expect(f.doc().sync?.revision).toBe(1);
    expect(f.send.mock.calls.at(-1)?.[0]).toMatchObject({ t: "review-commit", revision: 1 });
  });

  it("waits for storage before publishing a commit", async () => {
    const f = fixture();
    let finish!: () => void;
    f.save.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const task = f.delivery.commit(f.envelope, "Peer");
    await Promise.resolve();
    expect(f.send).not.toHaveBeenCalled();
    finish();
    await task;
    expect(f.send).toHaveBeenCalledOnce();
  });

  it("rejects a wrong review or version without acknowledging", async () => {
    const f = fixture();
    await expect(f.delivery.commit({ ...f.envelope, reviewKey: "wire-B" }, "Peer")).rejects.toThrow();
    await expect(f.delivery.commit({ ...f.envelope, versionId: "other" }, "Peer")).rejects.toThrow();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("uses monotonically ordered revisions for concurrent posts", async () => {
    const f = fixture();
    const second = { ...f.envelope, opId: "second", op: { t: "add" as const,
      comment: buildComment({ versionId: "v", timeStart: 2, body: "Other", author: "Claimed" }),
    } };
    await Promise.all([f.delivery.commit(f.envelope, "One"), f.delivery.commit(second, "Two")]);
    expect(f.doc().sync?.revision).toBe(2);
    expect(f.doc().comments).toHaveLength(2);
    const commit = f.send.mock.calls[0][0];
    if (!isReviewEnvelope(commit)) throw new Error("Expected commit");
    expect(applyCommit(f.doc(), commit)).toBe(f.doc());
  });

  it("does not trust a sender-assigned comment revision", async () => {
    const f = fixture();
    if (f.envelope.op.t !== "add") throw Error("fixture");
    await f.delivery.commit({ ...f.envelope, op: { t: "add", comment: { ...f.envelope.op.comment, revision: 999_999 } } }, "Peer");
    expect(f.doc().comments[0].revision).toBe(1);
    const edit = createReviewEnvelope(f.doc(), { t: "edit", id: f.doc().comments[0].id, body: "Corrected", at: 1 }, "wire-A", "session");
    await f.delivery.commit(edit, "Peer");
    expect(f.doc().comments[0]).toMatchObject({ body: "Corrected", revision: 2 });
  });

  it("replays the exact canonical commit after storage succeeded but broadcast failed", async () => {
    const f = fixture();
    f.send.mockRejectedValueOnce(Error("Disconnected"));
    await expect(f.delivery.commit(f.envelope, "Peer")).rejects.toThrow("Disconnected");
    const first = f.send.mock.calls[0][0];
    await f.delivery.commit(f.envelope, "Peer");
    expect(f.send.mock.calls[1][0]).toEqual(first);
    expect(f.doc().sync?.revision).toBe(1);
  });
});
