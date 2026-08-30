import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * TWO KINDS OF RANGE, ONE MISSING BRIDGE.
 *
 * A range COMMENT says "look at this span". It is shared: it crosses the wire
 * on the existing `add` op, lands on every peer's timeline as a tinted band,
 * survives to disk, and exports to all four NLE marker formats (a duration
 * marker in Premiere, Resolve and FCPX; Avid has no spanned-marker import, so
 * markers.ts emits a >> RANGE START / << RANGE END bracket pair there).
 *
 * CLIP MARKS say "cut this span". They are this machine's export plan, and
 * they are deliberately local - `session-msg-contract` forbids them on the
 * wire BY NAME, and App.tsx suppresses queue bands during a session with the
 * rationale that the queue "was never SENT".
 *
 * Both were built. Neither was wrong. What was missing was the verb between
 * them: `onMarkRange` and `onQueueRange` have existed for a while, flow from
 * App into QueueDrawer, and QueueDrawer handed them to TranscriptViewer and
 * ONLY TranscriptViewer. So you could adopt a range selected in a transcript,
 * but a range the whole room had just agreed on in a live session could only
 * be jumped to.
 *
 * That is the defect this pins, and it is a wiring fact rather than a
 * behaviour: one sibling got the props and the other did not. Nothing about it
 * is visible in either component alone, which is why it survived.
 */

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** The props inside ONE JSX element, so a prop on a sibling element cannot
 *  satisfy an assertion about this one. */
function propsOf(src: string, tag: string): string {
  const open = src.indexOf("<" + tag);
  if (open < 0) return "";
  const end = src.indexOf("/>", open);
  return end < 0 ? "" : src.slice(open, end);
}

describe("a range note can be adopted into your own marks", () => {
  const queueDrawer = read("src/components/QueueDrawer.tsx");

  it("QueueDrawer hands the verbs to BOTH panels", () => {
    const tx = propsOf(queueDrawer, "TranscriptViewer");
    const rv = propsOf(queueDrawer, "ReviewPanel");

    // CANARY: both elements were found. `propsOf` returns "" for a missing
    // tag, and "" contains nothing, so a rename would fail loudly here rather
    // than silently passing an assertion about an empty string.
    expect(tx.length, "TranscriptViewer mount not found").toBeGreaterThan(100);
    expect(rv.length, "ReviewPanel mount not found").toBeGreaterThan(100);

    for (const [name, props] of [["TranscriptViewer", tx], ["ReviewPanel", rv]] as const) {
      expect(props, name + " is missing onMarkRange").toContain("onMarkRange=");
      expect(props, name + " is missing onQueueRange").toContain("onQueueRange=");
    }
  });

  it("the buttons only appear on a real span", () => {
    // A point comment has nothing to adopt: markRangeFromSeconds returns null
    // when outF <= inF, so an ungated button would be a control that silently
    // does nothing - the failure mode MIN_RANGE_SPAN exists to prevent
    // elsewhere in the same feature.
    const panel = read("src/components/ReviewPanel.tsx");
    const adopts = [...panel.matchAll(/\{isRange && on(Mark|Queue)Range && \(/g)];
    expect(adopts.length, "the adopt buttons are not gated on isRange").toBe(2);
  });

  it("the range test is derived once, not written three times", () => {
    // The timecode chip made this same comparison twice inline (className and
    // title) before the buttons made it four. Four copies of
    // `c.timeEnd != null && c.timeEnd > c.timeStart` is how a chip comes to
    // say "range" while the button next to it is absent.
    const panel = read("src/components/ReviewPanel.tsx");
    const inline = [...panel.matchAll(/c\.timeEnd != null && c\.timeEnd > c\.timeStart/g)];
    expect(inline.length, "the range test is inlined instead of using isRange")
      .toBeLessThanOrEqual(1); // the one that DEFINES isRange
    expect(panel, "isRange is not defined").toMatch(/const isRange = c\.timeEnd != null/);
  });
});

describe("adopting stays local, which is what makes it safe", () => {
  it("no clip mark is put on the wire by this", () => {
    // The whole reason this is a button rather than a message. Re-asserted
    // here because the tempting "improvement" to this feature is to broadcast
    // the adopted marks, and that is the line session-msg-contract draws.
    const hook = read("src/hooks/use-co-review.ts");
    for (const ident of ["inFrames", "outFrames", "sourceMarks", "markRangeFromSeconds"]) {
      expect(hook, "co-review must not learn about clip marks: " + ident)
        .not.toContain(ident);
    }
  });
});
