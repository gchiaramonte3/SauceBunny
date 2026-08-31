import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * An inbound review op is never discarded for want of a document.
 *
 * The guard was `prev ? applyReviewOp(prev, op) : prev` - a null check that
 * dropped somebody else's note without a word. A guest's doc is null until the
 * host's first snapshot lands, so an op posted in that window vanished from
 * the receiver, and the only reason it usually survived was that the snapshot
 * which followed happened to contain it. Nothing enforced that.
 *
 * It became worse when the outbox shipped. The sender's copy clears on a
 * successful invoke, so a receiver that silently drops the op makes the note
 * disappear from BOTH machines with no log on either - precisely the failure
 * the outbox exists to prevent.
 */

const ROOT = join(__dirname, "../..");
const HOOK = readFileSync(join(ROOT, "src/hooks/use-co-review.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/** The `case "reviewOp":` arm of the session:msg switch. */
function inboundArm(): string {
  const i = HOOK.indexOf('case "reviewOp":');
  expect(i, "the reviewOp arm is gone; this check needs rewriting").toBeGreaterThan(-1);
  const end = HOOK.indexOf('case "reaction"', i);
  return HOOK.slice(i, end === -1 ? i + 1800 : end);
}

describe("an inbound review op", () => {
  it("the arm exists and applies ops", () => {
    // The canary: every assertion below reads this slice.
    const arm = inboundArm();
    expect(arm.length).toBeGreaterThan(200);
    expect(arm).toContain("attributeReviewOp");
  });

  it("is buffered when there is no document yet, not dropped", () => {
    const arm = inboundArm();
    expect(arm, "an op with no doc is not kept anywhere").toContain("pendingOpsRef.current.push");
  });

  it("decides explicitly which of the two things to do", () => {
    // Keyed on STRUCTURE, not on the ternary. The safe branch still contains
    // `prev ? applyReviewOp(...) : prev` - correctly, since the updater's
    // `prev` can differ from the ref it was chosen by - so a regex looking for
    // that shape matches the fix as readily as the bug. What distinguishes
    // them is that the fix asks the question at all.
    const arm = inboundArm().replace(/\s+/g, " ");
    expect(arm, "nothing checks whether a document exists").toContain("if (sessionDocRef.current)");
    expect(arm, "there is no else branch, so the op has nowhere to go").toMatch(
      /if \(sessionDocRef\.current\) \{[^}]*\} else \{/,
    );
  });

  it("says so when it holds one", () => {
    // Silence is what made this survive so long. A held note is a thing a
    // support log should show.
    expect(inboundArm(), "holding a note is not logged").toMatch(/slog\(/);
  });

  it("the buffer it uses is the one that gets replayed", () => {
    // pendingOpsRef is drained into adoptSnapshot on first adoption. Buffering
    // into anything else would be a queue nothing reads.
    expect(HOOK).toMatch(/const replay = prev \? \[\] : pendingOpsRef\.current;/);
  });
});
