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
  return REACTION_EMOTES.find((e) => e.key === emote)?.label ?? emote;
}

/** Comment-reaction palette (the review panel's emoji set). */
export const COMMENT_REACTION_EMOJI: readonly string[] = [
  "\u{1F44D}", "❤️", "\u{1F602}", "\u{1F62E}", "\u{1F389}", "❓",
];
