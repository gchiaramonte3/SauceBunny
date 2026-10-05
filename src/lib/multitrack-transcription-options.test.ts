// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { loadMultitrackTranscriptionOptions, saveMultitrackTranscriptionOptions } from "./multitrack-transcription-options";

beforeEach(() => localStorage.clear());
it("preserves the accuracy default and validates stored booleans", () => {
  // Cast names start off: they can respell a word, so they are asked for.
  expect(loadMultitrackTranscriptionOptions()).toEqual({ fast: false, speechOnly: false, castNames: false });
  localStorage.setItem("saucebunny.multitrackTranscriptionOptions", JSON.stringify({ fast: "false", speechOnly: 1, castNames: "yes" }));
  expect(loadMultitrackTranscriptionOptions()).toEqual({ fast: false, speechOnly: false, castNames: false });
  saveMultitrackTranscriptionOptions({ fast: true, speechOnly: true, castNames: true });
  expect(loadMultitrackTranscriptionOptions()).toEqual({ fast: true, speechOnly: true, castNames: true });
});
