import { useEffect, useRef, useState } from "react";
import { streamChat } from "../lib/ai-chat";
import { formatError } from "../lib/error-format";
import {
  type Chapter, loadChapters, saveChapters, parseChapters,
  buildChapterPrompt, chaptersToYouTube, chapterTimestamp,
} from "../lib/chapters";
import { buildSourcePrefix } from "../lib/prompt-prefix";
import type { LlmServerInfo } from "../bindings/LlmServerInfo";

/** Namespaced like every other preference (storage-keys-contract). */
const COLLAPSE_KEY = "saucebunny.aiChaptersCollapsed";

type Props = {
  /** Source identity to persist under (App's reviewSourceKey), or null. */
  sourceKey: string | null;
  /** Source duration in seconds — clamps model timestamps. Null = unknown. */
  durationSec: number | null;
  /** Timestamped transcript lines (resolved speaker names), or null when the
   *  transcript couldn't be parsed. Same lines the summary prompt is built from. */
  lines: string[] | null;
  /** Bring the llama-server up (AiSummary owns model/server state). `signal`
   *  cancels a load still in flight, not just the token stream that follows. */
  ensureServer: (signal?: AbortSignal) => Promise<LlmServerInfo | null>;
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
  /**
   * Two-click confirm for Clear, rather than a confirm() dialog.
   *
   * Regenerate uses confirm() because it can fire from a keyboard-less path
   * and replaces work silently; Clear is a button you are already looking at,
   * so the confirmation belongs in it. Blur resets, which makes "I did not
   * mean that" a matter of clicking anywhere else.
   */
  const [confirmClear, setConfirmClear] = useState(false);
  /**
   * Collapsed chapter list.
   *
   * A detected list is a dozen-plus rows in a drawer that also has to hold the
   * summary and the chat, and once you have read it you mostly want it out of
   * the way — but not gone, because it is also the seek index. So it folds to
   * its header, which keeps the count and the two actions reachable.
   *
   * Remembered globally rather than per source: the reason to fold it is that
   * the drawer is short, and that is true of the next video too.
   */
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === "1"; } catch { return false; }
  });
  const setCollapsedPersisted = (v: boolean) => {
    setCollapsed(v);
    try { localStorage.setItem(COLLAPSE_KEY, v ? "1" : "0"); } catch { /* private mode */ }
  };
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
    // THE HANDLE BEFORE THE WORK. This used to be created further down, after
    // `await ensureServer()`, and the Stop button is rendered the instant
    // `busy` is true - so for the whole model load, which the comment on that
    // button correctly calls "minutes of prompt ingestion", pressing Stop ran
    // `abortRef.current?.abort()` against null and did nothing at all. Not
    // slowly: silently, because optional chaining on a null ref is a no-op.
    // The rule is CLAUDE.md's: never let an await sit between starting work
    // and holding the handle that cancels it.
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const info = await ensureServer(ctrl.signal);
      // Re-checked after the await, because a signal that fired while nothing
      // was listening leaves no other trace.
      if (ctrl.signal.aborted) return;
      if (!info) { setError("The AI model couldn't start. Check Settings → AI Summary."); return; }
      // Same context math as the summary chat: ~3.5 chars/token, ~65% of the
      // window for the transcript — but sampled EVENLY across the duration
      // (never head-truncated) so late chapters are still found.
      // The SHARED prefix, identical to the one the summary and the chat send,
      // so whichever ran first has already paid for the transcript.
      const { system, sampled } = buildSourcePrefix(lines, info.ctx);
      const raw = await streamChat(
        info, buildChapterPrompt(system, durationSec, sampled),
        // Fifteen chapter lines is ~250 tokens; 600 is headroom, not a target.
        // Before any cap a wandering model could generate for minutes and then
        // have its output rejected by the 3-15 chapter parse anyway.
        () => {}, ctrl.signal, { temperature: 0.2, maxTokens: 600 },
      );
      const parsed = parseChapters(raw, durationSec);
      if (parsed.length < 2) {
        setError("Couldn't detect chapters in this transcript. Try again.");
        return; // keep the existing list, if any
      }
      editedRef.current = false;
      // Always reveal a fresh result. Somebody who folds the list, then clicks
      // Detect and watches the button say "Detecting…" and then nothing appear
      // has been told the feature failed. The remembered preference is about
      // reading room, not about hiding work that was just asked for.
      setCollapsedPersisted(false);
      commit(parsed);
    } catch (e) {
      if (!ctrl.signal.aborted) setError(formatError(e));
    } finally {
      // Ownership-checked, the same discipline the export cancel token uses:
      // a later run may already have installed ITS controller, and blindly
      // nulling would strand that run's Stop button.
      if (abortRef.current === ctrl) abortRef.current = null;
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
      await navigator.clipboard.writeText(chaptersToYouTube(chapters));
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
        {chapters.length > 0 ? (
          // A toggle only once there is something to fold. With no chapters
          // the header is a label, and a disclosure that reveals nothing is
          // just a control that does not work.
          <button
            type="button"
            className="cp-ai-chapters-title as-toggle"
            onClick={() => setCollapsedPersisted(!collapsed)}
            aria-expanded={!collapsed}
            aria-controls="cp-ai-chapter-list"
            title={collapsed ? "Show chapters" : "Hide chapters"}
          >
            <span className={"cp-ai-chapters-caret" + (collapsed ? " closed" : "")} aria-hidden="true">›</span>
            Chapters
            <span className="cp-ai-chapters-count">{chapters.length}</span>
          </button>
        ) : (
          <span className="cp-ai-chapters-title">Chapters</span>
        )}
        {busy ? (
          <>
            <span className="cp-ai-chapters-busy">
              Detecting <span className="cp-ai-typing"><span /><span /><span /></span>
            </span>
            {/* A run against a feature-length transcript is minutes of prompt
                ingestion before a single token comes back, and the abort
                controller that could end it was only ever fired by unmount or
                a source change. Somebody who started it by accident, or picked
                the wrong model, had to sit through it or quit the app. */}
            <button
              className="btn btn-ghost cp-ai-chapters-btn"
              onClick={() => abortRef.current?.abort()}
              title="Stop detecting chapters"
            >
              Stop
            </button>
          </>
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
            {chapters.length > 0 && (
              <button
                className="btn btn-ghost cp-ai-chapters-btn"
                onClick={() => {
                  if (!confirmClear) { setConfirmClear(true); return; }
                  setConfirmClear(false);
                  editedRef.current = false;
                  // Through commit, so the saved copy and the Timeline markers
                  // clear with the list. Setting local state alone would leave
                  // markers on the scrubber for chapters that no longer exist.
                  commit([]);
                }}
                onBlur={() => setConfirmClear(false)}
                title="Remove every chapter for this source"
              >
                {confirmClear ? "Click again to clear" : "Clear"}
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
      {chapters.length > 0 && !collapsed && (
        <ul className="cp-ai-chapter-list" id="cp-ai-chapter-list">
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
