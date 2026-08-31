import { describe, expect, it } from "vitest";
import { DOWNLOAD_URL, reviewInviteMessage, reviewLink } from "./review-link";

describe("review link", () => {
  it("carries the code and nothing else", () => {
    expect(reviewLink("SAUC-ABCDE-FGHIJ")).toBe("saucebunny://review/SAUC-ABCDE-FGHIJ");
  });

  it("names no person and no title", () => {
    // The rule this file exists to hold. A link travels through Slack,
    // clipboard managers, MDM logging and crash reports, and a cut title is
    // very often a client's name.
    const link = reviewLink("SAUC-ABCDE");
    expect(link, "a query string carries whatever someone decided to add").not.toMatch(/[?&#]/);
    // scheme, host, code. Nothing else.
    expect(link.split("/").filter(Boolean)).toEqual(["saucebunny:", "review", "SAUC-ABCDE"]);
  });

  it("trims what the caller passes", () => {
    expect(reviewLink("  SAUC-ABCDE\n")).toBe("saucebunny://review/SAUC-ABCDE");
  });

  it("escapes anything that would break the path", () => {
    expect(reviewLink("a b/c")).toBe("saucebunny://review/a%20b%2Fc");
  });

  it("the pasted message tells a recipient without the app what to do", () => {
    // How the link fails is the reason: saucebunny:// on a Mac without the app
    // does nothing at all, with no error, which reads as a broken link.
    const msg = reviewInviteMessage("SAUC-ABCDE");
    expect(msg).toContain(reviewLink("SAUC-ABCDE"));
    expect(msg).toContain(DOWNLOAD_URL);
    expect(msg.split("\n")[0], "the link must be the first line, so it is clickable")
      .toBe(reviewLink("SAUC-ABCDE"));
  });
});
