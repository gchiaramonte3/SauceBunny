// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { KindGlyph } from "./KindGlyph";
import { kindTag, NON_SPEECH_KINDS } from "../../lib/speech-kind";

afterEach(cleanup);

const svgs = () => document.querySelectorAll("svg");
const text = () => document.body.textContent;

describe("KindGlyph", () => {
  it("shows initials for a person", () => {
    render(<KindGlyph tag="SPEAKER_02" name="Harry Jowsey" />);
    expect(text()).toBe("HJ");
    expect(svgs()).toHaveLength(0);
  });

  it("shows an icon, not initials, for every built-in kind", () => {
    for (const k of NON_SPEECH_KINDS) {
      cleanup();
      render(<KindGlyph tag={kindTag(k)} name="anything at all" />);
      expect(svgs(), k).toHaveLength(1);
      expect(text(), k).toBe("");
    }
  });

  it("gives each kind a DIFFERENT icon", () => {
    // Music and lyrics are the pair a user most needs to tell apart, and a
    // shared glyph would make the whole feature decorative.
    const paths = new Set<string>();
    for (const k of NON_SPEECH_KINDS) {
      cleanup();
      render(<KindGlyph tag={kindTag(k)} name="x" />);
      paths.add(document.querySelector("svg")!.innerHTML);
    }
    expect(paths.size).toBe(NON_SPEECH_KINDS.length);
  });

  it("keeps the icon on a built-in group the user renamed", () => {
    // The tag is what makes it music, not the label on it.
    render(<KindGlyph tag={kindTag("music")} name="Opening theme" />);
    expect(svgs()).toHaveLength(1);
  });

  it("recognises a kind typed as a plain speaker NAME", () => {
    // So naming a speaker "Music" in the sheet does the obvious thing without
    // the user having to find the preset.
    render(<KindGlyph tag="SPEAKER_07" name="Music" />);
    expect(svgs()).toHaveLength(1);
  });

  it("still shows initials for a person whose name merely contains one", () => {
    render(<KindGlyph tag="SPEAKER_07" name="Music supervisor" />);
    expect(svgs()).toHaveLength(0);
    expect(text()).toBe("MS");
  });
});
