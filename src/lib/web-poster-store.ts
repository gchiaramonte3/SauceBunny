// Per-URL captured posters for web sources that have no URL-derived thumbnail
// (i.e. non-YouTube — YouTube already yields i.ytimg.com/…/hqdefault.jpg from the
// id alone). A frame grabbed from the loaded web player (PlayerHandle
// getPosterDataUrl) is stored here as a small JPEG data URL, so a transcript /
// source row for that web source shows a real picture instead of a glyph.
//
// Stored in localStorage, LRU-capped so it can't balloon the quota. Small: an
// ~480px JPEG at q0.7 is ~15–30 KB, ×MAX ≈ a couple MB worst case.

const KEY = "saucebunny.webPosters";
const MAX = 80;
export const WEB_POSTERS_CHANGED_EVENT = "saucebunny:web-posters-changed";

/** `order` = URLs oldest→newest for LRU eviction; `map` = url → JPEG data URL. */
type Store = { order: string[]; map: Record<string, string> };

function read(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { order: [], map: {} };
    const p = JSON.parse(raw) as Partial<Store>;
    const map = p.map && typeof p.map === "object" ? (p.map as Record<string, string>) : {};
    const order = Array.isArray(p.order)
      ? p.order.filter((u) => typeof u === "string" && u in map)
      : Object.keys(map);
    return { order, map };
  } catch {
    return { order: [], map: {} };
  }
}

function write(s: Store): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* quota / disabled — ignore */ }
}

/** The captured poster data URL for a web source, or null if none stored. */
export function webPosterFor(url: string | null | undefined): string | null {
  if (!url) return null;
  return read().map[url] ?? null;
}

/** Store (or refresh) a web source's captured poster, LRU-evicting the oldest. */
export function setWebPoster(url: string, dataUrl: string): void {
  if (!url || !dataUrl) return;
  const s = read();
  s.order = s.order.filter((u) => u !== url); // de-dup, then push as newest
  s.order.push(url);
  s.map[url] = dataUrl;
  while (s.order.length > MAX) {
    const evict = s.order.shift();
    if (evict) delete s.map[evict];
  }
  write(s);
  try { window.dispatchEvent(new CustomEvent(WEB_POSTERS_CHANGED_EVENT)); } catch { /* non-DOM env */ }
}
