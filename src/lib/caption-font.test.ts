import { describe, expect, it } from "vitest";
import { CAPTION_FONT_KEYS, migrateCaptionFont } from "./caption-font";

/**
 * These tests could not be written while this function lived inside App.tsx,
 * which is the argument for CLAUDE.md's roadmap item 6 in miniature: a
 * ten-line pure function was unreachable because nothing could import it
 * without booting the whole app, and it had a real defect in it the whole
 * time.
 */
describe("migrateCaptionFont", () => {
  it("translates a pre-rename pref instead of discarding it", () => {
    expect(migrateCaptionFont("sans")).toBe("nunito");
    expect(migrateCaptionFont("serif")).toBe("georgia");
    expect(migrateCaptionFont("mono")).toBe("courier");
  });

  it("passes a current key through untouched", () => {
    for (const key of CAPTION_FONT_KEYS) expect(migrateCaptionFont(key)).toBe(key);
  });

  it("falls back for anything it does not recognise", () => {
    expect(migrateCaptionFont("comic sans")).toBe("verdana");
    expect(migrateCaptionFont("")).toBe("verdana");
    expect(migrateCaptionFont(undefined)).toBe("verdana");
    expect(migrateCaptionFont(null)).toBe("verdana");
    expect(migrateCaptionFont(42)).toBe("verdana");
    expect(migrateCaptionFont({ font: "sans" })).toBe("verdana");
  });

  it("does not hand back a prototype member as if it were a font", () => {
    // THE BUG. The legacy table was an object literal tested with
    // `raw in legacy`, and `in` walks the prototype chain: every one of these
    // reported as present and returned the inherited FUNCTION, out of a
    // function annotated `: CaptionFontKey`. Verified against the original
    // before the fix — all four returned functions.
    for (const key of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"]) {
      const got = migrateCaptionFont(key);
      expect(typeof got, `${key} produced a ${typeof got}`).toBe("string");
      expect(got).toBe("verdana");
    }
  });

  it("only ever returns something the font table can resolve", () => {
    // The property that actually matters downstream: whatever comes out of
    // here is indexed into CAP_FONTS to build a font-family. A value outside
    // the key set renders captions with no font at all.
    const inputs: unknown[] = [
      "sans", "serif", "mono", "verdana", "nunito", "toString", "constructor",
      "", " ", "VERDANA", null, undefined, 0, [], {}, () => {},
    ];
    for (const raw of inputs) {
      expect(CAPTION_FONT_KEYS).toContain(migrateCaptionFont(raw));
    }
  });
});
