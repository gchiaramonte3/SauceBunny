import { describe, expect, it } from "vitest";
import { matchPrompts, slashQuery, TRANSCRIPT_PROMPTS } from "./transcript-prompts";

describe("slashQuery — when the menu opens", () => {
  it("opens on a leading slash", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/quo")).toBe("quo");
    expect(slashQuery("/QUOTES")).toBe("quotes");
  });

  it("stays shut on a slash that is just punctuation", () => {
    // Popping a menu mid-sentence would be an ambush.
    expect(slashQuery("and/or")).toBeNull();
    expect(slashQuery("see https://example.com")).toBeNull();
    expect(slashQuery("the 9/11 report")).toBeNull();
    expect(slashQuery("")).toBeNull();
    expect(slashQuery("quotes")).toBeNull();
  });

  it("closes once you start writing the rest of the sentence", () => {
    // "/quotes about pricing" is a real question, not a command being typed.
    expect(slashQuery("/quotes about pricing")).toBeNull();
    expect(slashQuery("/ ")).toBeNull();
  });
});

describe("matchPrompts", () => {
  it("offers everything on a bare slash", () => {
    expect(matchPrompts("")).toHaveLength(TRANSCRIPT_PROMPTS.length);
  });

  it("ranks a prefix match above a substring match", () => {
    // "/c" should lead with the commands that START with c, not with whatever
    // happens to contain one.
    const got = matchPrompts("c").map((p) => p.id);
    const firstNonPrefix = got.findIndex((id) => !id.startsWith("c"));
    const lastPrefix = got.map((id) => id.startsWith("c")).lastIndexOf(true);
    if (firstNonPrefix >= 0) expect(lastPrefix).toBeLessThan(firstNonPrefix);
  });

  it("finds a command by its label as well as its id", () => {
    expect(matchPrompts("beat").map((p) => p.id)).toContain("timeline");
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(matchPrompts("zzzzz")).toEqual([]);
  });
});

describe("the prompts themselves", () => {
  it("has unique ids with no spaces or slashes", () => {
    const ids = TRANSCRIPT_PROMPTS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z]+$/);
  });

  it("gives every command a label, a hint and a real prompt", () => {
    for (const p of TRANSCRIPT_PROMPTS) {
      expect(p.label.trim(), p.id).toBeTruthy();
      expect(p.hint.trim(), p.id).toBeTruthy();
      // Long enough to actually steer a model. A one-word "prompt" is just
      // the label again and would produce the vague answer this exists to avoid.
      expect(p.prompt.length, p.id).toBeGreaterThan(40);
    }
  });

  it("asks for timestamps wherever timestamps make sense", () => {
    // The summary pane renders them as click-to-seek anchors, so an answer
    // that cites one is verifiable in a second and one that does not has to
    // be taken on faith.
    const timestamped = TRANSCRIPT_PROMPTS.filter((p) => /timestamp|in-point|timecode/i.test(p.prompt));
    expect(timestamped.length).toBeGreaterThanOrEqual(TRANSCRIPT_PROMPTS.length - 3);
  });

  it("tells the model to say so rather than invent, where invention is the risk", () => {
    // Action items are the prompt most likely to hallucinate commitments
    // nobody made, which is the one wrong answer with real-world consequences.
    const actions = TRANSCRIPT_PROMPTS.find((p) => p.id === "actions")!;
    expect(actions.prompt).toMatch(/say so|rather than inventing/i);
  });

  it("uses no em-dashes, per the app's voice contract", () => {
    for (const p of TRANSCRIPT_PROMPTS) {
      expect(`${p.label} ${p.hint} ${p.prompt}`, p.id).not.toMatch(/—/);
    }
  });
});
