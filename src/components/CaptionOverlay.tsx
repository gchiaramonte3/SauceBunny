import { useEffect, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { parseSrt, type Cue } from "../lib/srt";
import {
  loadSpeakerOverrides,
  resolveAliasChain,
  resolveSpeakerName,
  speakerColor,
  SPEAKERS_CHANGED_EVENT,
  type SpeakerOverrides,
} from "./transcript/helpers";

/** User-tunable caption appearance (Settings → Captions). */
export type CaptionStyle = {
  /** Font-size multiplier on the base responsive size (1 = base). */
  scale: number;
  /** Font family. */
  font: "sans" | "serif" | "mono";
  /** Opacity of the dark backing pill, 0–1. */
  bgOpacity: number;
  /** Text colour (hex). */
  color: string;
};

const FONT_STACK: Record<CaptionStyle["font"], string> = {
  sans: "'Nunito Sans', system-ui, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "ui-monospace, 'SF Mono', Menlo, monospace",
};

const MAX_LINE = 42; // BBC/Netflix Latin-script line length

// A line should not END just before one of these — breaking BEFORE them (so
// they begin the next line) keeps each line a coherent clause, per the
// BBC/Netflix segmentation guidance ("break at clause boundaries").
const CONNECTORS = new Set([
  "and", "but", "or", "nor", "so", "yet", "for",
  "a", "an", "the",
  "to", "of", "in", "on", "at", "by", "with", "from", "into", "onto", "about",
  "as", "if", "that", "than", "then", "when", "while", "who", "which", "whose",
  "is", "was", "are", "were", "be", "been", "being",
]);

/**
 * Split a caption into at most two lines, breaking at the most natural
 * linguistic point — after punctuation first, else before a connector word,
 * else the most balanced space — and keeping each line within the character
 * budget. The speaker prefix (when present) shrinks the first line's budget
 * via `firstMax`. Implements the two-line, ~42-char broadcast convention so
 * lines read as clauses instead of wrapping wherever they happen to fit.
 */
function splitCaptionLines(text: string, firstMax = MAX_LINE, max = MAX_LINE): string[] {
  const t = text.trim();
  if (t.length <= firstMax) return [t];
  const words = t.split(/\s+/);

  // Best single break that keeps BOTH lines within budget.
  const ideal = t.length / 2;
  let bestIdx = -1;
  let bestScore = -Infinity;
  let line1 = 0;
  for (let i = 0; i < words.length - 1; i++) {
    line1 += (i === 0 ? 0 : 1) + words[i].length;
    const line2 = t.length - line1 - 1;
    if (line1 > firstMax || line2 > max) continue;
    let score = -Math.abs(line1 - ideal);            // balance
    if (/[.,;:!?…—–-]$/.test(words[i])) score += 30;  // break right after punctuation
    const next = words[i + 1].toLowerCase().replace(/[^a-z']/g, "");
    if (CONNECTORS.has(next)) score += 12;            // break before a connector
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  if (bestIdx >= 0) {
    return [words.slice(0, bestIdx + 1).join(" "), words.slice(bestIdx + 1).join(" ")];
  }

  // Cue too long for two clean lines: greedily fill, then ellipsize the rest.
  const fill = (budget: number, start: number) => {
    const acc: string[] = [];
    let len = 0;
    let idx = start;
    for (; idx < words.length; idx++) {
      const add = (acc.length ? 1 : 0) + words[idx].length;
      if (len + add > budget) break;
      acc.push(words[idx]);
      len += add;
    }
    return { line: acc.join(" "), next: idx };
  };
  const a = fill(firstMax, 0);
  const b = fill(max - 2, a.next);
  const second = b.next < words.length ? `${b.line} …`.trim() : b.line;
  return [a.line, second].filter(Boolean);
}

type Props = {
  /** Path to the active transcript (SRT/VTT). Null when none is loaded. */
  path: string | null;
  /** Current playhead position, in seconds. */
  currentSec: number;
  /** Whether the captions toggle in the transport bar is on. */
  enabled: boolean;
  /** Appearance overrides; falls back to CSS defaults when omitted. */
  style?: CaptionStyle;
};

/**
 * Subtitle overlay drawn over the video surface. Loads the active
 * transcript's cues (same reader + parser as TranscriptViewer) and shows
 * whichever cue covers the current playhead — like burned-in closed
 * captions, but driven by our own transcript so it works for ANY source
 * (web MSE stream, local file, download fallback) regardless of whether
 * WKWebView would render a native <track>. It also means the diarized
 * speaker name rides along on screen.
 */
export function CaptionOverlay({ path, currentSec, enabled, style }: Props) {
  const [cues, setCues] = useState<Cue[]>([]);
  // The path the current `cues` belong to. Guards against showing one
  // source's captions over another's video during the async load gap.
  const loadedFor = useRef<string | null>(null);

  // Speaker renames live in the transcript panel's localStorage store; mirror
  // them here so a rename ("Speaker 1" → "Tom Jonathan") updates the on-video
  // caption immediately. The panel fires SPEAKERS_CHANGED_EVENT on every edit.
  const [overrides, setOverrides] = useState<SpeakerOverrides>(() => loadSpeakerOverrides(path));
  useEffect(() => {
    const reload = () => setOverrides(loadSpeakerOverrides(path));
    reload();
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail || detail.path === path) reload();
    };
    window.addEventListener(SPEAKERS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(SPEAKERS_CHANGED_EVENT, onChange);
  }, [path]);

  useEffect(() => {
    if (!path) { setCues([]); loadedFor.current = null; return; }
    // Only read the file once captions are actually on, and only once per
    // path — toggling off then on again doesn't re-read.
    if (!enabled || loadedFor.current === path) return;
    let cancelled = false;
    (async () => {
      try {
        const text = await invoke<string>("read_text_file_capped", { path, maxBytes: 8 * 1024 * 1024 });
        if (cancelled) return;
        setCues(parseSrt(text));
        loadedFor.current = path;
      } catch {
        if (!cancelled) { setCues([]); loadedFor.current = null; }
      }
    })();
    return () => { cancelled = true; };
  }, [enabled, path]);

  if (!enabled || loadedFor.current !== path || cues.length === 0) return null;
  const active = cues.find((c) => currentSec >= c.start && currentSec < c.end);
  const text = active?.text?.trim();
  if (!text) return null;

  // Apply user prefs as inline overrides; CSS holds the responsive base
  // (`--cap-scale` multiplies the clamped base font size).
  const cueStyle: CSSProperties | undefined = style && {
    ["--cap-scale" as string]: String(style.scale),
    fontFamily: FONT_STACK[style.font],
    color: style.color,
    background: `rgba(0, 0, 0, ${style.bgOpacity})`,
  } as CSSProperties;

  // Resolve the speaker via the panel's live renames (alias → rename → human).
  const speakerName = active?.speaker ? resolveSpeakerName(active.speaker, overrides) : null;
  // Colour the name with the same per-speaker hue the roster/bubbles use, so
  // the caption's "Speaker 2:" matches the chip on the right.
  const speakerHue = active?.speaker
    ? speakerColor(resolveAliasChain(active.speaker, overrides.aliases))
    : undefined;
  // Two clause-broken lines, with the first line's budget reduced by the
  // speaker prefix so "Tom Jonathan: …" doesn't overflow.
  const firstMax = speakerName ? Math.max(12, MAX_LINE - (speakerName.length + 2)) : MAX_LINE;
  const lines = splitCaptionLines(text, firstMax);

  return (
    <div className="cp-caption-overlay" aria-live="polite">
      <span className="cp-caption-cue" style={cueStyle}>
        <span className="cp-caption-line">
          {speakerName && <b className="cp-caption-speaker" style={{ color: speakerHue }}>{speakerName}: </b>}
          {lines[0]}
        </span>
        {lines[1] && <span className="cp-caption-line">{lines[1]}</span>}
      </span>
    </div>
  );
}
