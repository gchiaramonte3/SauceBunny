import { describe, it, expect } from "vitest";
import { deriveOnboardingSteps, onboardingComplete, type OnboardingSignals } from "./onboarding";

const signals = (over: Partial<OnboardingSignals>): OnboardingSignals => ({
  recentsCount: 0,
  exportFolder: null,
  transcriptCount: 0,
  ...over,
});

describe("deriveOnboardingSteps", () => {
  it("all pending on a fresh install", () => {
    const steps = deriveOnboardingSteps(signals({}));
    expect(steps.map((s) => s.id)).toEqual(["source", "folder", "transcript"]);
    expect(steps.every((s) => !s.done)).toBe(true);
    expect(onboardingComplete(steps)).toBe(false);
  });

  it("source step derives from the recents count", () => {
    expect(deriveOnboardingSteps(signals({ recentsCount: 1 }))[0].done).toBe(true);
    expect(deriveOnboardingSteps(signals({ recentsCount: 0 }))[0].done).toBe(false);
  });

  it("folder step derives from the export-folder value, empty string = unset", () => {
    expect(deriveOnboardingSteps(signals({ exportFolder: "/Users/me/Movies" }))[1].done).toBe(true);
    expect(deriveOnboardingSteps(signals({ exportFolder: "" }))[1].done).toBe(false);
    expect(deriveOnboardingSteps(signals({ exportFolder: null }))[1].done).toBe(false);
  });

  it("transcript step derives from transcript-history count", () => {
    expect(deriveOnboardingSteps(signals({ transcriptCount: 3 }))[2].done).toBe(true);
    expect(deriveOnboardingSteps(signals({ transcriptCount: 0 }))[2].done).toBe(false);
  });

  it("onboardingComplete only when every step is done", () => {
    const partial = deriveOnboardingSteps(signals({ recentsCount: 2, exportFolder: "/tmp" }));
    expect(onboardingComplete(partial)).toBe(false);
    const all = deriveOnboardingSteps(
      signals({ recentsCount: 2, exportFolder: "/tmp", transcriptCount: 1 }),
    );
    expect(onboardingComplete(all)).toBe(true);
  });
});
