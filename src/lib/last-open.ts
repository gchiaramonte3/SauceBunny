/**
 * Where each workspace was left. AAF Audio and String Outs reopen the last
 * thing that was open instead of showing their onboarding again, so the
 * welcome panel is for someone who has never used the page, not for every
 * visit. Storage can fail (private window, full quota); forgetting then just
 * means the page opens on its list.
 */
export const LAST_AAF_DOCUMENT = "saucebunny.aafAudio.lastDocument";
export const LAST_STRING_OUT = "saucebunny.editor.lastEdit";

export function recallLast(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function rememberLast(key: string, id: string | null) {
  try { if (id) localStorage.setItem(key, id); else localStorage.removeItem(key); } catch { /* storage unavailable: nothing to remember */ }
}

/**
 * What to reopen: the last one when it still exists, otherwise the most
 * recently changed. An install that used the page before this was remembered
 * lands on its newest work, not on the welcome.
 */
export function pickResume<T extends { id: string }>(last: string | null, items: T[], changedAt: (item: T) => number): string | null {
  if (last && items.some((item) => item.id === last)) return last;
  if (!items.length) return null;
  return items.reduce((best, item) => changedAt(item) > changedAt(best) ? item : best).id;
}
