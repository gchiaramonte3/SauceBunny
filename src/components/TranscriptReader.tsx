import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useCardDrag } from "../hooks/use-card-drag";
import { invoke } from "@tauri-apps/api/core";
import { IconTranscript, IconPanelLeft, IconPlus } from "./Icons";
import { formatError } from "../lib/error-format";
import { ReaderRowThumb } from "./ReaderRowThumb";
import { ReaderRowMenu, type RowMenuTarget } from "./ReaderRowMenu";
import { ReaderProjectHeader } from "./ReaderProjectHeader";
import { ProjectMenu, type ProjectMenuTarget } from "./ProjectMenu";
import { isProjectFolder, projectFor, projectPosterSource } from "../lib/transcript-projects";
import {
  editProject, forgetProject, getProjects, hydrateProjects, renameProject,
  subscribeProjects, syncProjectFolders,
} from "../lib/transcript-project-store";
import { organizeTranscripts, withEmptyProjects, type TranscriptSort } from "../lib/transcript-organize";
import {
  loadTranscriptLibrary, type LibraryTranscript,
} from "../lib/transcript-library";
import { TRANSCRIPTS_CHANGED_EVENT, renameEntryPath, type TranscriptHistoryEntry } from "../lib/transcript-history";
import { renameSpeakerOverridesPath } from "./transcript/helpers";
import { carriedPaths } from "../lib/project-rename-carry";
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
  /** Import an .srt/.vtt from disk. Works with no source loaded. */
  onImportTranscript: () => void;
  /** Take the user to Clip, where a transcript gets generated. */
  onGoToClip: () => void;
  /** The embedded <TranscriptViewer>, fed by App. Rendered only once a
   *  transcript is selected. */
  children: ReactNode;
};

export function TranscriptReader({ transcriptLibraryPath, activePath, onOpenTranscript, visible, requestThumb, posterVersions, recents, stage, stageAvailable, stageExpanded, stageFloating, onExpandStage, docTab, onDocTab, analysis, onRenameTranscript, onMoveTranscript, onImportTranscript, onGoToClip, children }: Props) {
  const [list, setList] = useState<LibraryTranscript[]>([]);
  const [tick, setTick] = useState(0);
  const [rowMenu, setRowMenu] = useState<RowMenuTarget | null>(null);
  const [projectMenu, setProjectMenu] = useState<ProjectMenuTarget | null>(null);
  const [newProject, setNewProject] = useState<string | null>(null);
  const [projectTick, setProjectTick] = useState(0);
  const [projectErr, setProjectErr] = useState<string | null>(null);
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
    void loadTranscriptLibrary(transcriptLibraryPath).then((l) => {
      if (!alive) return;
      setList(l);
    });
    return () => { alive = false; };
  }, [tick, transcriptLibraryPath]);

  // Project metadata: hydrate once, then reconcile against whatever folders
  // the scan actually found. The FILESYSTEM wins - a folder made or removed in
  // Finder has to show up here, or the panel and the disk tell two different
  // stories.
  useEffect(() => subscribeProjects(() => setProjectTick((t) => t + 1)), []);
  // Read from DISK, not from the scan.
  //
  // This used to collect `t.folder` off the scanned transcripts, which meant a
  // folder existed only while something was already filed in it. Two bugs fell
  // out of that, and they are the same bug: New Project created a directory
  // the shelf could never show (so the button did nothing), and moving the
  // last transcript out of a project reconciled it away, taking its title,
  // poster and colour with it on the next write.
  //
  // A project IS a directory, so the directory listing is the truth.
  const [folders, setFolders] = useState<string[] | null>(null);
  useEffect(() => {
    void tick;
    let alive = true;
    void invoke<string[]>("list_transcript_folders", { libraryPath: transcriptLibraryPath })
      .then((f) => { if (alive) setFolders(f); })
      .catch(() => { if (alive) setFolders([]); });
    return () => { alive = false; };
  }, [tick, transcriptLibraryPath]);
  // Not until the folder listing has actually returned, which is why `folders`
  // is `null` until then rather than `[]`. Hydrating against an empty list
  // reconciles every stored project away as "not on disk", and the next sync
  // writes that back - posters and colours gone on every boot, from a list
  // that only meant "the read has not finished". The two states have to be
  // distinguishable or the guard is guessing.
  useEffect(() => {
    if (folders === null) return;
    void hydrateProjects(transcriptLibraryPath, folders);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hydrate once, on the first real list
  }, [folders !== null]);
  useEffect(() => { if (folders !== null) syncProjectFolders(folders); }, [folders]);
  const projects = useMemo(() => { void projectTick; return getProjects(); }, [projectTick]);

  /**
   * Which groups are collapsed, by folder key ("" is the loose root).
   *
   * Persisted, because a collapse is a filing decision rather than a scroll
   * position: someone who folds away six months of old work expects it folded
   * tomorrow. Stored as a list of the CLOSED ones, so a new project or a new
   * month arrives open - the opposite default would hide work the moment it
   * appeared.
   */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem("saucebunny.readerCollapsed") ?? "[]");
      return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
    } catch { return new Set(); }
  });
  // The write lives OUTSIDE the updater. A setState updater has to be pure -
  // React may run it more than once, and StrictMode does so deliberately to
  // surface exactly this - so persisting in there makes the stored value
  // depend on which invocation React kept. Same mistake, same fix, as the
  // web pane's view prefs. The ref mirrors state so reading it here is
  // race-free rather than a stale closure.
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const toggleGroup = useCallback((folder: string) => {
    const next = new Set(collapsedRef.current);
    if (next.has(folder)) next.delete(folder); else next.add(folder);
    try { localStorage.setItem("saucebunny.readerCollapsed", JSON.stringify([...next])); } catch { /* quota */ }
    setCollapsed(next);
  }, []);

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
  // Projects the scan found no transcripts in still belong on the shelf - see
  // withEmptyProjects. `projects` is the reconciled list, so this is every
  // project folder on disk, not only the ones that happen to hold something.
  const groups = useMemo(
    () => withEmptyProjects(organized.groups, projects.map((p) => p.folder), organized.searching),
    [organized, projects],
  );

  /** The art for a project's picture: the chosen transcript's, else the newest
   *  one's. Same `transcriptArt` the rows use, so nothing decodes twice. */
  function posterArtFor(folder: string, items: LibraryTranscript[]) {
    const path = projectPosterSource(projectFor(projects, folder), items);
    const t = items.find((i) => i.path === path);
    return t ? transcriptArt(t, recentIndex) : null;
  }

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
  const entryByPath = useMemo(() => {
    const m = new Map<string, { entry: TranscriptHistoryEntry; folder: string }>();
    for (const g of organized.groups) {
      for (const t of g.items) m.set(t.path, { entry: t.entry, folder: g.folder });
    }
    return m;
  }, [organized.groups]);

  // Filing a transcript by dragging its row onto a group heading.
  //
  // BOTH kinds of heading are destinations, because both are real
  // directories: a project at the library root, and the dated YYYY-MM bucket
  // a transcript came from. Without the second, a transcript dragged into a
  // project could only be got back out through the row menu.
  //
  // A COLLAPSED project is still a target, and is the one that matters most -
  // once the picker has any history in it, the folded heading is the compact
  // thing you can actually aim at.
  const rowDrag = useCardDrag({
    itemSelector: ".cp-reader-row",
    targetSelector: "[data-drop]",
    targetAttr: "data-drop",
    // No multi-select in the picker, so a drag is always the one row.
    pathsFor: (path: string) => [path],
    onDrop: (folder: string, paths: readonly string[]) => {
      const path = paths[0];
      const hit = path ? entryByPath.get(path) : undefined;
      // Dropping something back where it already lives is a no-op rather than
      // a move. The command returns early on its own, but a rescan would
      // still churn the picker for nothing.
      if (!hit || hit.folder === folder) return;
      void onMoveTranscript(hit.entry, `${transcriptLibraryPath}/${folder}`);
    },
  });

  return (
    <div className={"cp-reader" + stageClass}>
      <aside
        className="cp-reader-picker"
        aria-label="Transcripts"
        {...rowDrag.handlers}
      >
        {rowDrag.drag && (
          <div
            className="cp-card-ghost"
            aria-hidden="true"
            style={{ left: rowDrag.drag.x, top: rowDrag.drag.y }}
          >
            1 transcript
          </div>
        )}
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
          <button
            type="button"
            className="cp-reader-newproject"
            title="New project"
            aria-label="New project"
            aria-expanded={newProject !== null}
            onClick={() => setNewProject((v) => (v === null ? "" : null))}
          >
            <IconPlus size={14} />
          </button>
        </div>
        {/* Inline, not a dialog: making a project is creating an empty folder,
            and the thing you do next is drag transcripts into it. A modal for
            that puts a ceremony in front of a `mkdir`. */}
        {newProject !== null && (
          <form
            className="cp-reader-newproject-row"
            onSubmit={(e) => {
              e.preventDefault();
              const name = newProject.trim();
              if (!name) return;
              void invoke("create_transcript_folder", { libraryPath: transcriptLibraryPath, name })
                .then(() => { setNewProject(null); setTick((t) => t + 1); })
                .catch((err) => setProjectErr(formatError(err)));
            }}
          >
            <input
              className="cp-reader-newproject-input"
              value={newProject}
              autoFocus
              spellCheck={false}
              placeholder="Project name…"
              aria-label="New project name"
              onChange={(e) => { setNewProject(e.target.value); setProjectErr(null); }}
              onKeyDown={(e) => { if (e.key === "Escape") { setNewProject(null); setProjectErr(null); } }}
            />
            <button className="btn cp-tx-iconbtn" type="submit" disabled={!newProject.trim()}>Create</button>
          </form>
        )}
        {projectErr && <p className="cp-reader-project-err">{projectErr}</p>}
        {/* Search, sort and the two chips are hidden when the list is empty.
            Filtering nothing is chrome that cannot do anything, and on a fresh
            install it was the bulk of what this pane showed. */}
        {organized.total > 0 && <div className="cp-reader-tools">
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
        </div>}
        {organized.total > 0 && <div className="cp-reader-chips">
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
        </div>}
        <div className="cp-reader-list">
          {groups.map((g) => (
            <section key={g.folder || "root"} className="cp-reader-group">
              <ReaderProjectHeader
                label={projectFor(projects, g.folder)?.title || g.label}
                count={g.items.length}
                art={posterArtFor(g.folder, g.items)}
                isProject={isProjectFolder(g.folder)}
                accent={projectFor(projects, g.folder)?.color ?? null}
                requestThumb={requestThumb}
                posterVersions={posterVersions}
                onMenu={(x, y) => setProjectMenu({
                  folder: g.folder,
                  title: projectFor(projects, g.folder)?.title || g.label,
                  items: g.items.map((t) => ({ path: t.path, title: t.title })),
                  posterFrom: projectFor(projects, g.folder)?.posterFrom ?? null,
                  x, y,
                })}
                collapsed={collapsed.has(g.folder)}
                onToggle={() => toggleGroup(g.folder)}
                dropKey={g.folder}
                dropActive={rowDrag.drag?.over === g.folder}
              />
              {!collapsed.has(g.folder) && g.items.length === 0 && (
                <p className="cp-reader-group-empty">Nothing here yet. Drag a transcript onto this heading, or move one in from its row menu.</p>
              )}
              {!collapsed.has(g.folder) && g.items.map((t) => (
                <button
                  key={t.path}
                  type="button"
                  className={"cp-reader-row" + (t.path === activePath ? " active" : "")}
                  data-path={t.path}
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
          {list.length === 0 && groups.length === 0 && (
            <div className="cp-reader-empty">
              <p>No transcripts yet.</p>
              {/* Two buttons, because there are two ways to get one and the
                  view named Transcripts previously offered neither. Import
                  works with no source loaded - the reader just never wired it
                  up - and a folder of .srt from a transcription service is a
                  normal way to arrive here. */}
              <div className="cp-reader-empty-actions">
                <button type="button" className="btn cp-tx-iconbtn" onClick={onImportTranscript}>
                  Import a transcript…
                </button>
                <button type="button" className="btn btn-ghost cp-tx-iconbtn" onClick={onGoToClip}>
                  Make one in Clip
                </button>
              </div>
            </div>
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
            <p>{list.length === 0 ? "Nothing to read yet." : "Pick a transcript to read."}</p>
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
      {projectMenu && (
        <ProjectMenu
          target={projectMenu}
          libraryPath={transcriptLibraryPath}
          onClose={() => setProjectMenu(null)}
          onRenamed={(from, to) => {
            // The directory moved, so every transcript inside it has a new
            // absolute path - and history entries and speaker overrides are
            // both keyed by that path. Carrying them is what makes the
            // dialog's promise ("the transcripts inside it move with it and
            // keep working") true: without it the source link and every
            // speaker name someone typed are orphaned, and the stale history
            // entries re-render as duplicate rows pointing at files that are
            // no longer there.
            const root = transcriptLibraryPath.replace(/\/+$/, "");
            for (const { from: was, to: now } of carriedPaths(
              list.map((t) => t.path), `${root}/${from}`, `${root}/${to}`,
            )) {
              renameEntryPath(was, now);
              renameSpeakerOverridesPath(was, now);
            }
            renameProject(from, to);
            setTick((t) => t + 1);
          }}
          onDeleted={(folder) => { forgetProject(folder); setTick((t) => t + 1); }}
          onPickPoster={(folder, path) => editProject(folder, { posterFrom: path })}
        />
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
