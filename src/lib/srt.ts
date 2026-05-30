/**
 * Minimal SRT / VTT parser tuned for what yt-dlp and whisper-cli emit.
 *
 * We deliberately do NOT pull in a heavy subtitle library here — the producers
 * we care about (yt-dlp's caption downloads and whisper-cli's SRT output) write
 * canonical SRT/VTT, and the few edge cases (UTF-8 BOM, CRLF, blank cue numbers,
 * VTT WEBVTT header, word-timing tags) are trivial to handle in a few dozen lines.
 *
 * Output is a flat array of cues with start/end in **seconds** (floats).
 *
 * Speaker awareness: when the source's own caption file labels who is speaking,
 * we extract it instead of throwing it away. Three real-world conventions:
 *   - WebVTT voice tags  `<v Roger Bingham>…</v>`  (YouTube/Vimeo creator captions)
 *   - Broadcast chevrons  `>> NAME: …`              (TV/CC speaker-change marker)
 *   - Plain prefixes      `NAME: …` / `[NAME] …`    (gated: only honoured when a
 *                                                    consistent cast appears, so a
 *                                                    lone "Note:" can't invent one)
 * Plus our own diarizer's machine labels (`SPEAKER_00` / `S1`). Anything we
 * extract lands in `cue.speaker`, so caption speakers flow into the exact same
 * roster / rename / colour UI as diarization — and make diarization unnecessary
 * when the source already tells us who's talking.
 */

export type Cue = {
  /** Sequential index from the original file (or our fallback). Stable. */
  index: number;
  /** Start time in seconds. */
  start: number;
  /** End time in seconds. */
  end: number;
  /**
   * Plain text content with cue line breaks collapsed to single spaces and all
   * SRT/VTT markup stripped. The viewer reflows on its own width.
   */
  text: string;
  /**
   * Speaker label when the source provides one — from a WebVTT `<v>` voice tag,
   * a `>> NAME:` / `NAME:` prefix in the caption, or our diarizer's machine
   * label. `null` for un-labelled plain captions / Whisper output.
   */
  speaker: string | null;
};

/**
 * Parse `HH:MM:SS,mmm` (SRT) or `HH:MM:SS.mmm` (VTT) into seconds. Returns
 * NaN on garbage; the caller filters those out.
 */
function tcToSeconds(tc: string): number {
  // Accept either comma (SRT) or dot (VTT) as the millisecond separator.
  // Some whisper builds emit a 2-digit hour without leading zero — be lenient.
  const m = tc.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!m) return NaN;
  const h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  const s = parseInt(m[3], 10);
  // Pad ms to 3 digits ("5" → "500", "12" → "120") to keep semantics
  // consistent with how players interpret short fractional strings.
  const msStr = (m[4] + "000").slice(0, 3);
  const ms = parseInt(msStr, 10);
  return h * 3600 + mi * 60 + s + ms / 1000;
}

const TIMESTAMP_LINE = /^\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/;

// --- speaker extraction patterns ---------------------------------------------

/** WebVTT voice tag: `<v Roger Bingham>` or `<v.loud Roger>` → captures name. */
const VOICE_TAG = /<v(?:\.[^\s>]+)*\s+([^>]*)>/i;
/** Our diarizer's machine labels: `[SPEAKER_00] text`, `S1: text`, etc. */
const MACHINE = /^\[?(SPEAKER[_\s-]?\d+|S\d+)\]?\s*[:\-]?\s+(.*)$/i;
/** Broadcast speaker change: `>> NAME: text` (the `>>` is unambiguous). */
const CHEVRON = /^>>\s*([^:>]{1,40}):\s*(.*)$/;
/** Plain `NAME: text` — gated by name-shape + cast frequency. */
const COLON = /^([^:]{1,40}):\s+(.+)$/;
/** Bracketed `[NAME] text` / `(NAME): text` — gated like COLON. */
const BRACKET = /^[[(]\s*([^\])]{1,40}?)\s*[\])]\s*:?\s+(.+)$/;

/**
 * Words that look like a `NAME:` / `[NAME]` speaker prefix but are sound cues,
 * section markers, or sentence-leading words — never a person.
 */
const NON_SPEAKER = new Set([
  "MUSIC", "APPLAUSE", "LAUGHTER", "CHEERING", "CHEERS", "SILENCE", "NOISE",
  "CROSSTALK", "INAUDIBLE", "FOREIGN", "BACKGROUND NOISE", "SPEAKING FOREIGN LANGUAGE",
  "NOTE", "NOTES", "WARNING", "CAUTION", "CHAPTER", "PART", "SCENE", "INTRO",
  "OUTRO", "TRANSCRIPT", "Q", "A", "TODO", "EDIT", "UPDATE",
]);

/**
 * Heuristic: does `s` look like a person/voice name rather than a stray word
 * before a colon? Names are short, name-cased (Title Case or ALL CAPS), and not
 * a sound cue or a sentence (no trailing `.`/`!`/`?`).
 */
function nameShaped(s: string): boolean {
  const t = s.trim();
  if (!t || NON_SPEAKER.has(t.toUpperCase())) return false;
  if (/[.!?]$/.test(t)) return false;
  if (!/[A-Za-z]/.test(t)) return false;
  const words = t.split(/\s+/);
  if (words.length > 4) return false;
  const allCaps = t === t.toUpperCase() && /^[A-Z0-9 .,'’\-]+$/.test(t);
  const titleCase = words.every((w) => /^[A-Z][\w'’.\-]*$/.test(w));
  return allCaps || titleCase;
}

function normalizeMachine(label: string): string {
  return label.toUpperCase().replace(/[\s-]/g, "_");
}

/** Strip SRT/VTT markup that would otherwise show as junk in the reader. */
function stripCaptionMarkup(s: string): string {
  return s
    .replace(/<\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}>/g, "") // VTT word timing
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")                // tag stripping (incl. <v>)
    .replace(/\{\\?[a-zA-Z][^}]*\}/g, "")              // ASS/SSA overrides
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse an SRT or VTT blob into cues. Tolerates:
 *  - UTF-8 BOM
 *  - CRLF or LF line endings
 *  - WEBVTT / NOTE / STYLE / REGION blocks (skipped)
 *  - Missing cue numbers
 *  - Stray blank cues
 *
 * Returns cues in source order; we don't sort because both producers emit
 * chronological output and resorting would obscure encoder bugs.
 */
export function parseSrt(blob: string): Cue[] {
  // Strip BOM and normalise newlines so the splitter below is simple.
  const text = blob.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");

  // Segment into raw cues, keeping BOTH the markup-bearing raw text (where the
  // `<v Name>` voice tag lives) and the cleaned plain text.
  type Raw = { start: number; end: number; raw: string; cleaned: string };
  const raws: Raw[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    // Skip VTT-only preamble + metadata blocks.
    if (line === "WEBVTT" || line.startsWith("NOTE") || line.startsWith("STYLE") || line.startsWith("REGION")) {
      while (i < lines.length && lines[i].trim() !== "") i++;
      i++;
      continue;
    }

    // A cue is: [optional integer index] / timestamp line / text lines / blank.
    let timeLineIdx = i;
    if (/^\d+$/.test(line)) timeLineIdx = i + 1;
    const timeMatch = lines[timeLineIdx]?.match(TIMESTAMP_LINE);
    if (!timeMatch) {
      i++;
      continue;
    }

    const start = tcToSeconds(timeMatch[1]);
    const end = tcToSeconds(timeMatch[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      i = timeLineIdx + 1;
      continue;
    }

    const textLines: string[] = [];
    let j = timeLineIdx + 1;
    while (j < lines.length && lines[j].trim() !== "") {
      textLines.push(lines[j]);
      j++;
    }
    const rawText = textLines.join(" ").trim();
    const cleaned = stripCaptionMarkup(rawText);

    // Skip empty cues (yt-dlp emits these for silence / no-audio gaps).
    if (cleaned.length > 0) raws.push({ start, end, raw: rawText, cleaned });

    i = j + 1;
  }

  return resolveSpeakers(raws);
}

/**
 * Turn raw cues into Cues, extracting speakers. Definite signals (voice tag,
 * machine label, `>>`) win immediately. Weak `NAME:` / `[NAME]` prefixes are
 * only promoted to speakers when a consistent cast emerges across the file —
 * a repeated name or prefixes covering ≥40% of cues — so a single stray
 * "Note:" line can't invent a speaker.
 */
function resolveSpeakers(raws: { start: number; end: number; raw: string; cleaned: string }[]): Cue[] {
  type E = { start: number; end: number; speaker: string | null; text: string; weak: string | null };

  const entries: E[] = raws.map((r) => {
    // 1) WebVTT voice tag — explicit + reliable.
    const v = r.raw.match(VOICE_TAG);
    if (v && v[1].trim()) {
      return { start: r.start, end: r.end, speaker: v[1].trim(), text: r.cleaned, weak: null };
    }
    // 2) Our diarizer's machine labels.
    const m = r.cleaned.match(MACHINE);
    if (m) {
      return { start: r.start, end: r.end, speaker: normalizeMachine(m[1]), text: m[2], weak: null };
    }
    // 3) Broadcast ">> NAME:" — chevron is an unambiguous speaker change.
    const ch = r.cleaned.match(CHEVRON);
    if (ch && nameShaped(ch[1])) {
      return { start: r.start, end: r.end, speaker: ch[1].trim(), text: ch[2], weak: null };
    }
    // 4/5) Weak "NAME:" / "[NAME]" candidates — recorded, promoted later only
    //      if the file shows a consistent cast.
    const co = r.cleaned.match(COLON);
    if (co && nameShaped(co[1])) {
      return { start: r.start, end: r.end, speaker: null, text: r.cleaned, weak: co[1].trim() };
    }
    const br = r.cleaned.match(BRACKET);
    if (br && nameShaped(br[1])) {
      return { start: r.start, end: r.end, speaker: null, text: r.cleaned, weak: br[1].trim() };
    }
    return {
      start: r.start,
      end: r.end,
      speaker: null,
      text: r.cleaned.replace(/\[SPEAKER_TURN\]/g, "").trim(),
      weak: null,
    };
  });

  const hasDefinite = entries.some((e) => e.speaker !== null);
  const weakCount = new Map<string, number>();
  for (const e of entries) if (e.weak) weakCount.set(e.weak, (weakCount.get(e.weak) ?? 0) + 1);
  const weakTotal = [...weakCount.values()].reduce((a, b) => a + b, 0);
  const promote =
    !hasDefinite &&
    weakTotal > 0 &&
    ([...weakCount.values()].some((n) => n >= 2) || weakTotal >= entries.length * 0.4);

  return entries.map((e, k) => {
    let speaker = e.speaker;
    let text = e.text;
    if (e.weak && promote) {
      speaker = e.weak;
      text = text.replace(COLON, "$2").replace(BRACKET, "$2").trim();
    }
    return { index: k + 1, start: e.start, end: e.end, text, speaker };
  });
}

/**
 * Group adjacent cues that share a speaker (or, when no speakers exist,
 * sit within `gapSeconds` of each other) into a "turn". Used by the
 * viewer to render Riverside-style chat-bubble blocks instead of one
 * row per timestamp line.
 *
 * For un-diarized transcripts (every speaker `null`), this collapses
 * short consecutive lines into a flowing paragraph until either:
 *   - the gap between cues exceeds `gapSeconds`, or
 *   - the running word count exceeds `maxWordsPerTurn` (so a 40-minute
 *     monologue doesn't render as one DOM node).
 */
export type Turn = {
  speaker: string | null;
  start: number;
  end: number;
  cues: Cue[];
};

export function groupIntoTurns(
  cues: Cue[],
  opts: { gapSeconds?: number; maxWordsPerTurn?: number } = {},
): Turn[] {
  const gap = opts.gapSeconds ?? 1.2;
  const maxWords = opts.maxWordsPerTurn ?? 120;
  const turns: Turn[] = [];
  for (const c of cues) {
    const last = turns[turns.length - 1];
    const wordCount = c.text.split(/\s+/).length;
    const lastWords = last ? last.cues.reduce((n, x) => n + x.text.split(/\s+/).length, 0) : 0;
    const canExtend =
      last &&
      last.speaker === c.speaker &&
      c.start - last.end <= gap &&
      lastWords + wordCount <= maxWords;
    if (canExtend && last) {
      last.cues.push(c);
      last.end = c.end;
    } else {
      turns.push({ speaker: c.speaker, start: c.start, end: c.end, cues: [c] });
    }
  }
  return turns;
}

/**
 * Format seconds as "M:SS" for short content or "H:MM:SS" for hour+.
 * Used in the cue-row timestamp pill; the player has its own SMPTE
 * formatter elsewhere.
 */
export function fmtTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
