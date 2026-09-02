import { describe, expect, it } from "vitest";
import { cleanRewrite, ENHANCE_MAX_CHARS } from "./enhance-comment";

/**
 * What small models actually return, as opposed to what they were told to.
 *
 * The system prompt says "reply with the rewritten note and nothing else". A
 * 3B running locally obeys most of the time. These are the shapes it produces
 * when it does not, and each one would otherwise land verbatim in a reviewer's
 * comment box and read as the feature being broken.
 */
describe("cleanRewrite", () => {
  const original = "sound design here is thin";

  it("keeps a clean rewrite untouched", () => {
    expect(cleanRewrite("The sound design here is thin.", original)).toBe("The sound design here is thin.");
  });

  it("strips a wrapping pair of quotes, straight or curly", () => {
    expect(cleanRewrite('"The sound design is thin."', original)).toBe("The sound design is thin.");
    expect(cleanRewrite("“The sound design is thin.”", original)).toBe("The sound design is thin.");
  });

  it("leaves an INTERIOR quote alone", () => {
    // Only a matched wrapping pair is a wrapper. A note that quotes someone
    // must survive intact.
    const q = 'He says "cut it" at 4:02.';
    expect(cleanRewrite(q, original)).toBe(q);
  });

  it("drops a leading label line but keeps the note", () => {
    expect(cleanRewrite("Here is the rewritten note:\nThe sound design is thin.", original))
      .toBe("The sound design is thin.");
  });

  it("never eats a one-line answer that merely ends in a colon word", () => {
    const s = "Fix the mix: it is thin.";
    expect(cleanRewrite(s, original)).toBe(s);
  });

  it("gives the author's words back rather than an empty box", () => {
    expect(cleanRewrite("", original)).toBe(original);
    expect(cleanRewrite("   \n  ", original)).toBe(original);
  });

  it("caps at something that is still a note", () => {
    // A ceiling exists at all, and it is a note-sized one: past this the round
    // trip stops feeling like a button.
    expect(ENHANCE_MAX_CHARS).toBeGreaterThan(200);
    expect(ENHANCE_MAX_CHARS).toBeLessThan(5000);
  });
});
