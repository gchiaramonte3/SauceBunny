import { describe, expect, it } from "vitest";
import { answer, linesOf, mentionOptions, mentionQuery, parseMentions, type TeAgentContext } from "./transcript-editor-agent";
import { teSources, teSpeakers, teWholeScene, teWords } from "./transcript-editor-fixture";
import { placeWords } from "./transcript-editor-model";

const context: TeAgentContext = { words: teWords, placed: placeWords(teWords, teWholeScene()), speakers: teSpeakers, sources: teSources };
const text = (line: { words: { text: string }[] }) => line.words.map((word) => word.text).join(" ");

describe("Ask, the scripted stand-in", () => {
  it("offers the edit, every source and every speaker after an @, and reads them back out of a message", () => {
    const options = mentionOptions(context);
    expect(options.map((option) => option.token)).toEqual(expect.arrayContaining(["@edit", "@Kitchen", "@Judges", "@ITM", "@Rosa", "@ChefLaurent"]));
    expect(parseMentions("pull every line from @rosa in @ITM", options).map((option) => option.id)).toEqual(["itm", "rosa"]);
  });

  it("knows when the caret is inside an @word, and where it starts", () => {
    expect(mentionQuery("find onions in @Kit", 19)).toEqual({ start: 15, query: "kit" });
    expect(mentionQuery("email@example", 13)).toBeNull();
    expect(mentionQuery("find onions", 11)).toBeNull();
  });

  it("finds a phrase only in the sources it was pointed at", () => {
    const all = answer("find “onions”", context);
    expect(new Set(all.lines.map((line) => line.source))).toEqual(new Set(["mg3", "mg1", "itm"]));
    const judges = answer("find “onions” in @Judges", context);
    expect(judges.lines.length).toBeGreaterThan(0);
    expect(judges.lines.every((line) => line.source === "mg1")).toBe(true);
    expect(judges.proposal?.kind).toBe("insert");
  });

  it("pulls every line from a person as a proposal, not a change", () => {
    const reply = answer("pull every line from @Rosa in @ITM", context);
    expect(reply.lines).toHaveLength(linesOf(teWords.filter((word) => word.source === "itm")).length);
    expect(reply.lines.every((line) => line.speaker === "rosa")).toBe(true);
    expect(reply.proposal).toMatchObject({ kind: "insert" });
  });

  it("proposes filler removals from the edit only, and leaves 'like' alone when it is a verb", () => {
    const reply = answer("remove the fillers from @edit", context);
    expect(reply.proposal?.kind).toBe("delete");
    const found = reply.lines.map(text);
    expect(found).toEqual(expect.arrayContaining(["Um,", "like,"]));
    expect(found).not.toContain("like");
  });

  it("summarizes and otherwise explains what it can do", () => {
    expect(answer("summarize @Judges", context).text).toMatch(/^MG 1 Judges: \d+ lines/);
    expect(answer("hello", context).text).toContain("@Kitchen");
  });
});
