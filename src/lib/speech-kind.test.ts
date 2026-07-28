import { describe, expect, it } from "vitest";
import {
  countKinds, kindOfCueText, kindOfName, kindOfTag, kindTag,
  KIND_LABEL, NON_SPEECH_COLOR, NON_SPEECH_KINDS, speakerKind,
} from "./speech-kind";
import { SPEAKER_PALETTE } from "../components/transcript/helpers";

describe("kindOfCueText — reading markers the transcript already carries", () => {
  it("calls a sung line a LYRIC, not music", () => {
    // The distinction that matters. Both conventions use a note glyph, so the
    // presence of transcribed words is what separates them — and getting this
    // backwards would throw away the words of every song in the edit.
    expect(kindOfCueText("♪ I walked all night to find you ♪")).toBe("lyric");
    expect(kindOfCueText("♫ and I would walk five hundred miles ♫")).toBe("lyric");
  });

  it("calls a bare note glyph MUSIC", () => {
    expect(kindOfCueText("♪")).toBe("music");
    expect(kindOfCueText("♪♪♪")).toBe("music");
    expect(kindOfCueText("  ♫  ")).toBe("music");
  });

  it("reads the common bracketed annotations", () => {
    expect(kindOfCueText("[MUSIC]")).toBe("music");
    expect(kindOfCueText("(music playing)")).toBe("music");
    expect(kindOfCueText("[Theme music]")).toBe("music");
    expect(kindOfCueText("[INAUDIBLE]")).toBe("inaudible");
    expect(kindOfCueText("(crosstalk)")).toBe("inaudible");
    expect(kindOfCueText("[indistinct chatter]")).toBe("inaudible");
  });

  it("treats an unrecognised annotation as a sound effect, not as speech", () => {
    // "[door slams]" is the commonest shape there is and matches no keyword
    // list worth maintaining. It is still not somebody talking.
    expect(kindOfCueText("[door slams]")).toBe("sfx");
    expect(kindOfCueText("(footsteps approaching)")).toBe("sfx");
    expect(kindOfCueText("[APPLAUSE]")).toBe("sfx");
  });

  it("leaves ordinary speech alone", () => {
    expect(kindOfCueText("So the thing about that is nobody asked me.")).toBeNull();
    expect(kindOfCueText("")).toBeNull();
    expect(kindOfCueText("   ")).toBeNull();
  });

  it("does not classify a sentence that merely MENTIONS music", () => {
    // The line is somebody talking about music. Tagging it as a music bed
    // would pull real dialogue out of the transcript.
    expect(kindOfCueText("I love the music in this scene.")).toBeNull();
    expect(kindOfCueText("The applause went on for ages.")).toBeNull();
    expect(kindOfCueText("It was inaudible from where I was sitting.")).toBeNull();
  });

  it("only treats a FULLY bracketed cue as an annotation", () => {
    // A bracket mid-sentence is an aside, not a sound cue.
    expect(kindOfCueText("He said [inaudible] and then left.")).toBeNull();
  });
});

describe("kindOfName", () => {
  it("recognises what a user would actually type", () => {
    expect(kindOfName("Music")).toBe("music");
    expect(kindOfName("  LYRICS ")).toBe("lyric");
    expect(kindOfName("Sound effects")).toBe("sfx");
    expect(kindOfName("Inaudible")).toBe("inaudible");
  });

  it("matches the WHOLE name, never a substring", () => {
    // "Music supervisor" is a person, and so is anyone called Musick.
    expect(kindOfName("Music supervisor")).toBeNull();
    expect(kindOfName("Musick")).toBeNull();
    expect(kindOfName("Harry Jowsey")).toBeNull();
    expect(kindOfName("")).toBeNull();
    expect(kindOfName(null)).toBeNull();
  });
});

describe("built-in tags", () => {
  it("round-trips every kind", () => {
    for (const k of NON_SPEECH_KINDS) {
      expect(kindOfTag(kindTag(k))).toBe(k);
    }
  });

  it("carries no digit, so it cannot claim a cast colour", () => {
    // speakerColorIndex derives a palette slot from the first digit in a tag.
    // A tag like KIND_2 would silently take a hue meant for a person.
    for (const k of NON_SPEECH_KINDS) {
      expect(kindTag(k)).not.toMatch(/\d/);
    }
  });

  it("returns null for an ordinary speaker tag", () => {
    expect(kindOfTag("SPEAKER_04")).toBeNull();
    expect(kindOfTag("CAST_A")).toBeNull();
    expect(kindOfTag(null)).toBeNull();
    expect(kindOfTag("KIND_NOTAREALKIND")).toBeNull();
  });

  it("has a label for every kind", () => {
    for (const k of NON_SPEECH_KINDS) {
      expect(KIND_LABEL[k]).toBeTruthy();
    }
  });
});

describe("speakerKind", () => {
  it("prefers the tag over the name", () => {
    // A built-in group renamed "Harry" is still the music group.
    expect(speakerKind(kindTag("music"), "Harry Jowsey")).toBe("music");
  });

  it("falls back to the name for an ordinary tag", () => {
    expect(speakerKind("SPEAKER_02", "Music")).toBe("music");
  });

  it("is null for a person", () => {
    expect(speakerKind("SPEAKER_02", "Harry Jowsey")).toBeNull();
  });
});

describe("the non-speech colour", () => {
  it("is not one of the twelve cast hues", () => {
    // The palette exists to tell PEOPLE apart and was searched to stay mutually
    // distinguishable. A music bed eating a slot makes the cast harder to read
    // for no gain.
    expect(SPEAKER_PALETTE.map((c) => c.toLowerCase()))
      .not.toContain(NON_SPEECH_COLOR.toLowerCase());
  });
});

describe("countKinds", () => {
  it("counts what a transcript declares, for an offer rather than a rewrite", () => {
    const got = countKinds([
      "[MUSIC]", "♪ I walked all night ♪", "Hello there.",
      "[door slams]", "(music playing)", "[INAUDIBLE]", "Regular speech.",
    ]);
    expect(got).toEqual({ music: 2, lyric: 1, sfx: 1, inaudible: 1 });
  });

  it("counts nothing in a transcript of pure speech", () => {
    expect(countKinds(["Hello.", "How are you?", ""]))
      .toEqual({ music: 0, lyric: 0, sfx: 0, inaudible: 0 });
  });
});
