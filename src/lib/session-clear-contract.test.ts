import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Clearing the room's source drops the shared notes - AFTER writing them down.
 *
 * Two halves, and the order between them is the whole point.
 *
 * THE BUG: pressing Clear during a live session moved the picture and nothing
 * else. The shared review doc still held the outgoing clip's notes, so the
 * panel went on showing them - on the host's screen, and on every guest's,
 * because the clear only ever travelled as a source change. A room that had
 * plainly cleared sat there displaying a previous clip's review.
 *
 * THE HAZARD IN FIXING IT: notes belong to the CLIP, not to the room. Dropping
 * the doc without persisting first would turn "clear the room" into a way to
 * destroy work - including a guest's own notes, which are theirs. So both
 * paths persist before they drop, and this asserts that ordering in source,
 * because it is the difference between a tidy-up and data loss.
 *
 * Source-level because the alternative is standing up a whole co-review
 * session in jsdom; the ORDER of two calls inside one branch is exactly the
 * kind of thing that reads clearly in the text and is expensive to observe.
 */

const HOOK = readFileSync(join(__dirname, "../hooks/use-co-review.ts"), "utf8");
const PANEL = readFileSync(join(__dirname, "../components/ReviewPanel.tsx"), "utf8");

/** The body of the first `{...}` block starting at `from`. */
function blockAt(text: string, from: number): string {
  const open = text.indexOf("{", from);
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") { depth -= 1; if (depth === 0) return text.slice(open, i + 1); }
  }
  return "";
}

describe("session-clear-contract", () => {
  it("the guest path persists the notes before dropping them", () => {
    const at = HOOK.indexOf('if (m.sourceKind === "none")');
    expect(at, "the presenter-cleared branch is gone or was renamed").toBeGreaterThan(-1);
    const body = blockAt(HOOK, at);
    expect(body.length, "the branch body did not parse").toBeGreaterThan(40);
    const persist = body.indexOf("persistDocRef.current(");
    const drop = body.indexOf("setSessionDoc(null)");
    expect(persist, "a guest's notes are dropped without being written to disk first").toBeGreaterThan(-1);
    expect(drop, "the guest keeps showing the cleared clip's notes").toBeGreaterThan(-1);
    expect(persist, "the doc is dropped BEFORE it is persisted - the notes are lost").toBeLessThan(drop);
  });

  it("the host path persists the notes before dropping them", () => {
    const at = HOOK.indexOf("if (!reviewSourceKey) {");
    expect(at, "the host's cleared-source branch is gone").toBeGreaterThan(-1);
    const body = blockAt(HOOK, at);
    expect(body.length, "the branch body did not parse").toBeGreaterThan(40);
    const persist = body.indexOf("persistDoc(");
    const drop = body.indexOf("setSessionDoc(null)");
    expect(persist, "the host's notes are dropped without being written to disk first").toBeGreaterThan(-1);
    expect(drop, "the host keeps showing the cleared clip's notes").toBeGreaterThan(-1);
    expect(persist, "the doc is dropped BEFORE it is persisted - the notes are lost").toBeLessThan(drop);
  });

  it("a cleared room does not read as 'Connecting'", () => {
    // Both states are "in a session with no doc". One of them ends.
    expect(
      PANEL,
      "the panel calls a cleared room 'Connecting to the session…', which never resolves",
    ).toMatch(/const connecting = inSession && !sessionDoc && roomHasSource/);
  });
});
