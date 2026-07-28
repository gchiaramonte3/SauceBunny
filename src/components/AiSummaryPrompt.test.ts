// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./AiSummary";

const STYLE = { format: "bullets", length: "standard" } as const;
const build = (desc?: string | null) =>
  buildSystemPrompt("Hello there.", false, STYLE, false, desc);

describe("the source description in the system prompt", () => {
  it("is included when the site published one", () => {
    // Worth the tokens: a description routinely carries what a transcript
    // cannot — guests' spelled-out names, links, the creator's timestamps.
    const p = build("Guest: Ada Lovelace. Links below.");
    expect(p).toContain("Ada Lovelace");
    expect(p).toContain("SOURCE DESCRIPTION");
  });

  it("is labelled as context, not as truth", () => {
    // It is marketing copy written BEFORE the edit, so a model must not treat
    // it as a source of fact about what was actually said.
    expect(build("anything")).toMatch(/context only.*transcript is authoritative/i);
  });

  it("adds no section at all when there is none", () => {
    // Most of the web, and every local file. An empty header would be tokens
    // spent telling the model nothing.
    for (const empty of [undefined, null, "", "   "]) {
      expect(build(empty), String(empty)).not.toContain("SOURCE DESCRIPTION");
    }
  });

  it("is budgeted so a link farm cannot crowd out the transcript", () => {
    const huge = "spam ".repeat(5000);
    const p = build(huge);
    expect(p).toContain("=== TRANSCRIPT ===");
    expect(p).toContain("Hello there.");
    // The description section must stay far smaller than the raw input.
    expect(p.length).toBeLessThan(huge.length / 2);
  });

  it("keeps the transcript after the description, so it reads last", () => {
    const p = build("a description");
    expect(p.indexOf("SOURCE DESCRIPTION")).toBeLessThan(p.indexOf("=== TRANSCRIPT ==="));
  });
});
