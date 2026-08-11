/**
 * Pure helpers shared across the transcript viewer + its popovers.
 *
 * Anything in here is:
 *   - side-effect free (safe to import anywhere)
 *   - no React dependency
 *   - no localStorage / DOM access
 *
 * Extracted from TranscriptViewer.tsx (r46.B) so each popover file can
 * own its small dependency surface without pulling in the 1400-line
 * viewer module.
 */

import type React from "react";
import { applySplits, type CueSplits } from "../../lib/cue-splits";
import type { Cue } from "../../lib/srt";

/**
 * Wrap every case-insensitive occurrence of `query` inside `text` in a
 * <mark> element. Returns the original string when `query` is empty so
 * the call site doesn't have to branch.
 *
 * Why a renderer and not a tokenizer: cues are flat strings, but the
 * match needs to preserve original casing inside the <mark>, which is
 * easier with substring math than a regex with capture groups.
 */
export function highlightMatch(text: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q) return text;
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let hit = lower.indexOf(ql, cursor);
  while (hit !== -1) {
    if (hit > cursor) parts.push(text.slice(cursor, hit));
    parts.push(
      <mark key={hit} className="cp-tx-mark">
        {text.slice(hit, hit + q.length)}
      </mark>,
    );
    cursor = hit + q.length;
    hit = lower.indexOf(ql, cursor);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

/**
 * Walk the speaker-alias chain to find the canonical tag a turn should
 * be displayed as. Capped at 8 hops + cycle detection so a corrupted
 * localStorage entry can't hang the renderer.
 *
 * `aliases` is a plain { sourceTag: targetTag } map. When the alias map
 * is being modified mid-update (inside a setOverrides reducer), pass
 * the in-progress draft as `aliases` so the resolution sees the new
 * world — every call accepts the map explicitly to keep the function
 * pure.
 */
export function resolveAliasChain(
  tag: string | null,
  aliases: Record<string, string>,
): string | null {
  if (tag == null) return null;
  let cur = tag;
  const seen = new Set<string>();
  for (let i = 0; i < 8; i++) {
    const next = aliases[cur];
    if (!next || next === cur || seen.has(next)) return cur;
    seen.add(cur);
    cur = next;
  }
  return cur;
}

// Shared speaker palette — the SINGLE source of truth for per-speaker hues,
// consumed by the roster chips, the per-turn avatar (gradients), AND the
// on-video caption label (solid). Index 0..5 maps a speaker to a hue; the
// solid base and the gradient at the same index are the same family, so a
// speaker's caption-label colour matches their sidebar chip.
/**
 * The speaker palette: twelve hues, plus one tone for "nobody yet".
 *
 * WHY TWELVE, AND WHY THESE. The old palette was SIX, so a twenty-six person
 * cast put four or five people in each colour and the colour stopped meaning
 * anything. Twelve is not an arbitrary bump — it is roughly where categorical
 * colour stops working at pip size, which is why d3 dropped schemeCategory20,
 * Premiere ships sixteen label colours and Avid eight. Past twelve, colour is
 * not the channel that distinguishes people; the initials in the pip and the
 * name beside it are.
 *
 * These twelve were SEARCHED, not chosen by eye, against three real surfaces
 * this app renders them on:
 *
 *   · the panel background #0E0E10,
 *   · the on-video caption, worst case a white frame under the default 0.75
 *     black backing, i.e. #404040 — this is the binding constraint, and it is
 *     what the previous palette failed,
 *   · the #0a0a0a initials drawn INSIDE the pip.
 *
 * Every member clears 4.5:1 on all three, is at least 15 ΔE00 from the brand
 * accent so nobody wears it, and the set maximises the minimum pairwise ΔE00,
 * which lands at 14.5. Not the 15 originally aimed at: 14.5 is the measured
 * ceiling once all three contrast bars and the accent exclusion are honoured,
 * and lowering a real constraint to hit a round number would have been the
 * wrong trade. `speaker-palette.test.ts` pins all of it.
 *
 * Do not add a nicer purple here without running that test. The caption
 * surface is unforgiving and the failure is invisible on a dark frame.
 */
const SPEAKER_SOLIDS = [
  "#FD8A8C", "#FE8F5D", "#EB9A04", "#FBD509",
  "#ABF201", "#0AF2CD", "#0DE2EB", "#08C0EF",
  "#75B0FF", "#AAA0FB", "#E887FE", "#F886BB",
];

/**
 * The tone for speech nobody has been assigned to yet.
 *
 * Its own entry, because `speakerColorIndex(null)` returned 0 — so "unknown"
 * wore the first speaker's exact hue and looked like a person. Deliberately
 * low-chroma so it reads as unassigned, but still a colour rather than the
 * grey the palette otherwise refuses, and it clears the same three bars.
 */
const UNASSIGNED_SOLID = "#AAAD98";

/** Darken a hex for the gradient's bottom stop. */
function shade(hex: string, factor: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map((c) => Math.max(0, Math.min(255, Math.round(c * factor))));
  return `#${ch.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** Gradients are DERIVED, so a colour can never be updated in one list and
 *  not the other — which is exactly what two hand-maintained arrays invite. */
const SPEAKER_GRADIENTS = SPEAKER_SOLIDS.map(
  (c) => `linear-gradient(180deg,${c} 0%,${shade(c, 0.74)} 100%)`,
);
const UNASSIGNED_GRADIENT = `linear-gradient(180deg,${UNASSIGNED_SOLID} 0%,${shade(UNASSIGNED_SOLID, 0.74)} 100%)`;

/** The palette, for the contract test and the colour picker. */
export const SPEAKER_PALETTE = Object.freeze([...SPEAKER_SOLIDS]);
export const SPEAKER_UNASSIGNED = UNASSIGNED_SOLID;

/**
 * Stable palette index for a speaker tag. The diarizer's raw tags carry a
 * number (`SPEAKER_00`→0, `S1`→1), so colour by that number — deterministic
 * and identical everywhere a speaker appears (sidebar, bubble, caption), with
 * no hash collisions. `null` / non-numeric (`SPEAKER_UNK`, custom) fall back to
 * a stable string hash. Callers MUST pass the alias-resolved RAW tag (never a
 * humanized "Speaker N"), which every call site does.
 */
export function speakerColorIndex(speaker: string | null): number {
  if (!speaker) return 0;
  const m = speaker.match(/(\d+)/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n)) return n;
  }
  let h = 0;
  for (let i = 0; i < speaker.length; i++) h = (h * 31 + speaker.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * GRADIENT for a speaker — use as a `background` (roster pip, turn avatar).
 * NOT valid as a CSS `color:` (it's a gradient); use {@link speakerTextColor}
 * for text. When `null`, returns the brand-green default.
 */
export function speakerColor(speaker: string | null): string {
  // Untagged speech gets its own tone rather than sharing the first speaker's
  // hue, which is what a null index of 0 used to do.
  if (speaker == null) return UNASSIGNED_GRADIENT;
  return SPEAKER_GRADIENTS[speakerColorIndex(speaker) % SPEAKER_GRADIENTS.length];
}

/**
 * SOLID hue for a speaker — use as a CSS `color:` (the on-video caption label).
 * Same index/family as {@link speakerColor}, so the caption label colour
 * matches that speaker's sidebar chip gradient.
 */
export function speakerTextColor(speaker: string | null): string {
  if (speaker == null) return UNASSIGNED_SOLID;
  return SPEAKER_SOLIDS[speakerColorIndex(speaker) % SPEAKER_SOLIDS.length];
}

/**
 * Convert a raw diarizer tag into a human-readable display label.
 *
 *   SPEAKER_00   → "Speaker 1"
 *   SPEAKER_07   → "Speaker 8"
 *   S2           → "Speaker 3"
 *   SPEAKER_UNK  → "Unknown speaker"
 *   null / undiarized → "Speaker" (or "Unknown speaker" when other speakers
 *                      ARE identified — i.e. this one turn the diarizer left
 *                      unassigned; pass { unknownWhenNull: true } for that)
 *   anything custom (e.g. "Tom") → unchanged
 *
 * The diarizer's internal numbering is 0-indexed; humans expect
 * 1-indexed. We don't pad ("Speaker 01"): once we're in human-readable
 * land we follow human conventions.
 */
export function humanizeSpeakerTag(tag: string | null, opts?: { unknownWhenNull?: boolean }): string {
  if (!tag) return opts?.unknownWhenNull ? "Unknown speaker" : "Speaker";
  if (tag === "SPEAKER_UNK") return "Unknown speaker";
  const m = tag.match(/^SPEAKER[_\s-]?(\d+)$/i) || tag.match(/^S(\d+)$/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n)) return `Speaker ${n + 1}`;
  }
  // Tags this app MINTS, which a user should never be shown raw.
  //
  // A speaker split out of somebody else's dialogue gets a CAST_* tag, and if
  // the naming sheet is cancelled that tag was rendered verbatim - a roster
  // reading "CAST_A" next to "Harry Jowsey" looks like a bug, because from
  // the outside it is one. The letter is kept so two unnamed splits stay
  // distinguishable.
  const cast = tag.match(/^CAST_([A-Z]+)$/);
  if (cast) return `New speaker ${cast[1]}`;
  // Built-in non-speech groups. Normally carrying an explicit name override,
  // but a doc hand-edited on disk or written by an older build may not.
  const kind = tag.match(/^KIND_([A-Z]+)$/);
  if (kind) {
    const label = { MUSIC: "Music", LYRIC: "Lyrics", SFX: "Sound effects", INAUDIBLE: "Inaudible" }[kind[1]];
    if (label) return label;
  }
  return tag;
}

/**
 * Two-letter chip label for a speaker. Uses "S1" / "S2" form for the
 * humanized "Speaker N" pattern, and first-letters-of-first-two-words
 * for everything else. Single-word custom names fall back to the first
 * letter capitalised.
 */
export function speakerInitials(label: string): string {
  const trimmed = label.trim();
  if (/^speaker\s*\d+$/i.test(trimmed)) {
    const n = trimmed.match(/\d+/)?.[0] ?? "";
    return `S${n}`;
  }
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0]?.[0] ?? "?").toUpperCase();
}

/**
 * Minimal HTML escaper for the print-to-PDF document. Not a general-
 * purpose sanitiser — only the five characters that would break inside
 * an HTML attribute or text node.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Shared speaker-override access (panel ⇄ on-video caption overlay) ──
// The transcript panel owns the rename/merge UI and persists three layers to
// localStorage keyed by transcript path. The caption overlay reads the SAME
// store so a rename ("Speaker 1" → "Tom Jonathan") shows up live on the video.

export type SpeakerOverrides = {
  global: Record<string, string>;
  turn: Record<string, string>;
  aliases: Record<string, string>;
  /** Per-speaker custom pip colour (canonical tag → hex). null group = "__NULL__". */
  colors: Record<string, string>;
  /** Per-turn reassignment (turn index → canonical tag). Turn-indexed like
   *  `turn`, so cue-level consumers (the caption overlay) can't apply it —
   *  same documented limitation as per-turn renames. */
  turnTag: Record<string, string>;
  /**
   * Per-CUE speaker reassignment: cue start in whole milliseconds → raw tag.
   *
   * This is the layer that makes "these two people were merged into one
   * speaker" fixable, and it is keyed by TIME rather than by index for a
   * specific reason. Re-detect speakers re-emits every cue with its start and
   * end unchanged and only rewrites the speaker prefix, so a millisecond key
   * survives the single most likely follow-up action. Turn indices do not:
   * grouping keys on `last.speaker === c.speaker`, so changing one speaker
   * renumbers every turn after it. An index-keyed assignment would not go
   * inert after a re-detect, it would point at somebody else's words — and
   * putting dialogue in the wrong person's mouth is the one failure a review
   * tool must never produce.
   *
   * Applied by `retagCues` BEFORE `groupIntoTurns`, which means the turn
   * boundaries re-derive for free: a run of cues carrying a different speaker
   * simply becomes its own turn. No turn-splitting code exists or is needed.
   *
   * It also reaches every cue-level consumer, which `turnTag` never could —
   * the on-video captions, the AI summary, the reader analysis and the
   * timeline speaker lanes.
   */
  cueTag: Record<string, string>;
  /**
   * Explicit per-speaker icon (canonical tag → kind), overriding initials.
   *
   * A DISPLAY choice, deliberately separate from the built-in KIND_* groups.
   * Those change WHO a stretch of dialogue belongs to; this changes only what
   * their badge shows. So a real person can carry a music note (the show's
   * band, a jingle singer) without their lines being folded into the shared
   * Music group, and the two ideas stay independent instead of one silently
   * implying the other.
   */
  icons: Record<string, string>;
  /**
   * Sub-cue divisions: cue start in whole ms → character offsets to cut at.
   *
   * Whisper's `-ml 84` breaks lines on a character budget, so one cue routinely
   * holds the end of one person's sentence and the start of another's, and
   * `cueTag` above can only address a WHOLE cue. Cutting the cue first is what
   * gives the phrase its own start, and therefore its own `cueTag` key.
   *
   * Applied by `applySplits` BEFORE `retagCues` — see `lib/cue-splits.ts` for
   * why the offsets are characters rather than times, and for the one real cost
   * (the fragment's timecode is interpolated).
   */
  splits: CueSplits;
};

export const EMPTY_OVERRIDES: SpeakerOverrides = Object.freeze({
  global: {}, turn: {}, aliases: {}, colors: {}, turnTag: {}, cueTag: {}, icons: {}, splits: {},
});

/**
 * A shallow copy with every sub-map cloned, so an editor can mutate one branch
 * without writing through to the previous state.
 *
 * THIS EXISTS BECAUSE HAND-WRITTEN CLONES ROTTED TWICE. Three call sites in the
 * viewer spelled the shape out key by key, and each time a key was added to
 * `SpeakerOverrides` — `cueTag`, then `splits` — every one of them silently
 * stopped carrying it. The type caught it both times, which is luck: it only
 * fires because the literal is annotated. One clone, next to the type it
 * clones, makes the next key free.
 */
export function cloneOverrides(prev: SpeakerOverrides): SpeakerOverrides {
  return {
    global: { ...prev.global },
    turn: { ...prev.turn },
    aliases: { ...prev.aliases },
    colors: { ...prev.colors },
    turnTag: { ...prev.turnTag },
    cueTag: { ...prev.cueTag },
    icons: { ...prev.icons },
    splits: { ...prev.splits },
  };
}

/** localStorage key the panel persists a transcript's speaker overrides under. */
export function speakerOverridesKey(path: string): string {
  return `saucebunny.speakerNames.${path}`;
}

/** Carry a transcript's path-keyed speaker names to a new path (rename/move).
 *  The fingerprint mirror (keyed on the SOURCE, unchanged) is untouched. */
export function renameSpeakerOverridesPath(oldPath: string, newPath: string): void {
  try {
    const val = localStorage.getItem(speakerOverridesKey(oldPath));
    if (val == null) return;
    localStorage.setItem(speakerOverridesKey(newPath), val);
    localStorage.removeItem(speakerOverridesKey(oldPath));
  } catch { /* ignore */ }
}

/** Fired by the panel whenever overrides change, so live consumers (the
 *  caption overlay) can re-read without polling. Dispatched on TWO buses
 *  under this one name: a window CustomEvent (synchronous, same-window —
 *  the native `storage` event doesn't fire in the tab that wrote it) and a
 *  Tauri event (crosses webviews, so panel-window renames reach main). */
export const SPEAKERS_CHANGED_EVENT = "saucebunny:speakers-changed";

/** The `cueTag` key for a cue: its start time in whole milliseconds. */
export function cueKey(startSeconds: number): string {
  return String(Math.round(startSeconds * 1000));
}

/**
 * Apply per-cue speaker reassignments, returning a NEW cue array.
 *
 * Call this between `parseSrt` and `groupIntoTurns` and the turn structure
 * re-derives itself: a reassigned run stops matching its neighbours'
 * speaker, so `groupIntoTurns` starts a new turn at each boundary. That is
 * the whole splitting mechanism.
 *
 * Returns the input array unchanged when there is nothing to apply, so every
 * consumer can call it unconditionally without paying for a copy.
 */
export function retagCues<T extends { start: number; speaker: string | null }>(
  cues: T[],
  overrides: Pick<SpeakerOverrides, "cueTag">,
): T[] {
  const map = overrides.cueTag;
  if (!map || Object.keys(map).length === 0) return cues;
  let touched = false;
  const out = cues.map((c) => {
    const raw = map[cueKey(c.start)];
    if (raw === undefined) return c;
    // "" is how the UNTAGGED group is written on the wire, because a JSON
    // object cannot hold `null` as a distinct "assigned to nobody" without
    // being confusable with "absent". It has to become a real null here: an
    // empty-string speaker is not the same thing as no speaker, and it would
    // travel all the way to `humanizeSpeakerTag` and render as a nameless
    // label rather than falling into the unknown group.
    const tag = raw === "" ? null : raw;
    if (tag === c.speaker) return c;
    touched = true;
    return { ...c, speaker: tag };
  });
  return touched ? out : cues;
}

/**
 * The whole cue pipeline between parsing a transcript and grouping it: cut,
 * then reassign.
 *
 * ONE SEAM, ON PURPOSE. Five places assemble cues — the transcript panel, the
 * on-video captions, the AI summary, the reader analysis and App's caption
 * load — and each of them has to apply the same two layers in the same order or
 * the picture and the panel disagree about who said what. Splitting that
 * knowledge across five call sites is how four of them get it right.
 *
 * The order is not interchangeable. Splitting must come FIRST, because a
 * fragment has no millisecond key to be reassigned by until it is a cue.
 *
 * Returns the input array unchanged when neither layer applies, so callers can
 * run it unconditionally on every frame.
 */
export function prepareCues(cues: Cue[], overrides: Pick<SpeakerOverrides, "cueTag" | "splits">): Cue[] {
  return retagCues(applySplits(cues, overrides.splits), overrides);
}

/** Read + shape-clamp the persisted overrides for a path. */
export function loadSpeakerOverrides(path: string | null): SpeakerOverrides {
  if (!path) return EMPTY_OVERRIDES;
  try {
    const raw = localStorage.getItem(speakerOverridesKey(path));
    if (!raw) return EMPTY_OVERRIDES;
    const p = JSON.parse(raw) as Partial<SpeakerOverrides>;
    return {
      global: p.global && typeof p.global === "object" ? p.global : {},
      turn: p.turn && typeof p.turn === "object" ? p.turn : {},
      aliases: p.aliases && typeof p.aliases === "object" ? p.aliases : {},
      colors: p.colors && typeof p.colors === "object" ? p.colors : {},
      turnTag: p.turnTag && typeof p.turnTag === "object" ? p.turnTag : {},
      cueTag: p.cueTag && typeof p.cueTag === "object" ? p.cueTag : {},
      icons: p.icons && typeof p.icons === "object" ? p.icons : {},
      splits: p.splits && typeof p.splits === "object" ? p.splits : {},
    };
  } catch {
    return EMPTY_OVERRIDES;
  }
}

/**
 * SOLID caption colour for a speaker, honouring a user override. The override
 * is keyed on the alias-resolved tag (null group → "__NULL__"), matching the
 * transcript panel's `overrides.colors`; falls back to the auto palette so the
 * caption label always matches that speaker's sidebar pip.
 */
export function resolveSpeakerColor(
  rawSpeaker: string | null,
  overrides: SpeakerOverrides,
): string {
  const resolved = resolveAliasChain(rawSpeaker, overrides.aliases);
  return overrides.colors[resolved ?? "__NULL__"] || speakerTextColor(resolved);
}

/**
 * Resolve a raw speaker tag to its display name with the same layered rules as
 * the panel: alias chain → global rename → humanized fallback. Per-turn
 * overrides aren't applied (they're turn-indexed, not cue-indexed) — those are
 * rare; the common "rename everywhere" path resolves correctly.
 */
export function resolveSpeakerName(
  tag: string | null,
  ov: SpeakerOverrides,
  opts?: { unknownWhenNull?: boolean },
): string {
  const resolved = resolveAliasChain(tag, ov.aliases);
  const key = resolved ?? "__NULL__";
  return ov.global[key] ?? humanizeSpeakerTag(resolved, opts);
}
