// Per-URL captured posters for web sources that have no URL-derived thumbnail
// (i.e. non-YouTube — YouTube already yields i.ytimg.com/…/hqdefault.jpg from the
// id alone). A frame grabbed from the loaded web player (PlayerHandle
// getPosterDataUrl) is stored here as a small JPEG data URL, so a transcript /
// source row for that web source shows a real picture instead of a glyph.
//
// Stored in localStorage, LRU-capped BY BYTES so it can't balloon the quota.
//
// The cap used to count ENTRIES, with a sizing note that said "an ~480px JPEG
// at q0.7 is ~15-30 KB, xMAX ~ a couple MB worst case". That forgot the value
// is a base64 DATA URL, not the JPEG - about a third larger, plus the header.
// Measured against a real store: mean 44,300 characters per entry, max 87,371.
// At the old cap of 80 that is 3.5M characters, and WebKit's localStorage
// ceiling is 5 MiB counted in UTF-16 characters (measured, not assumed). So a
// REGENERABLE picture cache could take two thirds of the quota, and at the
// observed maximum could exceed it alone - while the genuinely irreplaceable
// work sharing that quota (speaker renames, chapters, marks, timecodes) came
// to 0.81% of it.
//
// That is the wrong way round: the thing that can always be re-grabbed must
// not be what evicts the thing that cannot. Hence a character budget, with the
// entry count kept as a secondary bound.

const KEY = "saucebunny.webPosters";
const MAX = 80;
/** Character budget for the whole serialized store. 256 KB still holds roughly
 *  six posters at the measured mean, and is 5% of the quota rather than 68%. */
const MAX_CHARS = 256 * 1024;
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
  // Evict oldest-first until BOTH bounds hold. The byte bound is the one that
  // matters; the count is a backstop for a pathological run of tiny posters.
  const size = () => s.order.reduce((n, u) => n + u.length + (s.map[u]?.length ?? 0), 0);
  while (s.order.length > MAX || (s.order.length > 1 && size() > MAX_CHARS)) {
    const evict = s.order.shift();
    if (evict) delete s.map[evict];
  }
  write(s);
  try { window.dispatchEvent(new CustomEvent(WEB_POSTERS_CHANGED_EVENT)); } catch { /* non-DOM env */ }
}
