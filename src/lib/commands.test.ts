import { describe, expect, it } from "vitest";
import { scoreCommand, type Command } from "./commands";

const cmd = (over: Partial<Command>): Command => ({
  id: "test",
  label: "Test command",
  group: "App",
  run: () => {},
  ...over,
});

describe("scoreCommand", () => {
  it("shows everything on an empty query", () => {
    expect(scoreCommand(cmd({}), "")).toBe(1);
    expect(scoreCommand(cmd({}), "   ")).toBe(1);
  });

  it("ranks an exact label substring above a keyword hit", () => {
    const labelHit = scoreCommand(cmd({ label: "Toggle queue" }), "queue");
    const kwHit = scoreCommand(
      cmd({ label: "Export clip", keywords: ["queue"] }),
      "queue",
    );
    expect(labelHit).toBeGreaterThan(kwHit);
    expect(kwHit).toBeGreaterThan(0);
  });

  // r85 review: the in-order-label gate zeroed keyword-only matches, making
  // the documented `keywords` field (and palette keyword search) dead.
  it("keyword-only matches survive the label gate", () => {
    const c = cmd({ label: "Toggle queue", keywords: ["clips", "drawer"] });
    expect(scoreCommand(c, "clips")).toBeGreaterThan(0);
    expect(scoreCommand(c, "drawer")).toBeGreaterThan(0);
  });

  it("description and group text are searchable", () => {
    const c = cmd({ label: "Mark in", description: "set the selection start", group: "Marks" });
    expect(scoreCommand(c, "selection")).toBeGreaterThan(0);
    expect(scoreCommand(c, "marks")).toBeGreaterThan(0);
  });

  it("zeroes out pure misses", () => {
    expect(scoreCommand(cmd({ label: "Mark in" }), "zzzz")).toBe(0);
  });

  it("fuzzy in-order label chars match without a substring hit", () => {
    // "mi" → M(ark) i(n): word-start bonus applies.
    expect(scoreCommand(cmd({ label: "Mark in" }), "mi")).toBeGreaterThan(0);
  });
});
