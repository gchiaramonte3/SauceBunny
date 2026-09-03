import { describe, expect, it } from "vitest";
import {
  buildEnhanceMessages, cleanRewrite, ENHANCE_MAX_CHARS, findProtectedSpans,
  tidyTypography, verifyRewrite,
} from "./enhance-comment";

/**
 * The tidy-up button once returned the note unchanged and said nothing.
 *
 * Everything here is the part that can be proved without a model running: the
 * deterministic floor that guarantees the button always does something, the
 * span extraction that decides what a rewrite is forbidden to touch, and the
 * verdict layer that catches the identity return the first version could not
 * see. The prompt itself cannot be unit-tested; its shape is asserted instead.
 */

describe("tidyTypography, the floor", () => {
  it("does the three things the note came back missing", () => {
    // Reported verbatim: "it kept everything lower case ... didn't check
    // punctuation". This runs with no model at all.
    expect(tidyTypography("sound design here is thin"))
      .toBe("Sound design here is thin.");
  });

  it("capitalises after each sentence end, and collapses doubled spaces", () => {
    expect(tidyTypography("the grade is warm.  the mix is fine"))
      .toBe("The grade is warm. The mix is fine.");
  });

  it("lifts a standalone lower-case i", () => {
    expect(tidyTypography("i think i lost the eyeline"))
      .toBe("I think I lost the eyeline.");
  });

  it("is idempotent", () => {
    const once = tidyTypography("dialogue sits under the music");
    expect(tidyTypography(once)).toBe(once);
  });

  it("does NOT capitalise a leading shot id", () => {
    // The one case where blind capitalisation corrupts content: a007_c012 is
    // a clip name, and "A007_c012" names nothing.
    expect(tidyTypography("a007_c012 looks soft")).toBe("a007_c012 looks soft.");
  });

  it("does not append a full stop after a trailing filename", () => {
    // "slate_v2.mov." is a different string from the file's name.
    expect(tidyTypography("check slate_v2.mov")).toBe("Check slate_v2.mov");
  });

  it("leaves an already-clean note exactly alone", () => {
    const clean = "The grade is too warm in the interior.";
    expect(tidyTypography(clean)).toBe(clean);
  });
});

describe("findProtectedSpans", () => {
  it("finds the things a rewrite must reproduce character for character", () => {
    const spans = findProtectedSpans(
      "at 01:23:04 and 4:02 see A007_C012.mov and https://x.test/a plus @dana",
    );
    const text = spans.map((s) => s.text);
    expect(text).toContain("01:23:04");
    expect(text).toContain("4:02");
    expect(text).toContain("A007_C012.mov");
    expect(text).toContain("https://x.test/a");
    expect(text).toContain("@dana");
  });

  it("finds nothing in an ordinary note, so ordinary notes are freely editable", () => {
    expect(findProtectedSpans("sound desgin here is thin, fix in the mix")).toEqual([]);
  });
});

describe("verifyRewrite", () => {
  const none = findProtectedSpans("plain note");

  it("rejects the identity return, case and spacing included", () => {
    // THE bug. A model that echoes the input used to pass straight through.
    expect(verifyRewrite("sound design is thin", "sound design is thin", none))
      .toMatchObject({ ok: false, reason: "identity" });
    expect(verifyRewrite("Sound design is thin", "sound design is thin", none))
      .toMatchObject({ ok: false, reason: "identity" });
  });

  it("rejects a rewrite that dropped or altered a protected span", () => {
    const original = "the cut at 01:23:04 is late in A007_C012.mov";
    const spans = findProtectedSpans(original);
    expect(verifyRewrite("The cut at 01:23:05 is late in A007_C012.mov.", original, spans))
      .toMatchObject({ ok: false, reason: "lost-span" });
    expect(verifyRewrite("The cut is late.", original, spans))
      .toMatchObject({ ok: false, reason: "lost-span" });
  });

  it("rejects a refusal instead of putting it in the comment box", () => {
    expect(verifyRewrite("I cannot rewrite this.", "fix the mix", none))
      .toMatchObject({ ok: false, reason: "refusal" });
  });

  it("rejects an echoed few-shot answer", () => {
    // A known small-model failure: answering with a demonstration instead of
    // the real note.
    expect(verifyRewrite("The grade is too warm in the interior.", "fix the mix", none))
      .toMatchObject({ ok: false, reason: "echoed-example" });
  });

  it("rejects an answer that grew into something else", () => {
    const long = "The sound design in this sequence is noticeably thin, and it would benefit "
      + "considerably from additional low end, perhaps a sub layer, and some room tone to glue it.";
    expect(verifyRewrite(long, "mix is thin", none)).toMatchObject({ ok: false, reason: "too-long" });
  });

  it("accepts a real correction", () => {
    expect(verifyRewrite("Sound design here is thin; fix it in the mix.",
      "sound desgin here is thin, fix in the mix", none))
      .toEqual({ ok: true, text: "Sound design here is thin; fix it in the mix." });
  });
});

describe("cleanRewrite", () => {
  const original = "sound design here is thin";

  it("keeps a clean answer untouched", () => {
    expect(cleanRewrite("Sound design here is thin.", original)).toBe("Sound design here is thin.");
  });

  it("strips a wrapping quote pair but not an interior quote", () => {
    expect(cleanRewrite('"Sound design is thin."', original)).toBe("Sound design is thin.");
    const q = 'He says "cut it" at 4:02.';
    expect(cleanRewrite(q, original)).toBe(q);
  });

  it("strips a real preamble line", () => {
    expect(cleanRewrite("Here is the corrected note:\nSound design is thin.", original))
      .toBe("Sound design is thin.");
  });

  it("does NOT eat a first line that merely ends in a colon", () => {
    // The old rule deleted the first line of ANY two-line answer ending in a
    // colon, so this note silently lost half of itself.
    const two = "Sound design is thin here:\nfix in the mix.";
    expect(cleanRewrite(two, original)).toBe(two);
  });

  it("hands the author's words back rather than an empty box", () => {
    expect(cleanRewrite("   \n ", original)).toBe(original);
  });
});

describe("the prompt", () => {
  it("asks for the three things that were missing, as instructions", () => {
    // The first version never used these words at all, which is why it did
    // nothing. If they vanish again, so does the feature.
    const sys = buildEnhanceMessages("x")[0].content.toLowerCase();
    for (const word of ["spelling", "punctuat", "capitalise", "grammatical", "apostrophe"]) {
      expect(sys, `the prompt no longer asks about ${word}`).toContain(word);
    }
  });

  it("demonstrates the job rather than only describing it", () => {
    const msgs = buildEnhanceMessages("the note");
    expect(msgs[0].role).toBe("system");
    // Real chat turns, not examples pasted inside the system string: a
    // chat-tuned model follows demonstrated turns far more reliably.
    const shots = msgs.slice(1, -1);
    expect(shots.length, "the few-shot turns are gone").toBeGreaterThanOrEqual(6);
    expect(shots.length % 2, "a shot is missing its answer").toBe(0);
    for (let i = 0; i < shots.length; i += 2) {
      expect(shots[i].role).toBe("user");
      expect(shots[i + 1].role).toBe("assistant");
    }
    // The real note goes LAST, so everything before it is a stable prefix the
    // local server's prompt cache can reuse across clicks.
    expect(msgs.at(-1)).toEqual({ role: "user", content: "the note" });
  });

  it("caps at something that is still a note", () => {
    expect(ENHANCE_MAX_CHARS).toBeGreaterThan(200);
    expect(ENHANCE_MAX_CHARS).toBeLessThan(5000);
  });
});
