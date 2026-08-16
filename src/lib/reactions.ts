/**
 * Live-reaction registry (the session room's Zoom/Meet-style emotes) and
 * the comment-reaction palette. One module so the picker, the floaters,
 * the tile badges, and the review panel all agree on glyphs and labels.
 */

export type ReactionEmote = {
  /** Wire id (SessionMsg.Reaction.emote). */
  key: string;
  glyph: string;
  label: string;
};

/** Transient reactions: float over the stage ~5s, badge the sender's tile. */
export const REACTION_EMOTES: readonly ReactionEmote[] = [
  { key: "applause", glyph: "\u{1F44F}", label: "Applause" },
  { key: "confetti", glyph: "\u{1F389}", label: "Confetti" },
  { key: "thumbsup", glyph: "\u{1F44D}", label: "Thumbs up" },
  { key: "question", glyph: "❓", label: "Question" },
];

/** Raise hand is PERSISTENT (stays until lowered), not a transient emote. */
export const HAND_GLYPH = "✋";

export function reactionGlyph(emote: string): string {
  return REACTION_EMOTES.find((e) => e.key === emote)?.glyph ?? "✨";
}

export function reactionLabel(emote: string): string {
  const known = REACTION_EMOTES.find((e) => e.key === emote)?.label;
  if (known) return known;
  // Unknown keys fall through on PURPOSE: a newer peer sending "party" should
  // announce as "party" rather than as nothing. But this is a peer's string
  // reaching a live region, so it is bounded — the glyph beside it already
  // fails closed to ✨, and a label that can be any length is the one half of
  // this pair that a modified build could abuse.
  const trimmed = emote.trim();
  if (!trimmed) return "a reaction";
  return trimmed.length > 24 ? `${trimmed.slice(0, 24)}…` : trimmed;
}

/** Comment-reaction palette (the review panel's emoji set). */
export const COMMENT_REACTION_EMOJI: readonly string[] = [
  "\u{1F44D}", "❤️", "\u{1F602}", "\u{1F62E}", "\u{1F389}", "❓",
];
