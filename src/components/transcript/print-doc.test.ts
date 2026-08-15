import { describe, expect, it } from "vitest";
import { buildTranscriptPrintDoc, escapeHtml } from "./helpers";
import type { Turn } from "../../lib/srt";

/**
 * The print document is `document.write`n into a live iframe, not saved to a
 * file. Anything interpolated into it that is not escaped will execute.
 *
 * Transcript text is not necessarily the user's own writing: captions can be
 * downloaded alongside a video, so the words in a cue may come from whoever
 * published it, and a speaker name can be edited to anything. The filename
 * comes from the media file.
 *
 * Every interpolation was already escaped when this test was written. The
 * point is not that it was broken; it is that nothing could show it was
 * correct, and nothing would notice when a sixth interpolation gets added to a
 * template string living inside a 2,200-line component.
 */
const turn = (speaker: string | null, ...lines: string[]): Turn => ({
  speaker,
  start: 0,
  end: 1,
  cues: lines.map((text, i) => ({ index: i, start: 0, end: 1, text, speaker })),
});

const build = (turns: Turn[], filename = "clip.mp4") =>
  buildTranscriptPrintDoc(turns, filename, (_i, s) => s ?? "Speaker", () => "00:00:01:00");

describe("escapeHtml", () => {
  it("neutralises every character that can leave a text node", () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
    expect(escapeHtml(`" '`)).toBe("&quot; &#39;");
  });

  it("escapes the ampersand FIRST, so an escape is not escaped twice", () => {
    // & last would turn the &lt; produced a moment earlier into &amp;lt;, and
    // the reader would see the markup rather than the character.
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml("a & b < c")).toBe("a &amp; b &lt; c");
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("replaces every occurrence, not just the first", () => {
    expect(escapeHtml("<<<")).toBe("&lt;&lt;&lt;");
    expect(escapeHtml("a&b&c")).toBe("a&amp;b&amp;c");
  });
});

describe("buildTranscriptPrintDoc", () => {
  it("renders a normal transcript", () => {
    const doc = build([turn("Ada", "Hello there.", "Second line.")]);
    expect(doc).toContain("Hello there. Second line.");
    expect(doc).toContain("Ada");
    expect(doc).toContain("1 turn ·");
  });

  it("counts turns in plural correctly", () => {
    expect(build([turn("A", "x"), turn("B", "y")])).toContain("2 turns ·");
    expect(build([])).toContain("0 turns ·");
  });

  it("does not let a hostile cue open a tag", () => {
    const doc = build([turn("Ada", '<script>fetch("//x")</script>')]);
    expect(doc).not.toContain("<script>fetch");
    expect(doc).toContain("&lt;script&gt;");
  });

  it("does not let a hostile speaker name open a tag", () => {
    const doc = build([turn('<img src=x onerror=alert(1)>', "hi")]);
    expect(doc).not.toContain("<img src=x");
    expect(doc).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("does not let a filename break out of the title or the style block", () => {
    // The filename is interpolated twice, once inside <title> and once inside
    // <h1>. A </style> or </title> in it would end the element early and put
    // everything after it into the document as markup.
    const doc = build([turn("A", "x")], "</title><script>alert(1)</script>.mp4");
    expect(doc).not.toContain("</title><script>");
    expect(doc).toContain("&lt;/title&gt;");
  });

  it("ships no script of its own, so the only script is one that got in", () => {
    // If this ever fails because a legitimate script was added, the escaping
    // tests above stop being sufficient on their own and this file needs a
    // rethink rather than an update.
    const doc = build([turn("Ada", "ordinary words")]);
    expect(doc.toLowerCase()).not.toContain("<script");
    expect(doc.toLowerCase()).not.toContain("javascript:");
    expect(doc.toLowerCase()).not.toContain("onerror=");
  });

  it("leaves ordinary punctuation readable rather than mangled", () => {
    // Over-escaping is its own failure: a transcript full of &amp; is a
    // broken document even though it is a safe one.
    const doc = build([turn("Ada", "Tom & Jerry, 5 > 3, it's fine")]);
    expect(doc).toContain("Tom &amp; Jerry, 5 &gt; 3, it&#39;s fine");
    expect(doc).not.toContain("&amp;amp;");
  });
});
