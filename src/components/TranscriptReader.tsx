import { useEffect, useMemo, useState, type ReactNode } from "react";
import { IconTranscript, IconPanelLeft } from "./Icons";
import { ReaderRowThumb } from "./ReaderRowThumb";
import { ReaderRowMenu, type RowMenuTarget } from "./ReaderRowMenu";
import { organizeTranscripts, type TranscriptSort } from "../lib/transcript-organize";
import {
  loadTranscriptLibrary, type LibraryTranscript,
} from "../lib/transcript-library";
import { TRANSCRIPTS_CHANGED_EVENT, type TranscriptHistoryEntry } from "../lib/transcript-history";
import { buildRecentIndex, transcriptArt } from "../lib/transcript-source-resolve";
import type { RecentSource } from "../lib/recent-sources";
import { WEB_POSTERS_CHANGED_EVENT } from "../lib/web-poster-store";

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
  /** Library's shared thumbnail cache (from useLibraryScan) — same posters the
   *  Library cards use, so a decode is shared across both surfaces. */
  requestThumb: (path: string) => Promise<string | null>;
  posterVersions: Record<string, number>;
  /** Recent sources — lets a source-less transcript row borrow the poster of
   *  the source it was named after (re-association by filename slug). */
  recents: RecentSource[];
  /** The follow-along player panel (App-rendered — a <ReaderPlayerStage>). Docks
   *  as a far-right column, collapses to a thin rail, or floats when popped out. */
  stage?: ReactNode;
  /** A transcript is open, so the player system exists (rail is discoverable). */
  stageAvailable: boolean;
  /** The panel is expanded (docked full-width) vs collapsed to a rail. */
  stageExpanded: boolean;
  /** The panel is popped out to a floating card (the docked slot yields width). */
  stageFloating: boolean;
  /** Bring the player back — expand + re-dock (the rail toggle). */
  onExpandStage: () => void;
  /** The reading pane's active tab — the transcript document vs its AI analysis. */
  docTab: "document" | "analysis";
  onDocTab: (tab: "document" | "analysis") => void;
  /** The AI analysis pane (App-rendered <ReaderAnalysis>), shown on the Analysis tab. */
  analysis?: ReactNode;
  /** Rename a transcript's file on disk (+ carry app references). Throws on failure. */
  onRenameTranscript: (entry: TranscriptHistoryEntry, newStem: string) => Promise<void>;
  /** Move a transcript (+ sidecars) into a folder. Throws on failure. */
  onMoveTranscript: (entry: TranscriptHistoryEntry, destDir: string) => Promise<void>;
  /** The embedded <TranscriptViewer>, fed by App. Rendered only once a
   *  transcript is selected. */
  children: ReactNode;
};

export function TranscriptReader({ transcriptLibraryPath, activePath, onOpenTranscript, visible, requestThumb, posterVersions, recents, stage, stageAvailable, stageExpanded, stageFloating, onExpandStage, docTab, onDocTab, analysis, onRenameTranscript, onMoveTranscript, children }: Props) {
  const [list, setList] = useState<LibraryTranscript[]>([]);
  const [tick, setTick] = useState(0);
  const [rowMenu, setRowMenu] = useState<RowMenuTarget | null>(null);
  const recentIndex = useMemo(() => buildRecentIndex(recents), [recents]);

  // Re-scan when the reader shows, a new transcript lands, or the library path
  // resolves. Mirrors the Home shelf's refresh discipline.
  useEffect(() => { if (visible) setTick((t) => t + 1); }, [visible]);
  useEffect(() => {
    const onChange = () => setTick((t) => t + 1);
    window.addEventListener(TRANSCRIPTS_CHANGED_EVENT, onChange);
    // A web source's poster can land after the list rendered — re-render rowArt.
    window.addEventListener(WEB_POSTERS_CHANGED_EVENT, onChange);
    return () => {
      window.removeEventListener(TRANSCRIPTS_CHANGED_EVENT, onChange);
      window.removeEventListener(WEB_POSTERS_CHANGED_EVENT, onChange);
    };
  }, []);
  useEffect(() => {
    void tick;
    let alive = true;
    void loadTranscriptLibrary(transcriptLibraryPath).then((l) => { if (alive) setList(l); });
    return () => { alive = false; };
  }, [tick, transcriptLibraryPath]);

  // Search is debounced like the Library's (150ms): typing re-filters a
  // hundred-plus rows on every keystroke otherwise.
  const [query, setQuery] = useState("");
  const [needle, setNeedle] = useState("");
  const [sort, setSort] = useState<TranscriptSort>("recent");
  const [speakersOnly, setSpeakersOnly] = useState(false);
  const [analyzedOnly, setAnalyzedOnly] = useState(false);
  useEffect(() => {
    if (query === "") { setNeedle(""); return; }
    const id = window.setTimeout(() => setNeedle(query), 150);
    return () => window.clearTimeout(id);
  }, [query]);
  const organized = useMemo(
    () => organizeTranscripts(list, { query: needle, sort, speakersOnly, analyzedOnly }),
    [list, needle, sort, speakersOnly, analyzedOnly],
  );
  const groups = organized.groups;

  // Move-dialog destinations: the library root + each existing one-level folder.
  const folderOptions = useMemo(() => {
    const root = transcriptLibraryPath.replace(/\/+$/, "");
    const opts = [{ label: "Library root", dir: root }];
    for (const g of groups) {
      if (g.folder) opts.push({ label: g.label, dir: `${root}/${g.folder}` });
    }
    return opts;
  }, [groups, transcriptLibraryPath]);

  // The third grid track sizes to the stage: full when docked-open, a thin rail
  // when collapsed, zero when floating (the panel lifts to a fixed card) or when
  // no transcript is open.
  const stageClass = !stageAvailable ? ""
    : stageFloating ? " stage-float"
    : stageExpanded ? " stage-open"
    : " stage-rail";
  return (
    <div className={"cp-reader" + stageClass}>
      <aside className="cp-reader-picker" aria-label="Transcripts">
        <div className="cp-reader-picker-head">
          <IconTranscript size={16} />
          <span>Transcripts</span>
          {/* "3 of 105" while narrowed — a bare count hides what was filtered
              out, which is the Library status bar's rule too. */}
          <span className="cp-reader-count">
            {organized.shown === organized.total
              ? organized.total
              : `${organized.shown} of ${organized.total}`}
          </span>
        </div>
        <div className="cp-reader-tools">
          <input
            className="cp-reader-search"
            type="search"
            value={query}
            placeholder="Search transcripts…"
            aria-label="Search transcripts"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            className="cp-reader-sort"
            value={sort}
            aria-label="Sort transcripts"
            onChange={(e) => setSort(e.target.value as TranscriptSort)}
          >
            <option value="recent">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="name">By name</option>
            <option value="size">Largest</option>
          </select>
        </div>
        <div className="cp-reader-chips">
          {/* The two badges the rows already wear, as filters. Nothing else is
              worth a chip: every transcript has a date and a format. */}
          <button
            type="button"
            className={"cp-reader-chip" + (speakersOnly ? " on" : "")}
            aria-pressed={speakersOnly}
            onClick={() => setSpeakersOnly((v) => !v)}
          >
            Speakers
          </button>
          <button
            type="button"
            className={"cp-reader-chip" + (analyzedOnly ? " on" : "")}
            aria-pressed={analyzedOnly}
            onClick={() => setAnalyzedOnly((v) => !v)}
          >
            Analyzed
          </button>
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
                  onContextMenu={(e) => { e.preventDefault(); setRowMenu({ entry: t.entry, title: t.title, x: e.clientX, y: e.clientY }); }}
                  aria-current={t.path === activePath ? "true" : undefined}
                  title={t.title}
                >
                  <ReaderRowThumb art={transcriptArt(t, recentIndex)} requestThumb={requestThumb} posterVersions={posterVersions} />
                  <span className="cp-reader-row-body">
                    <span className="cp-reader-row-title">{t.title}</span>
                    <span className="cp-reader-row-meta">
                      {t.hasDiarization && <span className="cp-reader-chip">Speakers</span>}
                      {t.hasAnalysis && <span className="cp-reader-chip">Analyzed</span>}
                      <span className="cp-reader-fmt">{t.format}</span>
                    </span>
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
      <main className="cp-reader-main" aria-label="Transcript">
        {activePath ? (
          <>
            <div className="cp-reader-tabs" role="tablist" aria-label="Transcript view">
              <button
                type="button" role="tab" aria-selected={docTab === "document"}
                className={"cp-reader-tab" + (docTab === "document" ? " active" : "")}
                onClick={() => onDocTab("document")}
              >Document</button>
              <button
                type="button" role="tab" aria-selected={docTab === "analysis"}
                className={"cp-reader-tab" + (docTab === "analysis" ? " active" : "")}
                onClick={() => onDocTab("analysis")}
              >Analysis</button>
            </div>
            {/* Both panes stay mounted (hidden) so switching tabs keeps the
                reader's scroll + the viewer's karaoke highlight alive. */}
            <div className="cp-reader-pane" hidden={docTab !== "document"}>{children}</div>
            <div className="cp-reader-pane" hidden={docTab !== "analysis"}>{analysis}</div>
          </>
        ) : (
          <div className="cp-reader-hint">
            <IconTranscript size={28} />
            <p>Pick a transcript to read.</p>
          </div>
        )}
      </main>
      {stageAvailable && (
        <aside className="cp-reader-stage" aria-label="Player">
          {/* Collapsed & docked → a rail toggle so the player is never just gone. */}
          {!stageExpanded && !stageFloating && (
            <button
              type="button"
              className="cp-reader-stage-expand"
              onClick={onExpandStage}
              title="Show player"
              aria-label="Show player"
            >
              <IconPanelLeft size={16} />
            </button>
          )}
          {/* The panel — one instance, docked or floating (it adds .floating
              itself), so popping out never remounts / reloads the player. */}
          {(stageExpanded || stageFloating) && stage}
        </aside>
      )}
      {rowMenu && (
        <ReaderRowMenu
          target={rowMenu}
          onClose={() => setRowMenu(null)}
          folderOptions={folderOptions}
          libraryPath={transcriptLibraryPath}
          onRename={onRenameTranscript}
          onMove={onMoveTranscript}
        />
      )}
    </div>
  );
}
