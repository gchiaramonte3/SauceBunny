import { describe, expect, it } from "vitest";
import { humanizeSpeakerTag } from "../components/transcript/helpers";
import { kindTag, KIND_LABEL, NON_SPEECH_KINDS } from "./speech-kind";

describe("humanizeSpeakerTag — tags this app mints must never be shown raw", () => {
  it("names an unnamed split instead of printing CAST_A", () => {
    // A speaker pulled out of somebody else's dialogue gets a CAST_* tag. If
    // the naming sheet is cancelled, the roster used to read "CAST_A" next to
    // "Harry Jowsey" — which from the outside is indistinguishable from a bug.
    expect(humanizeSpeakerTag("CAST_A")).toBe("New speaker A");
    expect(humanizeSpeakerTag("CAST_AA")).toBe("New speaker AA");
  });

  it("keeps two unnamed splits distinguishable", () => {
    expect(humanizeSpeakerTag("CAST_A")).not.toBe(humanizeSpeakerTag("CAST_B"));
  });

  it("names every built-in non-speech group", () => {
    // Normally these carry an explicit name override, but a doc hand-edited
    // on disk or written by an older build may not.
    for (const k of NON_SPEECH_KINDS) {
      expect(humanizeSpeakerTag(kindTag(k)), k).toBe(KIND_LABEL[k]);
    }
  });

  it("still handles the diarizer's own tags", () => {
    expect(humanizeSpeakerTag("SPEAKER_00")).toBe("Speaker 1");
    expect(humanizeSpeakerTag("SPEAKER_UNK")).toBe("Unknown speaker");
    expect(humanizeSpeakerTag(null)).toBe("Speaker");
    expect(humanizeSpeakerTag(null, { unknownWhenNull: true })).toBe("Unknown speaker");
  });

  it("leaves a genuinely unknown tag alone rather than inventing a name", () => {
    expect(humanizeSpeakerTag("HOST")).toBe("HOST");
    expect(humanizeSpeakerTag("KIND_NOTAKIND")).toBe("KIND_NOTAKIND");
  });
});
