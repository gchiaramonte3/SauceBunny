// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { matchPrompts, slashQuery, TRANSCRIPT_PROMPTS } from "../lib/transcript-prompts";

/**
 * The composer's slash behaviour, exercised through the pure functions it is
 * built on. AiSummary itself needs a model client, a transcript and a stream,
 * so mounting it to assert a menu would be testing the mocks; the decisions
 * that can actually be got wrong all live in these two functions plus the
 * keydown rules asserted below.
 */
describe("what Enter does", () => {
  it("has something to pick for every prefix a user would type", () => {
    // The failure this guards: with the menu OPEN and no hits, Enter must fall
    // through to sending rather than swallowing the keypress into nothing.
    for (const p of TRANSCRIPT_PROMPTS) {
      for (let n = 1; n <= p.id.length; n += 1) {
        expect(matchPrompts(p.id.slice(0, n)).length, `${p.id} @ ${n}`).toBeGreaterThan(0);
      }
    }
  });

  it("leaves the box in a sendable state once a command is picked", () => {
    // Picking replaces the input with the PROMPT, which must not itself look
    // like a command - or the menu would reopen and Enter would never send.
    for (const p of TRANSCRIPT_PROMPTS) {
      expect(slashQuery(p.prompt), p.id).toBeNull();
    }
  });
});

describe("command mode boundaries", () => {
  it("is off for every ordinary question someone might ask", () => {
    const asks = [
      "pull quotes about pricing",
      "what did they decide re: the launch date?",
      "summarize 00:12:30 to 00:18:00",
      "compare the before/after numbers",
      "check https://example.com/spec",
    ];
    for (const a of asks) expect(slashQuery(a), a).toBeNull();
  });

  it("is on the moment a slash is typed first, and off once a space follows", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/q")).toBe("q");
    expect(slashQuery("/quotes")).toBe("quotes");
    expect(slashQuery("/quotes ")).toBeNull();
  });
});
