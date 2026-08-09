import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { IconSearch, IconTranscript } from "./Icons";
import { fmtTime } from "../lib/srt";
import { useTranscriptSearch } from "../hooks/use-transcript-search";

/**
 * Search every transcript in the library, and jump to the line.
 *
 * The app has always transcribed everything into one folder and then had no
 * way to look across it: you could search the transcript that happened to be
 * open, and that was all. This answers "which clip has someone saying X",
 * which is the question a shelf of transcripts exists to answer.
 *
 * GROUPED BY SOURCE, not a flat list of lines. A phrase that appears nine
 * times in one episode and once in another is two answers, not ten, and the
 * flat version buries the second under the first.
 *
 * The index builds on open, not at boot — see the hook for why.
 */
export function TranscriptSearchModal({
  onClose, onOpenAt,
}: {
  onClose: () => void;
  /** Open this transcript's source and seek to `seconds`. */
  onOpenAt: (path: string, seconds: number) => void;
}) {
  const { state, query, setQuery, build, hits, groups } = useTranscriptSearch();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void build();
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [build]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const busy = state.status === "indexing";
  const typed = query.trim().length >= 2;

  return createPortal(
    <div className="cp-modal-scrim" onMouseDown={onClose}>
      <div
        className="cp-txsearch"
        role="dialog"
        aria-label="Search transcripts"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="cp-txsearch-head">
          <IconSearch size={15} />
          <input
            ref={inputRef}
            className="cp-txsearch-input"
            placeholder="Search every transcript"
            value={query}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="cp-txsearch-scope">
            {busy ? "Reading transcripts…" : `${state.count} transcripts`}
          </span>
        </div>

        <div className="cp-txsearch-body">
          {state.status === "error" && (
            <p className="cp-txsearch-note">Could not read the transcript library. {state.error}</p>
          )}
          {!busy && state.status === "ready" && state.count === 0 && (
            <p className="cp-txsearch-note">
              No transcripts yet. Transcribe something and it becomes searchable here.
            </p>
          )}
          {!busy && state.count > 0 && !typed && (
            <p className="cp-txsearch-note">
              Type at least two characters. Phrases work, and they are found even
              when the words fall across two caption lines.
            </p>
          )}
          {!busy && typed && hits.length === 0 && (
            <p className="cp-txsearch-note">Nothing matches that.</p>
          )}

          {typed && groups.map((g) => (
            <div key={g.path} className="cp-txsearch-group">
              <div className="cp-txsearch-source">
                <IconTranscript size={13} />
                <span className="cp-txsearch-title">{g.title}</span>
                <span className="cp-txsearch-n">
                  {g.hits.length === 1 ? "1 line" : `${g.hits.length} lines`}
                </span>
              </div>
              {g.hits.map((h) => (
                <button
                  key={`${h.path}#${h.cueIndex}#${h.matchStart}`}
                  className="cp-txsearch-hit"
                  onClick={() => { onOpenAt(h.path, h.start); onClose(); }}
                  title={`Open at ${fmtTime(h.start)}`}
                >
                  <span className="cp-txsearch-tc">{fmtTime(h.start)}</span>
                  {h.speaker && <span className="cp-txsearch-spk">{h.speaker}</span>}
                  <span className="cp-txsearch-text">
                    {h.text.slice(0, h.matchStart)}
                    <mark>{h.text.slice(h.matchStart, h.matchEnd)}</mark>
                    {h.text.slice(h.matchEnd)}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
