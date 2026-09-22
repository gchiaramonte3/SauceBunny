// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { loadMultitrackTranscriptionOptions, saveMultitrackTranscriptionOptions } from "./multitrack-transcription-options";

beforeEach(() => localStorage.clear());
it("preserves the accuracy default and validates stored booleans", () => {
  expect(loadMultitrackTranscriptionOptions()).toEqual({ fast: false, speechOnly: false });
  localStorage.setItem("saucebunny.multitrackTranscriptionOptions", JSON.stringify({ fast: "false", speechOnly: 1 }));
  expect(loadMultitrackTranscriptionOptions()).toEqual({ fast: false, speechOnly: false });
  saveMultitrackTranscriptionOptions({ fast: true, speechOnly: true });
  expect(loadMultitrackTranscriptionOptions()).toEqual({ fast: true, speechOnly: true });
});
