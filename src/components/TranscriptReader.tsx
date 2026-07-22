import { useEffect, useMemo, useState, type ReactNode } from "react";
import { IconTranscript } from "./Icons";
import {
  loadTranscriptLibrary, groupTranscriptsByFolder, type LibraryTranscript,
} from "../lib/transcript-library";
import { TRANSCRIPTS_CHANGED_EVENT, type TranscriptHistoryEntry } from "../lib/transcript-history";

/**
 * The Transcripts reader — a reading-first workspace OUTSIDE the Clip editor
 * (its own top-level view, under Review in the rail). The text is the focal
 * point: a picker of every transcript on disk on the left, and the selected
 * transcript rendered large on the right.
 *
 * Composition over extraction: the reading pane is the real <TranscriptViewer>,
 * passed in as `children` by App so its full handler bundle stays in App scope
 * (no prop threading, and the delicate viewer is untouched). This shell owns
 * only the picker + layout.
 */
type Props = {
  /** The effective transcript library dir (defaults.transcriptLibrary). */
  transcriptLibraryPath: string;
  /** The transcript currently open in the reading pane (its SRT path). */
  activePath: string | null;
  /** Open a transcript into the reading pane (App reads the SRT + sets the
   *  active transcript, staying in the reader). */
  onOpenTranscript: (entry: TranscriptHistoryEntry) => void;
  /** True while the reader is the active view — gates the (lazy) scan. */
  visible: boolean;
  /** The embedded <TranscriptViewer>, fed by App. Rendered only once a
   *  transcript is selected. */
  children: ReactNode;
};

export function TranscriptReader({ transcriptLibraryPath, activePath, onOpenTranscript, visible, children }: Props) {
  const [list, setList] = useState<LibraryTranscript[]>([]);
  const [tick, setTick] = useState(0);

  // Re-scan when the reader shows, a new transcript lands, or the library path
  // resolves. Mirrors the Home shelf's refresh discipline.
  useEffect(() => { if (visible) setTick((t) => t + 1); }, [visible]);
  useEffect(() => {
    const onChange = () => setTick((t) => t + 1);
    window.addEventListener(TRANSCRIPTS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(TRANSCRIPTS_CHANGED_EVENT, onChange);
  }, []);
  useEffect(() => {
    void tick;
    let alive = true;
    void loadTranscriptLibrary(transcriptLibraryPath).then((l) => { if (alive) setList(l); });
    return () => { alive = false; };
  }, [tick, transcriptLibraryPath]);

  const groups = useMemo(() => groupTranscriptsByFolder(list), [list]);

  return (
    <div className="cp-reader">
      <aside className="cp-reader-picker" aria-label="Transcripts">
        <div className="cp-reader-picker-head">
          <IconTranscript size={16} />
          <span>Transcripts</span>
          <span className="cp-reader-count">{list.length}</span>
        </div>
        <div className="cp-reader-list">
          {groups.map((g) => (
            <section key={g.folder || "root"} className="cp-reader-group">
              <h3 className="cp-reader-group-label">{g.label}</h3>
              {g.items.map((t) => (
                <button
                  key={t.path}
                  type="button"
                  className={"cp-reader-row" + (t.path === activePath ? " active" : "")}
                  onClick={() => onOpenTranscript(t.entry)}
                  aria-current={t.path === activePath ? "true" : undefined}
                  title={t.title}
                >
                  <span className="cp-reader-row-title">{t.title}</span>
                  <span className="cp-reader-row-meta">
                    {t.hasDiarization && <span className="cp-reader-chip">Speakers</span>}
                    {t.hasAnalysis && <span className="cp-reader-chip">Analyzed</span>}
                    <span className="cp-reader-fmt">{t.format}</span>
                  </span>
                </button>
              ))}
            </section>
          ))}
          {list.length === 0 && (
            <div className="cp-reader-empty">No transcripts yet. Generate one from a source in Clip.</div>
          )}
        </div>
      </aside>
      <main className="cp-reader-main">
        {activePath
          ? children
          : (
            <div className="cp-reader-hint">
              <IconTranscript size={28} />
              <p>Pick a transcript to read.</p>
            </div>
          )}
      </main>
    </div>
  );
}
