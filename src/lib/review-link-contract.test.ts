import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reviewLink } from "./review-link";

/**
 * The scheme means the same thing in all four places that decide it.
 *
 * A `saucebunny://review/<code>` link is agreed by: Info.plist (whether macOS
 * routes the click here at all), review_link.rs (what the app parses out of
 * it), review-link.ts (what a host puts on the clipboard), and lib.rs (whether
 * the Opened event is wired at all). Three of those are literals in three
 * languages. Nothing but this compares them.
 *
 * The failure is quiet and total: a scheme mismatch means every link anyone
 * has ever sent does nothing when clicked, with no error anywhere.
 */

const ROOT = join(__dirname, "../..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** The scheme, taken from the TS builder rather than typed again here. */
const SCHEME = new URL(reviewLink("x")).protocol.replace(":", "");

describe("review link scheme", () => {
  it("macOS is told to route it here", () => {
    const plist = read("src-tauri/Info.plist");
    expect(plist, "no CFBundleURLTypes; a click reaches nothing").toContain("CFBundleURLTypes");
    expect(plist, `the plist does not register ${SCHEME}://`).toMatch(
      new RegExp(`<key>CFBundleURLSchemes</key>\\s*<array>\\s*<string>${SCHEME}</string>`),
    );
  });

  it("the app listens for the click", () => {
    // Registered but unhandled is the same as unregistered, and looks healthier.
    const lib = read("src-tauri/src/lib.rs").replace(/^\s*\/\/.*$/gm, "");
    expect(lib, "RunEvent::Opened is not handled").toContain("RunEvent::Opened");
    expect(lib, "the Opened arm does nothing with the URLs").toContain("remember_and_announce");
    expect(lib, "the pending-link slot is not managed, so a cold launch drops it")
      .toContain("PendingReviewLink::default()");
  });

  it("Rust parses the same shape TypeScript builds", () => {
    // Strip only WHOLE-LINE comments. A greedy //-to-end-of-line strip eats
    // the "//" inside the literal `"saucebunny://"`, which is the exact string
    // being checked, and the test then fails against correct code.
    const rs = read("src-tauri/src/commands/review_link.rs").replace(/^\s*\/\/.*$/gm, "");
    const built = new URL(reviewLink("CODE"));
    expect(rs, `Rust strips a different scheme than ${SCHEME}://`).toContain(`"${SCHEME}://"`);
    expect(rs, `Rust expects a different host than ${built.host}`).toMatch(
      new RegExp(`REVIEW_HOST: &str = "${built.host}"`),
    );
  });

  it("the link carries no query, fragment or extra path", () => {
    // The privacy rule, held against the builder rather than against prose. A
    // sender name or a cut title in the URL travels through Slack, clipboard
    // managers, MDM logging and crash reports.
    const u = new URL(reviewLink("SAUC-ABCDE"));
    expect(u.search, "the link carries a query string").toBe("");
    expect(u.hash, "the link carries a fragment").toBe("");
    expect(u.pathname.split("/").filter(Boolean), "the path is not just the code")
      .toEqual(["SAUC-ABCDE"]);
  });

  it("the frontend claims the buffered link, and clears it", () => {
    const hook = read("src/hooks/use-co-review.ts");
    expect(hook, "nothing pulls the cold-launch buffer").toContain("take_pending_review_link");
    expect(hook, "the listener is not named after its event").toContain("onDeeplinkReview");
  });
});
