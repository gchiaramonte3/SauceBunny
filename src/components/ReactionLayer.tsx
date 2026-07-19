import { useEffect, useState } from "react";
import type { LiveReaction } from "../hooks/use-co-review";
import { reactionGlyph, reactionLabel } from "../lib/reactions";

/**
 * The stage's live-reaction overlay: transient emotes float up the LEFT
 * edge (the Meet pattern - never over center-screen content) with the
 * sender's name riding along, then fade. Purely presentational; the feed
 * arrives pruned from use-co-review. Reduced motion swaps the float for a
 * quiet fade-in-place. A polite live region announces each reaction for
 * screen readers ("Nika reacted with applause").
 */
export function ReactionLayer({ reactions, nameFor }: {
  reactions: LiveReaction[];
  nameFor: (memberId: string) => string;
}) {
  // Announce only the newest reaction; coalescing beyond that is overkill
  // at 2-6 participants.
  const [announce, setAnnounce] = useState("");
  const latest = reactions.length > 0 ? reactions[reactions.length - 1] : null;
  useEffect(() => {
    if (!latest) return;
    setAnnounce(`${nameFor(latest.from)} reacted with ${reactionLabel(latest.emote)}`);
  }, [latest, nameFor]);

  return (
    <div className="cp-reactions-layer" aria-hidden={reactions.length === 0}>
      {reactions.map((r, i) => (
        <span
          key={r.id}
          className="cp-reaction-float"
          style={{ ["--rx" as string]: `${(r.id % 5) * 14}px`, ["--rd" as string]: `${(i % 3) * 180}ms` }}
        >
          <span className="cp-reaction-glyph">{reactionGlyph(r.emote)}</span>
          <span className="cp-reaction-name">{nameFor(r.from)}</span>
        </span>
      ))}
      <span className="cp-visually-hidden" role="status" aria-live="polite">{announce}</span>
    </div>
  );
}
