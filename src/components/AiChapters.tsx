import { useEffect, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { streamChat } from "../lib/ai-chat";
import { formatError } from "../lib/error-format";
import {
  type Chapter, loadChapters, saveChapters, parseChapters,
  buildChapterPrompt, sampleTranscriptEvenly, chaptersToYouTube, chapterTimestamp,
} from "../lib/chapters";
import type { LlmServerInfo } from "../bindings/LlmServerInfo";

type Props = {
  /** Source identity to persist under (App's reviewSourceKey), or null. */
  sourceKey: string | null;
  /** Source duration in seconds — clamps model timestamps. Null = unknown. */
  durationSec: number | null;
  /** Timestamped transcript lines (resolved speaker names), or null when the
   *  transcript couldn't be parsed. Same lines the summary prompt is built from. */
  lines: string[] | null;
  /** Bring the llama-server up (AiSummary owns model/server state). */
  ensureServer: () => Promise<LlmServerInfo | null>;
  /** True while the chat is streaming — one model call at a time. */
  chatBusy: boolean;
  /** Mirror of the mutual exclusion in the other direction: reports the
   *  chapters run's busy state up so the parent can lock its chat composer
   *  while a detection streams from the same single llama-server. */
  onBusyChange?: (busy: boolean) => void;
  /** Seek playback to a chapter start (seconds). */
  onSeek?: (seconds: number) => void;
  /** Chapters changed (generate/delete) — the popped-out panel forwards this
   *  over the panel bus so the MAIN window's timeline markers re-read. In the
   *  docked drawer the CHAPTERS_CHANGED_EVENT dispatch already covers it. */
  onChaptersChanged?: () => void;
};

/**
 * Auto-chapters block for the AI Summary tab: detect chapters from the
 * transcript with the local LLM, list them (click → seek, × → delete), and
 * copy the list as YouTube-description chapter text. Chapters persist per
 * source in localStorage (lib/chapters.ts) and feed the Timeline's markers.
 */
export function AiChapters({
  sourceKey, durationSec, lines, ensureServer, chatBusy, onBusyChange, onSeek, onChaptersChanged,
}: Props) {
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Any deletion since the last generate → Regenerate asks before replacing.
  const editedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // (Re)load the persisted list when the source changes.
  useEffect(() => {
    setChapters(sourceKey ? loadChapters(sourceKey) : []);
    setError(null);
    editedRef.current = false;
  }, [sourceKey]);

  // Abort an in-flight detection on unmount / source change.
  useEffect(() => () => abortRef.current?.abort(), [sourceKey]);

  const commit = (next: Chapter[]) => {
    setChapters(next);
    if (sourceKey) saveChapters(sourceKey, next);
    onChaptersChanged?.();
  };

  async function detect() {
    if (busy || chatBusy || !lines || lines.length === 0) return;
    if (chapters.length > 0 && editedRef.current
      && !confirm("Regenerate chapters? Your edits to the current list will be replaced.")) return;
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    try {
      const info = await ensureServer();
      if (!info) { setError("The AI model couldn't start — check Settings → AI Summary."); return; }
      // Same context math as the summary chat: ~3.5 chars/token, ~65% of the
      // window for the transcript — but sampled EVENLY across the duration
      // (never head-truncated) so late chapters are still found.
      const budget = Math.floor(info.ctx * 3.5 * 0.65);
      const { text, sampled } = sampleTranscriptEvenly(lines, budget);
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const raw = await streamChat(
        info, buildChapterPrompt(text, durationSec, sampled),
        () => {}, ctrl.signal, { temperature: 0.2 },
      );
      const parsed = parseChapters(raw, durationSec);
      if (parsed.length < 2) {
        setError("Couldn't detect chapters in this transcript — try again.");
        return; // keep the existing list, if any
      }
      editedRef.current = false;
      commit(parsed);
    } catch (e) {
      if (!abortRef.current?.signal.aborted) setError(formatError(e));
    } finally {
      abortRef.current = null;
      setBusy(false);
      onBusyChange?.(false);
    }
  }

  function removeAt(i: number) {
    editedRef.current = true;
    commit(chapters.filter((_, idx) => idx !== i));
  }

  async function copyForYouTube() {
    try {
      await writeText(chaptersToYouTube(chapters));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard unavailable */ }
  }

  const canDetect = !busy && !chatBusy && !!lines && lines.length > 0;
  const hint = !lines || lines.length === 0
    ? "No readable transcript to detect chapters from"
    : chatBusy
      ? "Wait for the current answer to finish"
      : "Ask the local AI to split this video into chapters";
  const long = chapters.some((c) => c.time >= 3600);

  return (
    <div className="cp-ai-chapters">
      <div className="cp-ai-chapters-head">
        <span className="cp-ai-chapters-title">Chapters</span>
        {busy ? (
          <span className="cp-ai-chapters-busy">
            Detecting <span className="cp-ai-typing"><span /><span /><span /></span>
          </span>
        ) : (
          <>
            {chapters.length > 0 && (
              <button
                className="btn btn-ghost cp-ai-chapters-btn"
                onClick={copyForYouTube}
                title="Copy as YouTube-description chapter lines"
              >
                {copied ? "Copied" : "Copy for YouTube"}
              </button>
            )}
            <button
              className="btn btn-ghost cp-ai-chapters-btn"
              onClick={detect}
              disabled={!canDetect}
              title={hint}
            >
              {chapters.length > 0 ? "Regenerate" : "Detect chapters"}
            </button>
          </>
        )}
      </div>
      {error && <div className="cp-ai-error" role="alert">{error}</div>}
      {chapters.length > 0 && (
        <ul className="cp-ai-chapter-list">
          {chapters.map((c, i) => (
            <li key={`${c.time}-${c.title}`} className="cp-ai-chapter-row">
              <button
                className="cp-ai-chapter-jump"
                onClick={() => onSeek?.(c.time)}
                title="Jump to this chapter"
              >
                <span className="cp-ai-chapter-tc">{chapterTimestamp(c.time, long)}</span>
                <span className="cp-ai-chapter-name">{c.title}</span>
              </button>
              <button
                className="cp-ai-chapter-del"
                onClick={() => removeAt(i)}
                title="Remove this chapter"
                aria-label={`Remove chapter ${c.title}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
