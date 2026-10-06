import type { AafOwnership } from "../bindings/AafOwnership";
import type { AafWordOwnership } from "../bindings/AafWordOwnership";

/**
 * The bleed resolver's labels, shaped for the AAF Audio reader
 * (docs/TRANSCRIPT-ACCURACY-SPEC-2026-10-04.md, phase 3). Words the resolver
 * does not list are their mic owner's. Nothing here deletes a word: bleed is
 * a label the reader dims or hides, and the editor can overrule it.
 */
export type CueLabels = Map<number, AafWordOwnership>;
export type OwnershipIndex = Map<string, CueLabels>;

const key = (trackId: string, cueId: string) => `${trackId}\u0000${cueId}`;

export function ownershipIndex(ownership: AafOwnership | null | undefined): OwnershipIndex {
  const index: OwnershipIndex = new Map();
  for (const word of ownership?.words ?? []) {
    const cue = index.get(key(word.track_id, word.cue_id)) ?? new Map<number, AafWordOwnership>();
    cue.set(word.index, word);
    index.set(key(word.track_id, word.cue_id), cue);
  }
  return index;
}

export const cueLabels = (index: OwnershipIndex, trackId: string, cueId: string): CueLabels | undefined => index.get(key(trackId, cueId));

/**
 * A cue is bleed when most of its words are: a line heard on the wrong mic.
 * A few bleed words inside the owner's own line (a neighbour's "yeah" under
 * it) leave the cue the owner's, with those words dimmed.
 */
export const BLEED_SHARE = 0.6;

/** `voice`: another cast member's track whose voice the voice check heard on this mic (they leaned into it). */
export type CueOwnership = { bleed: boolean; heardOn: string | null; manual: boolean; offMic: boolean; voice: string | null };

export function cueOwnership(labels: CueLabels | undefined, wordCount: number): CueOwnership {
  const none = { bleed: false, heardOn: null, manual: false, offMic: false, voice: null };
  if (!labels || !wordCount) return none;
  const words = [...labels.values()];
  const bleed = words.filter((word) => word.label === "bleed");
  const sources = new Map<string, number>();
  for (const word of bleed) if (word.heard_on) sources.set(word.heard_on, (sources.get(word.heard_on) ?? 0) + 1);
  const heardOn = [...sources.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const other = words.filter((word) => word.label === "other");
  return {
    bleed: bleed.length / wordCount >= BLEED_SHARE,
    heardOn,
    manual: words.some((word) => word.manual),
    offMic: words.filter((word) => word.label === "offmic").length / wordCount >= BLEED_SHARE,
    voice: other.length / wordCount >= BLEED_SHARE ? other[0].heard_on ?? null : null,
  };
}
