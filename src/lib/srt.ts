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
 * Parse `HH:MM:SS,mmm` (SRT), `HH:MM:SS.mmm` (VTT), or the WebVTT
 * optional-hours form `MM:SS.mmm` into seconds. Returns NaN on garbage;
 * the caller filters those out.
 */
function tcToSeconds(tc: string): number {
  // Accept either comma (SRT) or dot (VTT) as the millisecond separator.
  // Some whisper builds emit a 2-digit hour without leading zero — be lenient.
  // The WebVTT spec makes hours OPTIONAL (Rev, Premiere, browser-exported VTT
  // all emit "00:01.000 --> 00:04.000") — without accepting that form a valid
  // imported VTT parses to zero cues and shows "Transcript is empty".
  const m = tc.trim().match(/^(?:(\d{1,2}):)?(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!m) return NaN;
  const h = m[1] ? parseInt(m[1], 10) : 0; // hour group absent in MM:SS.mmm
  const mi = parseInt(m[2], 10);
  const s = parseInt(m[3], 10);
  // Pad ms to 3 digits ("5" → "500", "12" → "120") to keep semantics
  // consistent with how players interpret short fractional strings.
  const msStr = (m[4] + "000").slice(0, 3);
  const ms = parseInt(msStr, 10);
  return h * 3600 + mi * 60 + s + ms / 1000;
}

const TIMESTAMP_LINE = /^\s*((?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*((?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{1,3})/;

// --- speaker extraction patterns ---------------------------------------------

/** WebVTT voice tag: `<v Roger Bingham>` or `<v.loud Roger>` → captures name. */
const VOICE_TAG = /<v(?:\.[^\s>]+)*\s+([^>]*)>/i;
/** Our diarizer's machine labels: `[SPEAKER_00] text`, `S1: text`, and the
 *  explicit `[SPEAKER_UNK]` the diarizer emits for unattributed / non-speech
 *  segments (e.g. "(music)"). UNK is a definite label — without it here the
 *  prefix leaks into the reading text and the segment is mis-coloured as a
 *  null speaker. humanizeSpeakerTag maps SPEAKER_UNK → "Unknown speaker". */
const MACHINE = /^\[?(SPEAKER[_\s-]?(?:\d+|UNK)|S\d+)\]?\s*[:\-]?\s+(.*)$/i;
/** Broadcast speaker change: `>> NAME: text` (the `>>` is unambiguous). */
const CHEVRON = /^>>\s*([^:>]{1,40}):\s*(.*)$/;
/** Plain `NAME: text` — gated by name-shape + cast frequency. */
const COLON = /^([^:]{1,40}):\s+(.+)$/;
/** Bracketed `[NAME] text` / `(NAME): text` — gated like COLON. */
const BRACKET = /^[[(]\s*([^\])]{1,40}?)\s*[\])]\s*:?\s+(.+)$/;
/** A leading `- ` dialogue dash — the turn boundary in creator captions. */
const DIALOGUE_DASH = /^\s*[-–—]\s+/;
/** A leading inline `[Name]` / `(Name)` marker (after stripping any dash). */
const LEAD_NAME = /^\s*[[(]\s*([^\])]{1,30}?)\s*[\])]\s*:?\s*([\s\S]*)$/;
/** A cue that is ONLY a parenthetical/bracketed sound cue, e.g. "(music)". */
const ANNOTATION_ONLY = /^\s*[([][^)\]]*[)\]]\s*$/;

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
    // Entity decoding. &nbsp;/&#160; → plain space (YouTube tracks are full of
    // them; undecoded they render literally in the reader and every export).
    // &amp; must be decoded LAST: doing it first turns "&amp;lt;" into "&lt;"
    // which the next replace double-decodes to "<" instead of the intended
    // literal "&lt;".
    .replace(/&nbsp;/gi, " ")
    .replace(/&#160;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
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

  // YouTube auto-captions are "rolling": each line is repeated across several
  // cues as words scroll up, so a naive parse yields heavy duplication. The
  // signature is inline word-timing (`<00:00:07.200>` / `<c>` tags). When we
  // see it, de-duplicate by overlap after parsing (see dedupeRollingCaptions).
  const rolling = /<c>|<\d{2}:\d{2}:\d{2}\.\d{3}>/.test(text);

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

  const cues = resolveSpeakers(raws);
  const deduped = rolling ? dedupeRollingCaptions(cues) : cues;
  return relocateLeadingPunctuation(deduped);
}

/**
 * Whisper (and some diarizers) occasionally emit a segment whose text begins
 * with the punctuation that actually CLOSES the previous segment's sentence —
 * e.g. cue N = "…how to build something", cue N+1 = ". And so it…". Rendered
 * per-cue (the karaoke highlight, the on-video caption), that surfaces as a
 * stray leading ". " — and across a speaker change the period looks like it
 * spilled onto the next speaker. Move any leading sentence punctuation onto the
 * end of the previous cue so it sits with the word it belongs to. Timing is
 * untouched (punctuation has no audio); only the display text moves.
 */
function relocateLeadingPunctuation(cues: Cue[]): Cue[] {
  if (cues.length < 2) return cues;
  const out = cues.map((c) => ({ ...c }));
  for (let i = 1; i < out.length; i++) {
    // Leading run of sentence punctuation followed by real text. A cue that is
    // ONLY punctuation (e.g. a standalone "..." or "?!" continuation cue) must
    // be left alone: the greedy run would otherwise backtrack and donate
    // all-but-one mark to the previous cue (and across a speaker change),
    // corrupting the transcript. Require the trailing text to contain an actual
    // letter or number before relocating.
    const m = out[i].text.match(/^([.,;:!?]+)\s*(\S[\s\S]*)$/);
    if (!m || !/[\p{L}\p{N}]/u.test(m[2])) continue;
    out[i].text = m[2];
    const prev = out[i - 1].text.replace(/\s+$/, "");
    // Don't double up if the previous cue already ends in sentence punctuation.
    out[i - 1].text = /[.,;:!?]$/.test(prev) ? prev : prev + m[1];
  }
  return out;
}

/**
 * Collapse YouTube's auto-generated "rolling" captions. As words scroll up,
 * each line is repeated across several cues, so a naive parse produces heavy
 * duplication ("Vortex makes a strong, Vortex makes a strong, …"). We merge by
 * overlap: for each cue, drop the leading words that already sit at the tail of
 * what we've emitted and keep only the genuinely new text. Each cue keeps its
 * own start/end, so timing + reading order are preserved. Runs only when the
 * file is detected as rolling (inline word-timing), so normal SRT/VTT and
 * Whisper output pass through untouched.
 */
function dedupeRollingCaptions(cues: Cue[]): Cue[] {
  const out: Cue[] = [];
  let tail: string[] = []; // sliding window of recently-emitted words
  const norm = (s: string) => s.replace(/^>>\s*/, "").replace(/\s+/g, " ").trim();
  for (const c of cues) {
    const words = norm(c.text).split(" ").filter(Boolean);
    if (words.length === 0) continue;
    // Largest k where the emitted tail ends with the cue's first k words.
    let overlap = 0;
    const maxK = Math.min(words.length, tail.length);
    for (let k = maxK; k > 0; k--) {
      const a = tail.slice(tail.length - k).join(" ").toLowerCase();
      const b = words.slice(0, k).join(" ").toLowerCase();
      if (a === b) { overlap = k; break; }
    }
    const fresh = words.slice(overlap);
    if (fresh.length === 0) continue; // entirely a repeat of what we've shown
    out.push({ ...c, text: fresh.join(" ") });
    tail.push(...fresh);
    if (tail.length > 40) tail = tail.slice(-40);
  }
  return out.map((c, i) => ({ ...c, index: i + 1 }));
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

  let resolved = entries.map((e) => {
    let speaker = e.speaker;
    let text = e.text;
    if (e.weak && promote) {
      speaker = e.weak;
      text = text.replace(COLON, "$2").replace(BRACKET, "$2").trim();
    }
    return { start: e.start, end: e.end, speaker, text };
  });

  // Last resort: creator-caption dialogue that marks turns with a leading
  // `- ` dash and names some inline (`- [Vic] …`). Only runs when nothing
  // stronger named anyone, so structured transcripts always win.
  if (!resolved.some((r) => r.speaker !== null)) {
    resolved = attributeDialogueSpeakers(resolved);
  }

  return resolved.map((r, k) => ({ index: k + 1, start: r.start, end: r.end, text: r.text, speaker: r.speaker }));
}

type Row = { start: number; end: number; speaker: string | null; text: string };

/**
 * Speaker attribution for creator captions that mark turns with a leading
 * `- ` dash and name some of them inline — e.g. YouTube's "Very Important
 * People" style: `- [Vic] Today we're giving…`, `- [Boris] …`, with un-named
 * guest lines as plain `- …`. We label every turn the captioner named
 * (carried across that turn's wrapped continuation lines) and leave the rest
 * as a single rename-able "unknown" speaker, so the named cast (Vic, Boris,
 * …) lands in the same roster / rename UI as diarization. Sound cues like
 * "(lively music)" / "(Boris laughs)" are not speakers — `nameShaped` rejects
 * the multi-word lowercase ones, and pure-annotation cues carry no speaker.
 */
function attributeDialogueSpeakers(rows: Row[]): Row[] {
  let dashes = 0;
  let named = 0;
  for (const r of rows) {
    if (DIALOGUE_DASH.test(r.text)) dashes++;
    const m = r.text.replace(DIALOGUE_DASH, "").match(LEAD_NAME);
    if (m && nameShaped(m[1])) named++;
  }
  // Demand real evidence of the format before rewriting anything: at least
  // two inline names and a healthy share of dash-led turns.
  if (named < 2 || dashes < rows.length * 0.15) return rows;

  let current: string | null = null;
  return rows.map((r) => {
    // A standalone sound/music cue isn't speech — drop it out of the running
    // speaker without disturbing who's talking before/after it.
    if (ANNOTATION_ONLY.test(r.text)) return { ...r, speaker: null };

    const isTurn = DIALOGUE_DASH.test(r.text);
    let text = r.text.replace(DIALOGUE_DASH, "");
    const m = text.match(LEAD_NAME);
    let name: string | null = null;
    if (m && nameShaped(m[1])) { name = m[1].trim(); text = m[2].trim(); }

    if (name) current = name;          // named turn → that speaker
    else if (isTurn) current = null;   // new un-named turn → unknown speaker
    // else: a wrapped continuation line → keep whoever was speaking

    return { start: r.start, end: r.end, speaker: current, text: text || r.text };
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
 * Format seconds as an SRT/VTT cue timestamp (`HH:MM:SS,mmm` / `HH:MM:SS.mmm`).
 * Millisecond-rounds first so 1.9996s carries to "00:00:02,000" instead of
 * emitting an out-of-range ",1000".
 */
export function secondsToCueTc(seconds: number, msSep: "," | "." = ","): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  const p = (n: number, w: number) => String(n).padStart(w, "0");
  return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)}${msSep}${p(ms, 3)}`;
}

/** True for our diarizer's machine labels (`SPEAKER_00`, `SPEAKER_UNK`, `S1`). */
const MACHINE_TAG = /^(?:SPEAKER_(?:\d+|UNK)|S\d+)$/;

/**
 * Serialize parsed cues back into SRT (or VTT) text — the inverse of
 * {@link parseSrt}, used by the transcript viewer's inline cue editing to
 * rewrite the transcript file in place. The contract is ROUND-TRIP STABILITY:
 * `parseSrt(serializeCues(cues))` must yield the same cues (same timing, text,
 * speakers), because every consumer (viewer, on-video captions, exports,
 * AI summary) re-parses the file.
 *
 * Speaker encoding, chosen for lossless re-parse:
 *  - machine labels → `[SPEAKER_00] text` (the MACHINE prefix our own
 *    diarizer emits; parseSrt normalizes it back byte-identically)
 *  - human names    → `<v Name>text</v>` (WebVTT voice tag — the ONLY prefix
 *    parseSrt honours unconditionally; `NAME:` / `>> NAME:` are gated by
 *    name-shape heuristics, so e.g. a lowercase name would silently lose its
 *    speaker on re-parse)
 *  - null           → plain text
 *
 * Note the output is normalized (parse transforms like rolling-caption dedupe
 * and punctuation relocation are already baked into the cues) — writing it
 * back intentionally replaces the original producer formatting.
 */
export function serializeCues(cues: Cue[], format: "srt" | "vtt" = "srt"): string {
  const sep = format === "vtt" ? "." : ",";
  const blocks: string[] = [];
  let n = 0;
  for (const c of cues) {
    const text = c.text.replace(/\s+/g, " ").trim();
    if (!text) continue; // parseSrt drops empty cues; don't write what it can't read back
    n += 1;
    let body = text;
    if (c.speaker != null) {
      // ">" would terminate the voice tag early; it can't appear in any tag
      // we produce, but a corrupted one must not corrupt the whole file.
      const safe = c.speaker.replace(/>/g, "").trim();
      if (MACHINE_TAG.test(safe)) body = `[${safe}] ${text}`;
      else if (safe) body = `<v ${safe}>${text}</v>`;
    }
    blocks.push(`${n}\n${secondsToCueTc(c.start, sep)} --> ${secondsToCueTc(c.end, sep)}\n${body}`);
  }
  const joined = blocks.join("\n\n") + (blocks.length ? "\n" : "");
  return format === "vtt" ? "WEBVTT\n\n" + joined : joined;
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
