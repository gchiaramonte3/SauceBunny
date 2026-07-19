/**
 * Poster aspect handling (12a): portrait art must never be squeezed or
 * cropped into a 16:9 cell. Aspects are measured for free at each image's
 * onLoad (naturalWidth/Height - no extra probing) and remembered in a
 * module cache keyed by URL, so every surface (cards, hero, hover frames)
 * classifies the same poster once and agrees.
 */

export type ArtAspect = "landscape" | "portrait" | "square";

/** Square band keeps near-1:1 art from flapping between treatments. */
export function classifyAspect(width: number, height: number): ArtAspect {
  if (width <= 0 || height <= 0) return "landscape";
  const r = width / height;
  if (r < 0.9) return "portrait";
  if (r <= 1.1) return "square";
  return "landscape";
}

const cache = new Map<string, ArtAspect>();

export function rememberAspect(url: string, width: number, height: number): ArtAspect {
  const a = classifyAspect(width, height);
  if (cache.size > 500) cache.clear(); // tiny working set; wholesale reset
  cache.set(url, a);
  return a;
}
