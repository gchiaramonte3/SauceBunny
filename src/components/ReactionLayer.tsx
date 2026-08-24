import { useEffect, useState } from "react";
import { useReactions } from "../lib/reaction-store";
import { reactionGlyph, reactionLabel } from "../lib/reactions";

/**
 * The stage's live-reaction overlay: transient emotes float up the LEFT
 * edge (the Meet pattern - never over center-screen content) with the
 * sender's name riding along, then fade. Purely presentational; the feed
 * arrives pruned from the reaction store, and this leaf is its only
 * floating-layer subscriber - an applause burst re-renders THIS component,
 * not the App tree it used to. Reduced motion swaps the float for a
 * quiet fade-in-place. A polite live region announces each reaction for
 * screen readers ("Nika reacted with applause").
 */
export function ReactionLayer() {
  const reactions = useReactions();
  // Announce only the newest reaction; coalescing beyond that is overkill
  // at 2-6 participants.
  const [announce, setAnnounce] = useState("");
  const latest = reactions.length > 0 ? reactions[reactions.length - 1] : null;
  useEffect(() => {
    if (!latest) return;
    setAnnounce(`${latest.name} reacted with ${reactionLabel(latest.emote)}`);
  }, [latest]);

  return (
    <div className="cp-reactions-layer" aria-hidden={reactions.length === 0}>
      {reactions.map((r, i) => (
        <span
          key={r.id}
          className="cp-reaction-float"
          style={{ ["--rx" as string]: `${(r.id % 5) * 14}px`, ["--rd" as string]: `${(i % 3) * 180}ms` }}
        >
          <span className="cp-reaction-glyph">{reactionGlyph(r.emote)}</span>
          <span className="cp-reaction-name">{r.name}</span>
        </span>
      ))}
      <span className="cp-visually-hidden" role="status" aria-live="polite">{announce}</span>
    </div>
  );
}
