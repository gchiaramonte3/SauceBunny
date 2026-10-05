import { loadJson, saveJson } from "./storage";

/** `castNames`: tell the recognizer the mic owners' names (accuracy spec, phase 2). Off until the owner's scenes show it helps more than it swaps. */
export type MultitrackTranscriptionOptions = { fast: boolean; speechOnly: boolean; castNames: boolean };
const KEY = "saucebunny.multitrackTranscriptionOptions";

export function loadMultitrackTranscriptionOptions(): MultitrackTranscriptionOptions {
  const value = loadJson<Partial<MultitrackTranscriptionOptions> | null>(KEY, null);
  return { fast: value?.fast === true, speechOnly: value?.speechOnly === true, castNames: value?.castNames === true };
}

export function saveMultitrackTranscriptionOptions(options: MultitrackTranscriptionOptions): void {
  saveJson(KEY, options);
}
