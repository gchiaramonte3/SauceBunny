// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { decodeHtmlEntities } from "./text";
import { suggestFilename } from "./filename";

/**
 * A scraped title and the filename it seeds say the same thing.
 *
 * They did not. yt-dlp's LinkedIn and Reddit extractors scrape page HTML and
 * return titles carrying raw entities — text.ts's own doc names the case
 * ("every apostrophe comes back as `&#39;`"). The sidebar decoded for DISPLAY,
 * so the h2 read "Tom's Big Day" while the seeded export name, the "Saves as"
 * preview and the file written to disk all kept "Tom&#39;s-Big-Day". One
 * component contradicting itself about one string.
 *
 * The leading-entity case was worse than a stray "&#39;": suggestFilename's
 * `^[^A-Za-z0-9]+` strip — which exists so names do not start with a stray
 * apostrophe — eats only the "&" and promotes the entity NAME to the first
 * word, so `"&quot;Quoted&quot; Title"` became `quot;Quoted&quot;-Title`.
 *
 * The fix decodes once at the metadata boundary (App.tsx `decodeMetaTitle`),
 * NOT inside filename.ts. Two reasons, both load-bearing: `sanitizeFilename`
 * mirrors Rust's `sanitize_filename` byte for byte and must not gain a step
 * Rust lacks, and `filename.ts` / `transcript-source-resolve.ts` are pure
 * node-environment modules while `decodeHtmlEntities` needs a DOM.
 *
 * So this file tests the COMPOSITION rather than either half — that is where
 * the bug lived, and a test of `suggestFilename` alone would still pass with
 * the bug present.
 */

/** What the boundary now does, and what the sidebar has always done. */
const asDisplayed = (title: string) => decodeHtmlEntities(title);
/** What the export field is seeded with, after the boundary decode. */
const asFilename = (title: string) => suggestFilename(decodeHtmlEntities(title));

describe("an entity-carrying title", () => {
  it("no longer leaks the entity into the filename", () => {
    expect(asFilename("Tom&#39;s Big Day")).toBe("Tom's-Big-Day");
  });

  it("does not promote the entity name to the first word", () => {
    // The regression that produced `quot;Quoted&quot;-Title`. The result is
    // `Quoted_-Title`, not `Quoted-Title`: decoding yields a real `"`, and
    // sanitizeFilename maps `"` to `_` because it mirrors Rust's
    // sanitize_filename, where `"` is an illegal filename character. The
    // leading `_` is stripped, the trailing one is mid-string by then and
    // stays. Ugly, but it is the CHARACTER the title actually contains rather
    // than the name of an entity, which is the whole point of the fix.
    expect(asFilename("&quot;Quoted&quot; Title")).toBe("Quoted_-Title");
  });

  it("handles the ampersand entity without leaving 'amp'", () => {
    expect(asFilename("R&amp;D update")).toBe("R&D-update");
  });
});

describe("display and filename agree", () => {
  it("for every title shape that motivated this", () => {
    // The invariant, stated directly: whatever the sidebar shows, the filename
    // is that same text run through the ordinary slug cleaning — never a
    // different decoding of it.
    for (const raw of [
      "Tom&#39;s Big Day",
      "&quot;Quoted&quot; Title",
      "R&amp;D update",
      "Plain Title",
      "Caf&eacute; session",
    ]) {
      expect(asFilename(raw), `filename disagreed with display for ${raw}`)
        .toBe(suggestFilename(asDisplayed(raw)));
    }
  });

  it("leaves a title with no entities exactly as it was", () => {
    // The canary: if the decode ever became lossy or over-eager, these would
    // move, and every assertion above would still pass.
    expect(asDisplayed("Plain Title")).toBe("Plain Title");
    expect(asFilename("Plain Title")).toBe("Plain-Title");
    // A bare ampersand is a legal filename character and is NOT an entity, so
    // it survives into the name. Pinned to catch an over-eager future "strip
    // the ampersands" that would silently rename people's exports.
    expect(asFilename("Tom & Jerry")).toBe("Tom-&-Jerry");
  });
});

describe("decoding is safe to apply at a boundary", () => {
  it("is idempotent for already-decoded text, so a second pass cannot corrupt", () => {
    // The sidebar still calls decodeHtmlEntities on a title the boundary has
    // already decoded. That double call must be a no-op, or the fix would
    // trade one wrong string for another.
    for (const s of ["Tom's Big Day", "R&D update", "Tom & Jerry", "Café"]) {
      expect(decodeHtmlEntities(decodeHtmlEntities(s))).toBe(decodeHtmlEntities(s));
    }
  });

  it("does NOT collapse a deliberately escaped entity on the second pass", () => {
    // "&amp;amp;" decodes once to "&amp;". A second pass would give "&" and
    // silently change what the title says. This is the case that makes
    // "decode once, at one place" the rule rather than a preference.
    expect(decodeHtmlEntities("a&amp;amp;b")).toBe("a&amp;b");
    expect(decodeHtmlEntities(decodeHtmlEntities("a&amp;amp;b"))).toBe("a&b");
  });
});
