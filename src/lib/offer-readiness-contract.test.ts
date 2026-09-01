import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The host can offer the file BEFORE anyone has failed to open it.
 *
 * This is a latency rule, not a style one. The offer button used to be gated
 * on `blockedMembers.length > 0`, which meant it did not exist until a guest
 * had resolved the source, missed, and sent SourceStatus "missing" back. Only
 * then did it render - and then a human had to notice it and click.
 *
 * That last step is the expensive one and it is easy to miss when reading the
 * code, because it does not appear in the code at all: it is however long it
 * takes a person to look at the right corner of the screen mid-conversation.
 * It sat in front of the hash, the substream, the ffprobe and the transfer,
 * and it is unbounded while all of those are merely slow.
 *
 * The CLICK is deliberately still required. CLAUDE.md's co-review rule wants a
 * consent step in front of a multi-GB read, and this does not remove it. What
 * it removes is the requirement that somebody fail first.
 */

const APP = readFileSync(join(__dirname, "../App.tsx"), "utf8");

/**
 * The RENDER CONDITION only - `{isPresenter && … && (` - and nothing after it.
 *
 * Deliberately not "the whole JSX block". The button still reads
 * blockedMembers in its className, to come forward as the primary action when
 * somebody actually is stuck, and that use is correct. A scan over the whole
 * block matches it and reports the rule broken while it holds; this contract
 * failed exactly that way on its first run.
 */
function offerGate(): string {
  const i = APP.indexOf("Send them the file");
  expect(i, "the offer button is gone; this contract needs rewriting").toBeGreaterThan(-1);
  const start = APP.lastIndexOf("{isPresenter", i);
  expect(start, "the offer button's render gate could not be located").toBeGreaterThan(-1);
  // The condition ends at the `&& (` that opens the rendered element.
  const end = APP.indexOf("&& (", start);
  expect(end, "the gate has no opening `&& (`").toBeGreaterThan(start);
  return APP.slice(start, end);
}

describe("offering the file does not wait for a failure", () => {
  it("found the offer button and its gate", () => {
    // The canary. Both lookups above return -1 rather than throwing if the
    // markup is renamed, and a gate of "" would satisfy every assertion below.
    const gate = offerGate();
    expect(gate.length, "the extracted gate is empty").toBeGreaterThan(20);
    expect(gate, "the gate no longer mentions the presenter").toContain("isPresenter");
  });

  it("is not gated on anyone having reported that they cannot open it", () => {
    expect(offerGate()).not.toContain("blockedMembers");
  });

  it("still requires a file and a presenter, so it cannot offer nothing", () => {
    const gate = offerGate();
    expect(gate).toContain("localFilePath");
    expect(gate).toContain('sourceKind === "file"');
  });

  it("still offers the ORIGINAL rather than a prepped copy", () => {
    // playbackPath is a re-encode. Which file crosses the wire is a separate
    // decision from when the button appears, and swapping it silently would
    // change what a reviewer is judging. If that changes, it should be a
    // deliberate commit that updates this line.
    const i = APP.indexOf("Send them the file");
    const call = APP.slice(APP.lastIndexOf("offerCurrentFile(", i), i);
    expect(call).toContain("offerCurrentFile(localFilePath");
  });
});
