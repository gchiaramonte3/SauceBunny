/**
 * Minimal SRT / VTT parser tuned for what yt-dlp and whisper-cli emit.
 *
 * We deliberately do NOT pull in a heavy subtitle library here — the two
 * producers we care about (yt-dlp's --convert-subs srt and whisper-cli's
 * default SRT output) both write canonical SRT, and the few edge cases
 * (UTF-8 BOM, CRLF, blank cue numbers, VTT WEBVTT header) are trivial
 * to handle in a few dozen lines.
 *
 * Output is a flat array of cues with start/end in **seconds** (floats).
 * No styling, no positioning — the viewer only cares about timing + text.
 */

export type Cue = {
  /** Sequential index from the original file (or our fallback). Stable. */
  index: number;
  /** Start time in seconds. */
  start: number;
  /** End time in seconds. */
  end: number;
  /**
   * Plain text content with cue line breaks collapsed to single spaces.
   * Whisper sometimes emits very long lines (no wrapping); yt-dlp wraps
   * after ~40 chars. The viewer reflows either way, so we normalise.
   */
  text: string;
  /**
   * Optional speaker label when the underlying source provides one
   * (whisper.cpp's --tinydiarize, future FluidAudio output). Always
   * `null` for plain Whisper / yt-dlp captions today; left in the cue
   * shape so the viewer is forward-compatible with diarized input.
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

/**
 * Parse an SRT or VTT blob into cues. Tolerates:
 *  - UTF-8 BOM
 *  - CRLF or LF line endings
 *  - WEBVTT / NOTE / STYLE blocks (skipped)
 *  - Missing cue numbers
 *  - Stray blank cues
 *
 * Returns cues in source order; we don't sort because Whisper output is
 * already chronological and resorting would obscure encoder bugs.
 */
export function parseSrt(blob: string): Cue[] {
  // Strip BOM and normalise newlines so the splitter below is simple.
  const text = blob.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const cues: Cue[] = [];
  let i = 0;
  let fallbackIdx = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    // Skip VTT-only preamble + metadata blocks. We accept VTT because
    // yt-dlp sometimes serves a .vtt when an .srt isn't available.
    if (line === "WEBVTT" || line.startsWith("NOTE") || line.startsWith("STYLE") || line.startsWith("REGION")) {
      // Advance to the next blank line — that's the block boundary.
      while (i < lines.length && lines[i].trim() !== "") i++;
      i++;
      continue;
    }

    // Try to consume a cue. A cue is:
    //   [optional integer index]
    //   HH:MM:SS,mmm --> HH:MM:SS,mmm [optional positioning]
    //   text line 1
    //   text line 2
    //   <blank>
    // The integer index is optional in VTT and sometimes missing in
    // hand-edited SRTs, so we don't require it.
    let timeLineIdx = i;
    // If the current line is purely numeric, it's the cue number; the
    // timestamp is on the next line.
    if (/^\d+$/.test(line)) {
      timeLineIdx = i + 1;
    }
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

    // Collect text lines until the next blank line.
    const textLines: string[] = [];
    let j = timeLineIdx + 1;
    while (j < lines.length && lines[j].trim() !== "") {
      textLines.push(lines[j]);
      j++;
    }
    const rawText = textLines.join(" ").trim();

    // Strip the common SRT/VTT markup that would show as junk in the
    // reader:  <i>, <b>, <c>, <00:00:00.000>, {\an2}, &lt; entities.
    // We leave newlines collapsed; the viewer wraps on its own width.
    const cleaned = rawText
      .replace(/<\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}>/g, "") // VTT word timing
      .replace(/<\/?[a-zA-Z][^>]*>/g, "")                // tag stripping
      .replace(/\{\\?[a-zA-Z][^}]*\}/g, "")              // ASS/SSA overrides
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, " ")
      .trim();

    // Skip empty cues (yt-dlp emits these for silence / no-audio gaps).
    if (cleaned.length > 0) {
      fallbackIdx += 1;
      // Detect speaker prefixes. Two shapes we accept:
      //   [SPEAKER_00] text          ← what our Rust merge writes today
      //   [SPEAKER_00]: text         ← canonical "speaker turn" SRT style
      //   SPEAKER_00: text           ← whisper.cpp tinydiarize when bracketless
      //   [S1] text  / [S1]: text    ← short-form variants
      // The regex below makes the bracket optional, the separator
      // (`:` / `-`) optional, and only REQUIRES at least one space
      // between the tag and the body. Without this fix the merged
      // SRT from saucebunny-diarize parsed but the SPEAKER tag fell
      // off, so every cue showed up as "Speaker" with no diarization.
      const speakerMatch = cleaned.match(
        /^\[?(SPEAKER[_\s-]?\d+|S\d+)\]?\s*[:\-]?\s+(.*)$/i,
      );
      cues.push({
        index: fallbackIdx,
        start,
        end,
        text: speakerMatch ? speakerMatch[2] : cleaned.replace(/\[SPEAKER_TURN\]/g, "").trim(),
        speaker: speakerMatch ? speakerMatch[1].toUpperCase().replace(/[\s-]/g, "_") : null,
      });
    }

    i = j + 1;
  }

  return cues;
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
