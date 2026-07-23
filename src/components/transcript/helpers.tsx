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
const SPEAKER_SOLIDS = ["#6CFF8D", "#6D52ED", "#C54AF7", "#52B5ED", "#F7B84A", "#F7714A"];
const SPEAKER_GRADIENTS = [
  "linear-gradient(180deg,#6CFF8D 0%,#3FCB6A 100%)", // green (brand)
  "linear-gradient(180deg,#6D52ED 0%,#4F3BC7 100%)", // purple (marker)
  "linear-gradient(180deg,#C54AF7 0%,#9C2EE0 100%)", // pink (brand)
  "linear-gradient(180deg,#52B5ED 0%,#3B8DC7 100%)", // cyan
  "linear-gradient(180deg,#F7B84A 0%,#E09B2E 100%)", // amber
  "linear-gradient(180deg,#F7714A 0%,#E0512E 100%)", // coral
];

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
  return SPEAKER_GRADIENTS[speakerColorIndex(speaker) % SPEAKER_GRADIENTS.length];
}

/**
 * SOLID hue for a speaker — use as a CSS `color:` (the on-video caption label).
 * Same index/family as {@link speakerColor}, so the caption label colour
 * matches that speaker's sidebar chip gradient.
 */
export function speakerTextColor(speaker: string | null): string {
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
};

const EMPTY_OVERRIDES: SpeakerOverrides = { global: {}, turn: {}, aliases: {}, colors: {}, turnTag: {} };

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
