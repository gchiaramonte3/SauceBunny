/**
 * Auto-chapters — detect chapters from the transcript with the local LLM
 * (the AI Summary tab's llama-server), show them on the Timeline, export as
 * YouTube-chapter text.
 *
 * This module is the PURE core: prompt building, transcript windowing,
 * defensive parsing of the model's output, and localStorage persistence
 * (keyed per source, same key the Review tab uses). The LLM call itself is
 * made by the AiChapters component through the existing ai-chat streaming
 * client — no new backend surface.
 */

import { loadJson, saveJson } from "./storage";
import type { ChatMessage } from "./ai-chat";

export type Chapter = {
  /** Start time in seconds (absolute source time — same clock as the SRT). */
  time: number;
  title: string;
};

// ── persistence ──────────────────────────────────────────────────────────────
// Keyed by the SAME source identity the Review tab uses (App's
// reviewSourceKey: local path — fingerprint-resolved — or webpage URL), so
// chapters reload with the source across restarts, moves, and renames.

const KEY_PREFIX = "saucebunny.chapters.";
const chaptersKey = (sourceKey: string) => KEY_PREFIX + sourceKey;

/** Fired after any chapters mutation so other views (the timeline markers)
 *  can re-read. Mirrors REVIEW_CHANGED_EVENT in lib/review.ts. */
export const CHAPTERS_CHANGED_EVENT = "saucebunny:chapters-changed";

export function loadChapters(sourceKey: string): Chapter[] {
  const raw = loadJson<unknown>(chaptersKey(sourceKey), []);
  if (!Array.isArray(raw)) return [];
  // Defensive re-validate: a corrupt/hand-edited blob can't crash the timeline.
  return raw.filter(
    (c): c is Chapter =>
      !!c && typeof c === "object"
      && typeof (c as Chapter).time === "number" && isFinite((c as Chapter).time) && (c as Chapter).time >= 0
      && typeof (c as Chapter).title === "string" && (c as Chapter).title.trim().length > 0,
  );
}

export function saveChapters(sourceKey: string, chapters: Chapter[]): void {
  saveJson(chaptersKey(sourceKey), chapters);
  try { window.dispatchEvent(new CustomEvent(CHAPTERS_CHANGED_EVENT, { detail: { sourceKey } })); }
  catch { /* non-DOM context (tests) */ }
}

// ── transcript windowing ─────────────────────────────────────────────────────

/**
 * Fit timestamped transcript lines into a character budget by sampling EVENLY
 * across the whole duration — never by cutting the tail, so chapters late in a
 * long video are still discoverable. Under budget returns everything verbatim.
 *
 * The budget the caller passes mirrors the AI Summary chat's context math:
 * ~3.5 chars/token and ~65% of the server's context window reserved for the
 * transcript (see AiSummary's transcriptForModel) — that is the documented
 * limit for how much transcript a chapter run can see.
 */
export function sampleTranscriptEvenly(
  lines: string[], budgetChars: number,
): { text: string; sampled: boolean } {
  const full = lines.join("\n");
  if (full.length <= budgetChars || lines.length <= 2) return { text: full, sampled: false };

  const avg = Math.max(1, full.length / lines.length);
  let keep = Math.min(lines.length, Math.max(2, Math.floor(budgetChars / avg)));
  // Average line length can under-estimate the picked set; shrink until it fits.
  for (;;) {
    const step = (lines.length - 1) / (keep - 1);
    const idx = new Set<number>();
    for (let i = 0; i < keep; i++) idx.add(Math.round(i * step));
    const picked = [...idx].sort((a, b) => a - b).map((i) => lines[i]);
    const text = picked.join("\n");
    if (text.length <= budgetChars || keep <= 2) return { text, sampled: true };
    keep = Math.max(2, Math.floor(keep * 0.9));
  }
}

// ── prompt ───────────────────────────────────────────────────────────────────

/** Format seconds for the prompt/export: "MM:SS", or "H:MM:SS" when `long`. */
export function chapterTimestamp(seconds: number, long: boolean): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n: number) => n.toString().padStart(2, "0");
  if (long || h > 0) return `${h}:${two(m)}:${two(sec)}`;
  return `${two(m)}:${two(sec)}`;
}

/** Messages for a chapter-detection run against the (possibly sampled)
 *  timestamped transcript. Asks for strict `MM:SS Title` lines — everything
 *  the model gets wrong is handled by parseChapters, not by re-prompting. */
export function buildChapterPrompt(
  transcript: string, durationSec: number | null, sampled: boolean,
): ChatMessage[] {
  const long = durationSec != null && durationSec >= 3600;
  const durNote = durationSec != null
    ? `The video is ${chapterTimestamp(durationSec, long)} long — every timestamp must be before that.`
    : "";
  const system = [
    "You segment video transcripts into chapters. Follow these rules exactly:",
    "- Output ONLY chapter lines — no intro, no explanation, no numbering, no markdown.",
    long
      ? '- One chapter per line in the exact form "H:MM:SS Title" (e.g. "0:00:00 Introduction").'
      : '- One chapter per line in the exact form "MM:SS Title" (e.g. "00:00 Introduction").',
    "- Titles are short (2–6 words) and describe the topic of that section.",
    "- Give between 3 and 15 chapters, matching where the conversation actually shifts topic.",
    `- The first chapter must start at ${long ? "0:00:00" : "00:00"}.`,
    "- Timestamps must be strictly increasing and taken from the [time] markers in the transcript.",
    durNote,
    sampled
      ? "- NOTE: the transcript below is sampled evenly across the full video (some lines omitted for length)."
      : "",
    "",
    "=== TRANSCRIPT ===",
    transcript,
    "=== END TRANSCRIPT ===",
  ].filter(Boolean).join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: "List the chapters." },
  ];
}

// ── parsing ──────────────────────────────────────────────────────────────────

// One chapter line, with tolerance for the drift small local models produce:
// leading bullets/numbering ("- ", "1. ", "3) "), bracketed or parenthesised
// timestamps ("[12:34]", "(1:02:03)"), both timestamp shapes, and a
// dash/colon/dot separator before the title. The trailing clock fields are
// exactly two digits — {1,2} would let the regex backtrack a titleless
// "02:00" into timestamp "02:0" + title "0".
const CHAPTER_LINE_RE =
  /^\s*(?:[-*+•>]|\d{1,3}[.)])?\s*\[?\(?(\d{1,3}):(\d{2})(?::(\d{2}))?\)?\]?\s*[-–—:·.]?\s*(\S.*?)\s*$/;

function lineToSeconds(a: string, b: string, c: string | undefined): number | null {
  if (c !== undefined) {
    // H:MM:SS — minutes and seconds must be real clock fields.
    const h = parseInt(a, 10), m = parseInt(b, 10), s = parseInt(c, 10);
    if (m >= 60 || s >= 60) return null;
    return h * 3600 + m * 60 + s;
  }
  // MM:SS — minutes may exceed 59 ("90:00" = 90 minutes).
  const m = parseInt(a, 10), s = parseInt(b, 10);
  if (s >= 60) return null;
  return m * 60 + s;
}

function cleanTitle(raw: string): string {
  return raw
    .replace(/[*_`]/g, "")           // leaked markdown emphasis
    .replace(/^["'“”]+|["'“”]+$/g, "") // surrounding quotes
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse the model's chapter output defensively:
 * - lines that don't parse as `<timestamp> <title>` are dropped;
 * - timestamps are clamped into [0, duration) when the duration is known;
 * - order is enforced ascending (a violator is dropped, not re-sorted —
 *   re-sorting would pair titles with the wrong neighbours);
 * - the first surviving chapter is snapped to 00:00 (YouTube requires it).
 *
 * Callers treat a result with fewer than 2 chapters as a failed run.
 */
export function parseChapters(raw: string, durationSec: number | null): Chapter[] {
  const out: Chapter[] = [];
  for (const line of raw.split("\n")) {
    const m = CHAPTER_LINE_RE.exec(line);
    if (!m) continue;
    let t = lineToSeconds(m[1], m[2], m[3]);
    if (t == null) continue;
    const title = cleanTitle(m[4]);
    if (!title) continue;
    if (durationSec != null && durationSec > 0 && t >= durationSec) {
      t = Math.max(0, Math.floor(durationSec) - 1);
    }
    const prev = out[out.length - 1];
    if (prev && t <= prev.time) continue; // enforce strictly ascending
    out.push({ time: t, title });
  }
  if (out.length > 0) out[0] = { ...out[0], time: 0 }; // YouTube: first chapter at 00:00
  return out;
}

// ── export ───────────────────────────────────────────────────────────────────

/** YouTube-description chapter text: one `MM:SS Title` line per chapter
 *  (H:MM:SS for hour-plus sources, applied uniformly for readability). */
export function chaptersToYouTube(chapters: Chapter[]): string {
  const long = chapters.some((c) => c.time >= 3600);
  return chapters.map((c) => `${chapterTimestamp(c.time, long)} ${c.title}`).join("\n");
}
