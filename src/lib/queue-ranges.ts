import type { QueuedClip, QueueSource } from "../types";

/**
 * Which queued clips belong to the source currently loaded.
 *
 * The timeline draws a shaded band for every queued range. It used to draw
 * ALL of them: queue a clip from one video, load another, and the new video's
 * timeline showed the first one's in/out — which reads as "this fresh link
 * already has marks on it", because from the outside there is no way to tell a
 * queued band from your own selection.
 *
 * It is worse than a cosmetic mix-up, and `QueuedClip` says why in its own
 * type: the item stores the fps it was added at because "ALL frames→seconds/tc
 * math for this item must use it, never the live player fps (which may belong
 * to another source)". A band drawn from raw frames against a different
 * source's fps and duration is not even in the right place for the clip it
 * came from — a mark at 5s in a 25fps source lands somewhere else entirely in a
 * 30fps one.
 *
 * The queue is deliberately cross-source (it survives switches, and Export All
 * handles mixed queues), so the fix is not to scope the queue — it is to draw
 * only what belongs to what you are looking at.
 */
export function sameQueueSource(a: QueueSource, b: QueueSource): boolean {
  if (a.kind === "file" && b.kind === "file") return a.path === b.path;
  if (a.kind === "web" && b.kind === "web") return a.url === b.url;
  return false;
}

/** The loaded source as a QueueSource, or null when nothing is loaded. */
export function currentQueueSource(
  sourceKind: string,
  localFilePath: string | null,
  webpageUrl: string | null | undefined,
): QueueSource | null {
  if (sourceKind === "file") return localFilePath ? { kind: "file", path: localFilePath } : null;
  return webpageUrl ? { kind: "web", url: webpageUrl } : null;
}

/**
 * Queued clips to draw on the timeline. Nothing loaded means nothing to draw:
 * bands with no source to sit against are the bug, not a useful default.
 */
export function queuedRangesForSource(queue: QueuedClip[], current: QueueSource | null): QueuedClip[] {
  if (!current) return [];
  return queue.filter((c) => sameQueueSource(c.source, current));
}
