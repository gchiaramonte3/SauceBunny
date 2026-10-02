import { loadJson, saveJson } from "./storage";

export type MultitrackTranscriptionOptions = { fast: boolean; speechOnly: boolean };
const KEY = "saucebunny.multitrackTranscriptionOptions";

export function loadMultitrackTranscriptionOptions(): MultitrackTranscriptionOptions {
  const value = loadJson<Partial<MultitrackTranscriptionOptions> | null>(KEY, null);
  return { fast: value?.fast === true, speechOnly: value?.speechOnly === true };
}

export function saveMultitrackTranscriptionOptions(options: MultitrackTranscriptionOptions): void {
  saveJson(KEY, options);
}
