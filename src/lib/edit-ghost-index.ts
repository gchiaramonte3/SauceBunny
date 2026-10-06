import type { Ghost, TimelineParagraph } from "./edit-model";

/**
 * Removed lines by the segment they go back before, built once per edit. The
 * text used to filter every removed line for every paragraph it drew, and drew
 * the ones after the last kept piece outside the windowed pages, all at once.
 */
export type GhostIndex = { byAt: Map<number, Ghost[]>; last: number };

export function indexGhosts(ghosts: Ghost[] | null): GhostIndex {
  const byAt = new Map<number, Ghost[]>();
  for (const ghost of ghosts ?? []) byAt.set(ghost.at, [...(byAt.get(ghost.at) ?? []), ghost]);
  return { byAt, last: Math.max(-1, ...byAt.keys()) };
}

/** The removed lines that go back after segment `after` and up to segment `upTo`. */
export function ghostsIn({ byAt, last }: GhostIndex, after: number, upTo: number): Ghost[] {
  const out: Ghost[] = [];
  for (let at = after + 1; at <= Math.min(upTo, last); at++) out.push(...(byAt.get(at) ?? []));
  return out;
}

/** The removed lines drawn above paragraph `n`: the cut before its first word, unless that word carries on the previous one's segment. */
export function ghostsAbove(paragraphs: TimelineParagraph[], index: GhostIndex, n: number): Ghost[] {
  const previous = n ? paragraphs[n - 1].words[paragraphs[n - 1].words.length - 1] : null, first = paragraphs[n].words[0];
  return ghostsIn(index, previous?.segment ?? -1, previous && previous.segment === first.segment ? -1 : first.segment);
}

/** Each paragraph's size for the windowed pages: its words, and the removed lines drawn above it. */
export function paragraphSizes(paragraphs: TimelineParagraph[], index: GhostIndex): number[] {
  return paragraphs.map((paragraph, n) => paragraph.words.length + ghostsAbove(paragraphs, index, n).reduce((sum, ghost) => sum + ghost.words.length, 0));
}
