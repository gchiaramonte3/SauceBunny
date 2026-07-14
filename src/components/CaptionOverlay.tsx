import { useEffect, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { parseSrt, type Cue } from "../lib/srt";
import {
  loadSpeakerOverrides,
  resolveSpeakerName,
  resolveSpeakerColor,
  speakerOverridesKey,
  SPEAKERS_CHANGED_EVENT,
  type SpeakerOverrides,
} from "./transcript/helpers";

/** User-tunable caption appearance (Settings → Captions). */
export type CaptionStyle = {
  /** Absolute font size in pixels. */
  sizePx: number;
  /** Font family key — see FONT_STACK (kept in sync with CAP_FONTS in SettingsModal). */
  font:
    | "verdana" | "helvetica" | "arial" | "tahoma" | "trebuchet" | "georgia" | "courier" | "nunito";
  /** Opacity of the dark backing pill, 0–1. */
  bgOpacity: number;
  /** Text colour (hex). */
  color: string;
  /**
   * Seconds to shift the cue lookup, to counteract the streaming-playhead
   * drift (positive = show captions earlier, for when they lag the audio).
   * App passes 0 for accurate paths (local/download) so it only bites on the
   * MSE stream where the playhead runs behind real media time.
   */
  syncSec?: number;
};

// MUST stay in sync with CAP_FONTS in SettingsModal.tsx (same keys + stacks).
const FONT_STACK: Record<CaptionStyle["font"], string> = {
  verdana: "Verdana, Geneva, sans-serif",
  helvetica: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  arial: "Arial, 'Helvetica Neue', sans-serif",
  tahoma: "Tahoma, Geneva, Verdana, sans-serif",
  trebuchet: "'Trebuchet MS', 'Helvetica Neue', sans-serif",
  georgia: "Georgia, 'Times New Roman', serif",
  courier: "'Courier New', Courier, monospace",
  nunito: "'Nunito Sans', system-ui, sans-serif",
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
  /** Bumped by App on every transcript arrival. Regenerate / Fix-timing
   *  overwrite the SAME path, so without this the overlay would keep showing
   *  the old cues the user just paid a Whisper run to replace. */
  reloadToken?: number;
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
export function CaptionOverlay({ path, reloadToken, currentSec, enabled, style }: Props) {
  const [cues, setCues] = useState<Cue[]>([]);
  // The path+token the current `cues` belong to. Guards against showing one
  // source's captions over another's video during the async load gap, while
  // the token component forces a re-read when the SAME path is overwritten.
  const loadedFor = useRef<string | null>(null);
  const loadKey = path ? `${path}#${reloadToken ?? 0}` : null;

  // Speaker renames live in the transcript panel's localStorage store; mirror
  // them here so a rename ("Speaker 1" → "Tom Jonathan") updates the on-video
  // caption immediately. The panel fires SPEAKERS_CHANGED_EVENT on every edit
  // — as a window CustomEvent (same-window) AND a Tauri event (cross-window,
  // for renames made in the popped-out panel). Gated on `enabled`: with
  // captions off there are no listeners, no poll, no reads at all; toggling
  // them back on re-seeds from storage.
  const [overrides, setOverrides] = useState<SpeakerOverrides>(() => loadSpeakerOverrides(path));
  // Last raw localStorage string we applied — skip setState when unchanged so
  // the backstop channels below don't re-render on every check.
  const overridesRawRef = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const key = path ? speakerOverridesKey(path) : null;
    const reload = (force = false) => {
      let raw: string | null = null;
      if (key) { try { raw = localStorage.getItem(key); } catch { /* ignore */ } }
      if (!force && raw === overridesRawRef.current) return;
      overridesRawRef.current = raw;
      setOverrides(loadSpeakerOverrides(path));
    };
    reload(true);
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail || detail.path === path) reload(true);
    };
    // Same-window fast path (the panel fires this on every edit)…
    window.addEventListener(SPEAKERS_CHANGED_EVENT, onChange);
    // …and the cross-WINDOW primary: the same event name over the Tauri bus.
    // (The emitting window also receives its own broadcast — the raw-string
    // dedupe in reload() makes that echo free.)
    let unlistenTauri: UnlistenFn | undefined;
    let cancelled = false;
    void listen<{ path: string | null }>(SPEAKERS_CHANGED_EVENT, (e) => {
      if (cancelled) return;
      if (!e.payload || e.payload.path === path) reload();
    }).then((off) => {
      if (cancelled) off(); else unlistenTauri = off;
    });
    // Backstops, all deduped by raw string so they cost ~nothing: the native
    // `storage` event (cross-window signal WKWebView delivers inconsistently),
    // a focus re-read, and a slow reconciliation poll in case events flake.
    const onStorage = (e: StorageEvent) => { if (!key || e.key === null || e.key === key) reload(); };
    const onFocus = () => reload();
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onFocus);
    const poll = window.setInterval(() => reload(), 5000);
    return () => {
      cancelled = true;
      unlistenTauri?.();
      window.removeEventListener(SPEAKERS_CHANGED_EVENT, onChange);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
      window.clearInterval(poll);
    };
  }, [path, enabled]);

  useEffect(() => {
    if (!path || !loadKey) { setCues([]); loadedFor.current = null; return; }
    // Only read the file once captions are actually on, and only once per
    // path+token — toggling off then on again doesn't re-read, but a
    // regeneration that overwrote the same path (token bump) does.
    if (!enabled || loadedFor.current === loadKey) return;
    let cancelled = false;
    (async () => {
      try {
        const text = await invoke<string>("read_text_file_capped", { path, maxBytes: 8 * 1024 * 1024 });
        if (cancelled) return;
        setCues(parseSrt(text));
        loadedFor.current = loadKey;
      } catch {
        if (!cancelled) { setCues([]); loadedFor.current = null; }
      }
    })();
    return () => { cancelled = true; };
  }, [enabled, path, loadKey]);

  if (!enabled || loadedFor.current !== loadKey || cues.length === 0) return null;
  // Shift the lookup by the user's sync offset (streaming drift correction).
  const t = currentSec + (style?.syncSec ?? 0);
  const active = cues.find((c) => t >= c.start && t < c.end);
  const text = active?.text?.trim();
  if (!text) return null;

  // Apply user prefs as inline overrides; `--cap-size` is the absolute px font
  // size (CSS falls back to a default when no prefs are passed).
  const cueStyle: CSSProperties | undefined = style && {
    ["--cap-size" as string]: `${style.sizePx}px`,
    fontFamily: FONT_STACK[style.font],
    color: style.color,
    background: `rgba(0, 0, 0, ${style.bgOpacity})`,
  } as CSSProperties;

  // Resolve the speaker via the panel's live renames (alias → rename → human).
  // Show a name for the untagged turn too WHEN the transcript has other
  // identified speakers (so a renamed "Unknown speaker" shows here, matching the
  // panel) — but stay label-free for fully un-diarized transcripts.
  const hasIdentifiedSpeakers = cues.some((c) => !!c.speaker);
  const speakerName = active && (active.speaker || hasIdentifiedSpeakers)
    ? resolveSpeakerName(active.speaker ?? null, overrides, { unknownWhenNull: hasIdentifiedSpeakers })
    : null;
  // Colour the name with the same per-speaker hue the roster/bubbles use, so
  // the caption's "Speaker 2:" matches the chip on the right. SOLID colour
  // (speakerTextColor) — a gradient is invalid as CSS `color:` and was silently
  // falling back to the default caption hue, which is why the label colour
  // didn't match the sidebar chip.
  const speakerHue = speakerName
    ? resolveSpeakerColor(active?.speaker ?? null, overrides)
    : undefined;
  // The speaker label now sits on its own line ABOVE the text, so both caption
  // lines get the full budget — no more lonely single-word lines from the
  // prefix eating into line one.
  const lines = splitCaptionLines(text, MAX_LINE);

  return (
    <div className="cp-caption-overlay" aria-live="polite">
      <span className="cp-caption-cue" style={cueStyle}>
        {speakerName && (
          <span className="cp-caption-speaker" style={{ color: speakerHue }}>{speakerName}</span>
        )}
        <span className="cp-caption-line">{lines[0]}</span>
        {lines[1] && <span className="cp-caption-line">{lines[1]}</span>}
      </span>
    </div>
  );
}
