/**
 * First-run "getting started" checklist for the Monitor empty state.
 *
 * Step completion is DERIVED from signals the app already persists — recents
 * (a source has loaded before), the export-folder setting, and transcript
 * history — so this module never duplicates state that could drift. The only
 * thing it stores (`saucebunny.onboarding`) is the manual "don't show again"
 * flag. The checklist hides itself once every step is done or the flag is set.
 */

import { loadJson, saveJson } from "./storage";

export type OnboardingStepId = "source" | "folder" | "transcript";

export type OnboardingStep = {
  id: OnboardingStepId;
  label: string;
  /** One-line pointer shown under the label (where/how to do the step). */
  hint: string;
  done: boolean;
};

/** Existing app signals the steps are derived from. */
export type OnboardingSignals = {
  /** Recent-sources count (lib/recent-sources) — >0 means a source loaded. */
  recentsCount: number;
  /** The export folder (session value or persisted default); ""/null = unset. */
  exportFolder: string | null;
  /** Transcript-history count (lib/transcript-history) — >0 means one exists. */
  transcriptCount: number;
};

export function deriveOnboardingSteps(s: OnboardingSignals): OnboardingStep[] {
  return [
    { id: "source",     label: "Load a source",
      hint: "The URL bar is at the top",
      done: s.recentsCount > 0 },
    { id: "folder",     label: "Set your export folder",
      hint: "Settings → General → Default folder",
      done: !!s.exportFolder },
    { id: "transcript", label: "Generate a transcript",
      hint: "Whisper runs locally — nothing leaves this Mac",
      done: s.transcriptCount > 0 },
  ];
}

export function onboardingComplete(steps: readonly OnboardingStep[]): boolean {
  return steps.every((s) => s.done);
}

// ── "Don't show again" flag (the ONLY persisted onboarding state) ───────────

const STORAGE_KEY = "saucebunny.onboarding";

type OnboardingPrefs = { dismissed: boolean };

export function loadOnboardingDismissed(): boolean {
  return loadJson<OnboardingPrefs>(STORAGE_KEY, { dismissed: false }).dismissed === true;
}

export function saveOnboardingDismissed(): void {
  saveJson(STORAGE_KEY, { dismissed: true } satisfies OnboardingPrefs);
}
