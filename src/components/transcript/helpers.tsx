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

/**
 * Deterministic palette picker for a speaker tag. Hashes the tag into a
 * fixed-length palette so the same speaker keeps the same colour across
 * re-renders and sessions.
 *
 * The palette uses brand-aligned gradients (green/purple/pink primary,
 * cyan/amber/coral secondary). When `null`, returns the brand-green
 * default so the single un-diarised "Speaker" still feels intentional.
 */
export function speakerColor(speaker: string | null): string {
  const palette = [
    "linear-gradient(180deg,#6CFF8D 0%,#3FCB6A 100%)", // green (brand)
    "linear-gradient(180deg,#6D52ED 0%,#4F3BC7 100%)", // purple (marker)
    "linear-gradient(180deg,#C54AF7 0%,#9C2EE0 100%)", // pink (brand)
    "linear-gradient(180deg,#52B5ED 0%,#3B8DC7 100%)", // cyan
    "linear-gradient(180deg,#F7B84A 0%,#E09B2E 100%)", // amber
    "linear-gradient(180deg,#F7714A 0%,#E0512E 100%)", // coral
  ];
  if (!speaker) return palette[0];
  let h = 0;
  for (let i = 0; i < speaker.length; i++) h = (h * 31 + speaker.charCodeAt(i)) | 0;
  return palette[Math.abs(h) % palette.length];
}

/**
 * Convert a raw diarizer tag into a human-readable display label.
 *
 *   SPEAKER_00   → "Speaker 1"
 *   SPEAKER_07   → "Speaker 8"
 *   S2           → "Speaker 3"
 *   SPEAKER_UNK  → "Unknown speaker"
 *   null / undiarized → "Speaker"
 *   anything custom (e.g. "Tom") → unchanged
 *
 * The diarizer's internal numbering is 0-indexed; humans expect
 * 1-indexed. We don't pad ("Speaker 01"): once we're in human-readable
 * land we follow human conventions.
 */
export function humanizeSpeakerTag(tag: string | null): string {
  if (!tag) return "Speaker";
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
