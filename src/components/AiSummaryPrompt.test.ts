// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildTaskInstruction } from "./AiSummary";

const STYLE = { format: "bullets", length: "standard" } as const;
// The description moved from the system message to the task turn when the
// transcript became a shared, cacheable prefix; the assertions about it are
// unchanged, only where it is carried.
const build = (desc?: string | null) => buildTaskInstruction(STYLE, false, desc);

describe("the source description in the task instruction", () => {
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
    // The description section must stay far smaller than the raw input.
    expect(p.length).toBeLessThan(huge.length / 2);
    expect(p).toContain("SOURCE DESCRIPTION");
  });

  it("carries NO transcript, which is what makes the prefix reusable", () => {
    // Replaces an assertion that the transcript came after the description in
    // this same string. It used to, and that was the performance bug: the
    // transcript sat behind a header that changed with the style setting and
    // the description, so llama.cpp saw a new prefix and re-ingested ten
    // thousand tokens. The transcript now lives in buildSourcePrefix, alone,
    // and this side must stay free of it.
    const p = build("a description");
    expect(p).not.toContain("=== TRANSCRIPT ===");
  });
});
