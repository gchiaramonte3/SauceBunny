import type { AafDocumentSummary } from "../bindings/AafDocumentSummary";
import { loadJson, saveJson } from "./storage";

/**
 * AAF Audio's saved sequences as String Outs offers them: Add sequence in an
 * open string out, and Start from in a new one.
 *
 * Every sequence ever imported was listed, oldest first, in a native menu as
 * wide as the longest name, and nothing could take one out. Removing one here
 * HIDES it and deletes nothing: the sequence stays in AAF Audio, every string
 * out cut from it keeps playing, and it comes back by itself the next time it
 * is saved in AAF Audio. That is why what is stored is the save time each one
 * was hidden at, not a flag: a later save is newer than the stamp, so the
 * sequence is current again and belongs on the shelf.
 */
export const HIDDEN_SEQUENCES_KEY = "saucebunny.stringOuts.hiddenSequences";

/** How many of the newest a menu shows before "Show N more". */
export const RECENT_SEQUENCES = 8;

/** Sequence id to the save time it was hidden at. */
export type HiddenSequences = Record<string, number>;

const savedAt = (item: AafDocumentSummary) => item.modified_ms ?? 0;

export function loadHiddenSequences(): HiddenSequences {
  const raw = loadJson<unknown>(HIDDEN_SEQUENCES_KEY, {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
}

/** Hidden until it is saved again after the stamp. */
export function isHiddenSequence(item: AafDocumentSummary, hidden: HiddenSequences): boolean {
  const at = hidden[item.id];
  return at !== undefined && savedAt(item) <= at;
}

/** What a picker lists: newest save first, hidden ones left out. */
export function sequenceShelf(items: AafDocumentSummary[], hidden: HiddenSequences): AafDocumentSummary[] {
  return items.filter((item) => !isHiddenSequence(item, hidden)).sort((a, b) => savedAt(b) - savedAt(a));
}

/** How many of `items` are hidden right now. */
export function hiddenCount(items: AafDocumentSummary[], hidden: HiddenSequences): number {
  return items.filter((item) => isHiddenSequence(item, hidden)).length;
}

/**
 * Hide `remove` from both pickers. `all` is every saved sequence, so a stamp
 * for a sequence AAF Audio no longer has is dropped rather than kept for ever.
 */
export function hideSequences(remove: AafDocumentSummary[], all: AafDocumentSummary[], hidden: HiddenSequences): HiddenSequences {
  const known = new Set(all.map((item) => item.id));
  const next: HiddenSequences = Object.fromEntries(Object.entries(hidden).filter(([id]) => known.has(id)));
  for (const item of remove) next[item.id] = savedAt(item);
  saveJson(HIDDEN_SEQUENCES_KEY, next);
  return next;
}

/** Put every hidden sequence back. */
export function showHiddenSequences(): HiddenSequences {
  saveJson(HIDDEN_SEQUENCES_KEY, {});
  return {};
}
