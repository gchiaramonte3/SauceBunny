import { forwardRef } from "react";

/**
 * Transcript search row — mode pill (Text / Speakers), the query input,
 * match count, next/previous match buttons, and the "reset speaker names"
 * icon. Extracted from TranscriptViewer.tsx so the viewer stays focused on
 * data + karaoke plumbing; all match STATE (query, matches, cursor) still
 * lives in the viewer, which owns the memos it feeds.
 *
 * The input ref is forwarded so the viewer's scoped ⌘F binding can focus it.
 */

export type SearchMode = "text" | "speakers";

type Props = {
  mode: SearchMode;
  onModeChange: (m: SearchMode) => void;
  query: string;
  onQueryChange: (q: string) => void;
  matchCount: number;
  /** Index of the current match within the match list (0-based). */
  matchCursor: number;
  /** Cycle to the next (+1) / previous (-1) match. */
  onJump: (delta: 1 | -1) => void;
  /** Present only when the user has custom speaker names to reset. */
  onResetNames?: () => void;
};

export const TranscriptSearchBar = forwardRef<HTMLInputElement, Props>(
  function TranscriptSearchBar(
    { mode, onModeChange, query, onQueryChange, matchCount, matchCursor, onJump, onResetNames },
    inputRef,
  ) {
    function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
      if (e.key === "Enter") { e.preventDefault(); onJump(e.shiftKey ? -1 : 1); }
      else if (e.key === "Escape") { e.preventDefault(); onQueryChange(""); }
    }

    return (
      <div className="cp-tx-search">
        {/* Mode pill — Text / Speakers. Two-button segmented control;
            we'll grow it (Markers, Timestamps) as those features land
            but this is what the user asked for now (Avid-style filter). */}
        <div className="cp-tx-search-mode" role="tablist" aria-label="Search mode">
          <button
            role="tab"
            aria-selected={mode === "text"}
            className={"cp-tx-search-mode-btn" + (mode === "text" ? " active" : "")}
            onClick={() => onModeChange("text")}
            title="Search the transcript text"
          >
            Text
          </button>
          <button
            role="tab"
            aria-selected={mode === "speakers"}
            className={"cp-tx-search-mode-btn" + (mode === "speakers" ? " active" : "")}
            onClick={() => onModeChange("speakers")}
            title="Search by speaker name (e.g. 'Tom', 'Speaker 2')"
          >
            Speakers
          </button>
        </div>
        <input
          ref={inputRef}
          className="cp-tx-search-input"
          placeholder={mode === "speakers" ? "Find a speaker…" : "Search transcript…"}
          title={mode === "speakers" ? "Search by speaker name" : "Search the transcript — ⌘F focus · ↩ next · ⇧↩ previous · ⌘G cycles"}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onSearchKey}
          /* Spell-check ON in text mode (Whisper output is prose);
             OFF in speaker mode (names like "Tom" or "Speaker 2" get
             squiggle-underlined as misspellings, which is just noise).
             `lang="en"` is the missing piece that nudges WKWebView to
             pick a real dictionary — without it the underline often
             doesn't render at all (per user screenshot r43 of "Thansky ou"
             not flagged). */
          spellCheck={mode === "text"}
          lang={mode === "text" ? "en" : undefined}
          autoComplete="off"
          autoCorrect={mode === "text" ? "on" : "off"}
        />
        {query && (
          <span className="cp-tx-search-count">
            {matchCount === 0 ? "no matches" : `${matchCursor + 1} / ${matchCount}`}
          </span>
        )}
        {query && (
          <div className="cp-tx-search-nav" role="group" aria-label="Search matches">
            <button
              className="cp-tx-search-nav-btn"
              onClick={() => onJump(-1)}
              disabled={matchCount === 0}
              title="Previous match (⇧↩)"
              aria-label="Previous match"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="18 15 12 9 6 15" />
              </svg>
            </button>
            <button
              className="cp-tx-search-nav-btn"
              onClick={() => onJump(1)}
              disabled={matchCount === 0}
              title="Next match (↩)"
              aria-label="Next match"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          </div>
        )}
        {/* "Follow playback" moved to a floating pill over the transcript
            body (r65) — it was overflowing this row. "Reset names" is a
            compact icon (only when the user has renamed speakers) so the row
            never clips. */}
        {onResetNames && (
          <button
            className="cp-tx-icon-action"
            onClick={onResetNames}
            title="Reset all custom speaker names for this transcript"
            aria-label="Reset speaker names"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.36 2.64L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          </button>
        )}
      </div>
    );
  },
);
