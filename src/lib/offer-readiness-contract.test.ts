// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The host can offer the file BEFORE anyone has failed to open it, and a
 * transcode is never offered as if it were the master.
 *
 * Both rules survived a rewrite of the surface they were written against. The
 * offer used to be a button gated on `blockedMembers.length > 0`, so it did
 * not exist until a guest had reported "missing" and a human had noticed it
 * appear - an unbounded wait sitting in front of the hash, the substream and
 * the transfer. Those controls have since collapsed into one Share button and
 * a menu, because seven elements in the session header were overlapping each
 * other on a laptop.
 *
 * So this checks the OPTIONS rather than the buttons. The shape moved; the two
 * things that matter did not.
 */

const APP = readFileSync(join(__dirname, "../App.tsx"), "utf8");

/** The share menu's option list, which is where the actions now live. */
function shareOptions(): string {
  const i = APP.indexOf("const shareOptions");
  expect(i, "the share options are gone; this contract needs rewriting").toBeGreaterThan(-1);
  const end = APP.indexOf("}, [viewerShareState", i);
  expect(end, "could not find the end of the share options").toBeGreaterThan(i);
  return APP.slice(i, end);
}

describe("offering the file does not wait for a failure", () => {
  it("found the options to check", () => {
    // The canary: both lookups return -1 rather than throwing, and an empty
    // slice would satisfy every assertion below.
    expect(shareOptions().length).toBeGreaterThan(200);
  });

  it("no option is gated on anyone having reported that they cannot open it", () => {
    // blockedMembers may still decide how LOUD the button is. It must not
    // decide whether the actions exist.
    expect(shareOptions()).not.toContain("blockedMembers");
  });

  it("the live view is offered first, because it is the fast one", () => {
    const o = shareOptions();
    const live = o.indexOf('key: "live"');
    const original = o.indexOf('key: "original"');
    expect(live, "the live option is gone").toBeGreaterThan(-1);
    expect(original, "the send-the-original option is gone").toBeGreaterThan(-1);
    expect(live, "sending a file is offered above the instant option").toBeLessThan(original);
  });
});

describe("a transcode is never offered as if it were the master", () => {
  /**
   * The prep copy is much smaller and far faster to send, which is exactly why
   * it is tempting to send it quietly. CLAUDE.md permits it - "a local copy OR
   * a fixed, known-quality stream" - but what makes it permissible is that the
   * person receiving it knows. A colourist approving a grade from an h264
   * proxy they believed was the master is the harm, and nothing else in the
   * suite would notice it.
   */
  it("offers the prep copy under a name that says preview", () => {
    const o = shareOptions();
    const i = o.indexOf("offerCurrentFile(playbackPath");
    expect(i, "the preview-copy offer is gone").toBeGreaterThan(-1);
    expect(o.slice(i, o.indexOf(")", i)).toLowerCase()).toContain("preview");
  });

  it("still keeps a way to send the real thing", () => {
    // A preview-only path would be worse than the slow original: some reviews
    // need the master and there would be no way to ask.
    expect(shareOptions()).toContain("offerCurrentFile(localFilePath");
  });
});
