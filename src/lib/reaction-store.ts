import { useMemo, useSyncExternalStore } from "react";
import { reactionGlyph } from "./reactions";

/**
 * Live reactions, held OUTSIDE React on the ghost-store/playhead-store
 * pattern, for the same measured reason: each emote used to run two App
 * setStates (append, then a 5.2s timed removal), so a 12-emote applause
 * burst was ~24 full App-tree renders on every machine in the room, stacked
 * on presence churn, exactly while video plays. Only the two leaves that
 * paint reactions subscribe now: ReactionLayer (the floating emotes) and
 * PeoplePanel (the per-tile flash).
 *
 * The feed is fire-and-forget and self-pruning, which is what makes it a
 * clean store: nothing ever reads a reaction back for logic.
 */

export type LiveReaction = {
  id: number;
  /** Member id of the sender ("m0" = host). */
  from: string;
  name: string;
  emote: string;
  at: number;
};

/** How long a reaction floats before it is dropped. Matches the CSS float
 *  animation with a beat of slack, as before. */
export const REACTION_TTL_MS = 5200;
/** The feed keeps at most this many in flight - an applause burst stays
 *  bounded no matter how enthusiastic the room. */
const MAX_LIVE = 24;

let reactions: LiveReaction[] = [];
let nextId = 0;
const listeners = new Set<() => void>();
const timers = new Set<ReturnType<typeof setTimeout>>();

function notify(): void {
  for (const l of listeners) l();
}

export function subscribeReactions(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Stable identity between notifications (useSyncExternalStore contract). */
export function getReactions(): LiveReaction[] {
  return reactions;
}

/** Add a reaction to the feed; it removes itself after REACTION_TTL_MS. */
export function pushReaction(r: Omit<LiveReaction, "id">): void {
  const withId = { ...r, id: ++nextId };
  reactions = [...reactions.slice(-(MAX_LIVE - 1)), withId];
  notify();
  const t = setTimeout(() => {
    timers.delete(t);
    reactions = reactions.filter((x) => x.id !== withId.id);
    notify();
  }, REACTION_TTL_MS);
  timers.add(t);
}

/** Session over - nothing should keep floating over a dead room. */
export function clearReactions(): void {
  for (const t of timers) clearTimeout(t);
  timers.clear();
  nextId = 0;
  if (reactions.length === 0) return;
  reactions = [];
  notify();
}

/** Subscribe a component to the live feed. */
export function useReactions(): LiveReaction[] {
  return useSyncExternalStore(subscribeReactions, getReactions);
}

/** memberId -> glyph for the tile flash, newest reaction per member wins.
 *  Derived per subscriber rather than in App, which is the point: the map
 *  changing must re-render the People tiles, not the world. */
export function useReactionFlashes(): ReadonlyMap<string, string> {
  const live = useReactions();
  return useMemo(() => {
    const m = new Map<string, string>();
    for (const r of live) m.set(r.from, reactionGlyph(r.emote));
    return m;
  }, [live]);
}
