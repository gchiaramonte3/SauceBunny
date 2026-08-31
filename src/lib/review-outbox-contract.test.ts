import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A note that could not be sent is kept, and delivered on the next snapshot.
 *
 * Three separate paths lost one before this, and all three looked the same to
 * the author: the note appeared on their screen and never arrived. This holds
 * the wiring for each, because the store being correct is not the same as the
 * store being called - a lesson this session has learned twice.
 */

const ROOT = join(__dirname, "../..");
const HOOK = readFileSync(join(ROOT, "src/hooks/use-co-review.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("the outbox is wired", () => {
  it("the hook is readable and still has the pieces", () => {
    // The canary. Every check below is "this file contains X".
    expect(HOOK.length).toBeGreaterThan(2000);
    expect(HOOK).toContain("postSessionOp");
    expect(HOOK).toContain("adoptSnapshot");
  });

  it("a review op's send can fail, rather than being swallowed", () => {
    // sendSessionMsg is deliberately fire-and-forget for presence and
    // transport, which are re-sent constantly. Review content is not: that op
    // was applied to the author's screen, and a swallowed rejection means it
    // reached nobody and nobody was told.
    expect(HOOK, "no failable send exists").toContain("trySendSessionMsg");
    const post = HOOK.slice(HOOK.indexOf("const postSessionOp"), HOOK.indexOf("const postSessionOp") + 1400);
    expect(post, "postSessionOp still uses the swallowing send").toContain("trySendSessionMsg");
    expect(post, "a failed send does not queue the note").toContain("enqueueOp(");
  });

  it("the queue survives, on disk", () => {
    expect(HOOK, "nothing persists the queue").toContain("review-outbox");
  });

  it("EVERY adoption drains it, not only the first", () => {
    // The in-memory replay above it is gated on `prev` being null, which is
    // right for that queue and wrong for this one: a reconnect inside a live
    // session is the common case and would deliver nothing.
    const i = HOOK.indexOf("adoptSnapshot(cur, incoming");
    expect(i, "the adoption call moved; this check needs rewriting").toBeGreaterThan(-1);
    const around = HOOK.slice(i - 900, i + 300);
    expect(around, "the drain is not at the adoption site").toContain("pendingOps(incoming.sourceKey)");
    expect(
      around,
      "the drain is gated on `prev`, so a reconnect mid-session delivers nothing",
    ).not.toMatch(/prev \? \[\] : pendingOps\(/);
  });

  it("the author can see the queue", () => {
    // A queue nobody can see is the original failure wearing different
    // clothes: the note is kept, and still appears to have vanished.
    expect(HOOK, "the depth is not exposed").toContain("outboxDepth");
    const panel = readFileSync(join(ROOT, "src/components/ReviewPanel.tsx"), "utf8");
    expect(panel, "nothing renders the count").toContain("cp-review-outbox");
  });
});
