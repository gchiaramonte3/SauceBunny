// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { decodeHtmlEntities } from "./text";

/**
 * `decodeHtmlEntities` decodes by round-tripping through a detached
 * `<textarea>`, which means its behaviour is the HTML parser's behaviour, not
 * ours. That is the whole point - nobody wants to maintain an entity table -
 * but it also means the sharp edges are the parser's sharp edges, and they are
 * surprising enough to be worth pinning.
 *
 * These strings are source TITLES from yt-dlp extractors that scrape page HTML.
 * They reach the sidebar, the `title=` tooltip, and the default export filename,
 * so a wrong decode is visible and can end up on disk.
 *
 * EVERY assertion here was verified twice: under jsdom (where these run) and in
 * real Chromium via a throwaway Playwright probe. They agree on all of it. That
 * mattered for the `</textarea>` case below, where the spec's RCDATA rule made
 * truncation look likely and both engines say otherwise - a test asserting a
 * jsdom quirk would have been worse than no test.
 */

describe("empty and falsy input", () => {
  it("returns an empty string rather than throwing or printing 'null'", () => {
    expect(decodeHtmlEntities(null)).toBe("");
    expect(decodeHtmlEntities(undefined)).toBe("");
    expect(decodeHtmlEntities("")).toBe("");
  });
});

describe("the entities this exists for", () => {
  it("decodes the numeric apostrophe that LinkedIn returns", () => {
    // The motivating case, named in the module's own doc comment.
    expect(decodeHtmlEntities("it&#39;s complicated")).toBe("it's complicated");
  });

  it("decodes hex numeric references too", () => {
    expect(decodeHtmlEntities("it&#x27;s")).toBe("it's");
  });

  it("decodes the common named ones", () => {
    expect(decodeHtmlEntities("a&amp;b")).toBe("a&b");
    expect(decodeHtmlEntities("&quot;quoted&quot;")).toBe('"quoted"');
  });

  it("turns &nbsp; into a real non-breaking space, not a normal one", () => {
    // U+00A0. Worth pinning: a test written with a plain space in the expected
    // value passes by eye and fails by codepoint.
    expect(decodeHtmlEntities("a&nbsp;b")).toBe("a b");
    expect(decodeHtmlEntities("a&nbsp;b")).not.toBe("a b");
  });
});

describe("things that must NOT be decoded", () => {
  it("decodes one level only, so an escaped entity survives", () => {
    // A title that legitimately shows "&amp;" must not collapse to "&".
    expect(decodeHtmlEntities("a&amp;amp;b")).toBe("a&amp;b");
  });

  it("leaves a bare ampersand alone", () => {
    expect(decodeHtmlEntities("Tom & Jerry")).toBe("Tom & Jerry");
    expect(decodeHtmlEntities("&")).toBe("&");
  });

  it("leaves a malformed numeric reference alone", () => {
    expect(decodeHtmlEntities("a&#;b")).toBe("a&#;b");
  });

  it("keeps tag-looking text as literal text", () => {
    // The reason a textarea is used rather than a div. Titles containing
    // angle brackets are ordinary; they must survive as characters.
    expect(decodeHtmlEntities("Video <2024> ep")).toBe("Video <2024> ep");
    expect(decodeHtmlEntities("<b>bold</b>")).toBe("<b>bold</b>");
  });

  it("does not execute or strip a script tag, it returns it as text", () => {
    // Not a security claim about the app - the value is set as textContent
    // downstream - but this is the assertion that would fail loudly if anyone
    // ever swapped the textarea for a div and innerHTML.
    expect(decodeHtmlEntities("<script>alert(1)</script>")).toBe("<script>alert(1)</script>");
  });

  it("does NOT truncate at a literal closing textarea tag", () => {
    // The case that looks like a data-loss bug and is not. Setting innerHTML
    // on a textarea parses in RCDATA, where `</textarea>` should end the
    // element and orphan the rest - which would silently drop everything after
    // it. Both jsdom and Chromium keep the whole string, because the fragment
    // parser's context element does not re-enter RCDATA the way the tokenizer
    // does mid-document. Pinned so that if an engine ever changes its mind,
    // this fails instead of a title quietly losing its second half.
    expect(decodeHtmlEntities("before</textarea>after")).toBe("before</textarea>after");
    expect(decodeHtmlEntities("before</TEXTAREA>after")).toBe("before</TEXTAREA>after");
  });
});

describe("the legacy-entity rule, which is the genuinely surprising one", () => {
  it("decodes a semicolon-less legacy entity in the MIDDLE of a word", () => {
    // HTML5 keeps a list of legacy entities that decode without a trailing
    // semicolon (&not, &amp, &lt, &copy, &times …). So "&notareal;" is parsed
    // as `&not` + "areal;" and the string gains a ¬ that was never in it.
    // This is the parser being spec-correct, not a defect, but it is a real
    // way a scraped title can come out wrong and nobody would guess it from
    // reading the three lines of source.
    expect(decodeHtmlEntities("a&notareal;b")).toBe("a¬areal;b");
  });

  it("hits ordinary-looking title text, not just contrived input", () => {
    // "&times" inside a plain sentence becomes a multiplication sign.
    expect(decodeHtmlEntities("Multiplication &times tables")).toBe("Multiplication × tables");
  });
});

describe("unicode passes through untouched", () => {
  it("keeps emoji, and decodes around them", () => {
    expect(decodeHtmlEntities("🎬 &amp; more")).toBe("🎬 & more");
  });

  it("keeps a bidi control character rather than normalising it away", () => {
    // U+202E. If this were ever stripped, a filename built from the title
    // would stop matching the title shown in the UI.
    expect(decodeHtmlEntities("‮moc.exe&amp;")).toBe("‮moc.exe&");
  });

  it("keeps newlines and combining marks", () => {
    expect(decodeHtmlEntities("a\nb&amp;c")).toBe("a\nb&c");
    expect(decodeHtmlEntities("é&amp;")).toBe("é&");
  });
});

describe("the no-entity fast path", () => {
  it("returns strings without an ampersand byte-identically", () => {
    // The fast path skips the DOM entirely. It must not normalise anything -
    // whitespace, case, or unicode form.
    for (const s of ["no entities here", "  padded  ", "ALL CAPS", "é", "日本語", "a\tb"]) {
      expect(decodeHtmlEntities(s)).toBe(s);
    }
  });
});
