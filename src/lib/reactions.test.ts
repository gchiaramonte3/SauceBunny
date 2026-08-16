import { describe, expect, it } from "vitest";
import {
  COMMENT_REACTION_EMOJI, HAND_GLYPH, REACTION_EMOTES, reactionGlyph, reactionLabel,
} from "./reactions";

/**
 * The registry the picker, the floaters, the tile badges and the review panel
 * all read, so that they agree.
 *
 * Both lookups take a key that arrived over the wire (SessionMsg.Reaction.emote)
 * and they fail differently on purpose: the glyph falls CLOSED to ✨, because
 * rendering an arbitrary peer string as a glyph would put anything at all over
 * the picture; the label falls through, because a newer peer's "party" reads
 * better than silence. That second path ends in an aria-live announcement, so
 * it is length-bounded — the asymmetry is deliberate, but only one side of it
 * can be any length.
 */

describe("known reactions", () => {
  it("resolves every registered emote", () => {
    for (const e of REACTION_EMOTES) {
      expect(reactionGlyph(e.key)).toBe(e.glyph);
      expect(reactionLabel(e.key)).toBe(e.label);
    }
  });

  it("has no duplicate keys or glyphs", () => {
    // A duplicate key would make the picker send one thing and show another.
    expect(new Set(REACTION_EMOTES.map((e) => e.key)).size).toBe(REACTION_EMOTES.length);
    expect(new Set(REACTION_EMOTES.map((e) => e.glyph)).size).toBe(REACTION_EMOTES.length);
  });

  it("keeps raise-hand out of the transient set", () => {
    // It is persistent state, not a floater; listing it here would make it
    // float away while the hand stays up.
    expect(REACTION_EMOTES.some((e) => e.glyph === HAND_GLYPH)).toBe(false);
  });

  it("offers a comment palette with no blanks", () => {
    expect(COMMENT_REACTION_EMOJI.length).toBeGreaterThan(3);
    for (const e of COMMENT_REACTION_EMOJI) expect(e.trim()).not.toBe("");
    expect(new Set(COMMENT_REACTION_EMOJI).size).toBe(COMMENT_REACTION_EMOJI.length);
  });
});

describe("a key this build does not know", () => {
  it("draws a safe glyph rather than the peer's string", () => {
    expect(reactionGlyph("party")).toBe("✨");
    expect(reactionGlyph("")).toBe("✨");
    expect(reactionGlyph("<img src=x>")).toBe("✨");
  });

  it("still announces a newer peer's reaction by name", () => {
    // Forward compatibility: silence would be worse than an unfamiliar word.
    expect(reactionLabel("party")).toBe("party");
  });

  it("bounds what a peer can put in the live region", () => {
    const long = "Bartholomew".repeat(20);
    const out = reactionLabel(long);
    expect(out.length).toBeLessThanOrEqual(25);
    expect(out.endsWith("…")).toBe(true);
  });

  it("says something for an empty or blank key", () => {
    expect(reactionLabel("")).toBe("a reaction");
    expect(reactionLabel("   ")).toBe("a reaction");
  });
});
