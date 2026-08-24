/**
 * Ghost cursors — peer playheads during a co-review session — held OUTSIDE
 * React, on the playhead-store pattern, and for the same reason: they tick
 * at up to 3 Hz per peer, and as App-level state every tick re-rendered the
 * whole keep-alive App tree, including two unvirtualized transcript viewers.
 * A CTO-level audit measured presence-attributed App commits at ~3/sec with
 * a host ALONE in a paused room, ~11/sec worst case with a full one, for
 * the entire life of a session. Only the Timeline leaf that paints the
 * ghosts subscribes now; nothing else re-renders.
 *
 * The prune is deliberately allocation-shy: it returns the SAME array (and
 * notifies nobody) when nothing has expired. The previous inline version
 * filtered into a fresh array every 350ms tick, which defeated React's
 * bail-out and was itself the idle churn.
 */

export type GhostCursor = { name: string; position: number; at: number };

/** How long a silent peer's ghost lingers before the prune drops it. */
export const GHOST_TTL_MS = 5000;

let ghosts: GhostCursor[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

export function subscribeGhosts(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Stable identity between notifications — useSyncExternalStore's contract.
 *  Every mutation below replaces the array; nothing else does. */
export function getGhosts(): GhostCursor[] {
  return ghosts;
}

/** A presence beat from one peer: replace their ghost, drop any expired. */
export function upsertGhost(name: string, position: number, now: number): void {
  ghosts = [
    ...ghosts.filter((g) => g.name !== name && now - g.at < GHOST_TTL_MS),
    { name, position, at: now },
  ];
  notify();
}

/** Drop ghosts whose sender has gone quiet. Bails without allocating or
 *  notifying when nothing expired, which is the common case ~3x a second. */
export function pruneGhosts(now: number): void {
  if (!ghosts.some((g) => now - g.at >= GHOST_TTL_MS)) return;
  ghosts = ghosts.filter((g) => now - g.at < GHOST_TTL_MS);
  notify();
}

/** Session over — the timeline must not show a room that no longer exists. */
export function clearGhosts(): void {
  if (ghosts.length === 0) return;
  ghosts = [];
  notify();
}

/** How often a peer whose playhead is NOT moving re-announces itself. Well
 *  under GHOST_TTL_MS so a parked ghost never flickers out on the others'
 *  screens, while cutting idle presence traffic ~7x. */
export const PRESENCE_KEEPALIVE_MS = 2000;

/**
 * Whether this 350ms presence tick is worth a message. Moving playhead:
 * every tick (the ghost is animating on other screens). Parked: only the
 * keepalive beat. The threshold is half a frame at 60fps, so a paused
 * frame-step still announces immediately.
 */
export function shouldSendPresence(
  lastSentPosition: number,
  position: number,
  lastSentAt: number,
  now: number,
): boolean {
  if (Math.abs(position - lastSentPosition) > 1 / 120) return true;
  return now - lastSentAt >= PRESENCE_KEEPALIVE_MS;
}
