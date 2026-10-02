// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { shotIntelligenceEnabled } from "./rollout";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  localStorage.removeItem("saucebunny.shotIntelligence.preview");
});

describe("shot intelligence rollout", () => {
  it("keeps an ordinary build off by default", () => {
    vi.stubEnv("VITE_SHOT_INTELLIGENCE_PREVIEW", "");
    expect(shotIntelligenceEnabled()).toBe(false);
  });
  it("exposes an explicitly requested preview build without writing preferences", () => {
    vi.stubEnv("VITE_SHOT_INTELLIGENCE_PREVIEW", "1");
    expect(shotIntelligenceEnabled()).toBe(true);
    expect(localStorage.getItem("saucebunny.shotIntelligence.preview")).toBeNull();
  });
  it("requires the exact build opt-in value", () => {
    vi.stubEnv("VITE_SHOT_INTELLIGENCE_PREVIEW", "true");
    expect(shotIntelligenceEnabled()).toBe(false);
  });
  it("retains the existing explicit local opt-in", () => {
    vi.stubEnv("VITE_SHOT_INTELLIGENCE_PREVIEW", "");
    localStorage.setItem("saucebunny.shotIntelligence.preview", "1");
    expect(shotIntelligenceEnabled()).toBe(true);
  });
  it("handles unavailable storage without enabling an ordinary build", () => {
    vi.stubEnv("VITE_SHOT_INTELLIGENCE_PREVIEW", "");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Unavailable"); });
    expect(shotIntelligenceEnabled()).toBe(false);
    vi.stubEnv("VITE_SHOT_INTELLIGENCE_PREVIEW", "1");
    expect(shotIntelligenceEnabled()).toBe(true);
  });
});
