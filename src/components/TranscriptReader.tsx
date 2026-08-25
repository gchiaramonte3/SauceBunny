import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useCardDrag } from "../hooks/use-card-drag";
import { usePaneWidth } from "../hooks/use-pane-width";
import { invoke } from "@tauri-apps/api/core";
import { IconGrid, IconList, IconPanelLeft, IconPlus, IconTranscript } from "./Icons";
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
import { folderLabel, organizeTranscripts, withEmptyProjects, type TranscriptSort } from "../lib/transcript-organize";
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
   * Which groups the user has OPENED, by folder key ("" is the loose root).
   *
   * FOLDED IS THE DEFAULT. A hundred transcripts across six months is a
   * scroll with no shape when every group is open; folded, the picker is a
   * list of the months and projects you actually have, and you open the one
   * you want. The count stays on every heading, so nothing is hidden - only
   * closed.
   *
   * Stored as the OPEN set rather than the closed one, which is the whole
   * difference: with a closed-set the default is open, and every new month
   * unfolds itself. Whatever the user opens is remembered, so a project
   * someone lives in stays open across launches.
   *
   * A different key from the old closed-set, deliberately: the same list
   * read under the opposite rule would fold exactly the groups someone had
   * chosen to keep open.
   */
  const [choices, setChoices] = useState<ReadonlyMap<string, boolean>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem("saucebunny.readerFolds") ?? "{}");
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return new Map();
      return new Map(Object.entries(raw as Record<string, unknown>)
        .filter((e): e is [string, boolean] => typeof e[1] === "boolean"));
    } catch { return new Map(); }
  });
  // The write lives OUTSIDE the updater. A setState updater has to be pure -
  // React may run it more than once, and StrictMode does so deliberately to
  // surface exactly this - so persisting in there makes the stored value
  // depend on which invocation React kept. Same mistake, same fix, as the
  // web pane's view prefs. The ref mirrors state so reading it here is
  // race-free rather than a stale closure.
  const choicesRef = useRef(choices);
  choicesRef.current = choices;
  /**
   * Is this group showing its rows?
   *
   * AN EXPLICIT CHOICE ALWAYS WINS. This used to be a set of open folders
   * plus two overrides that forced a group open regardless - and one of
   * those overrides made its own chevron dead: the group holding the
   * transcript you are reading re-opened itself on every render, so
   * clicking to close it did nothing at all. An override that outranks the
   * user is not a default, it is a broken control.
   *
   * So the stored value is a MAP of decisions rather than a set of open
   * folders. No entry means "no opinion yet", and only then do the defaults
   * apply:
   *
   * - THE SEARCH RESULTS open. A needle collapses everything into one
   *   synthetic group; folded, a search returns a heading and no rows, which
   *   reads as "nothing found" for a query that matched. There is also no
   *   chevron worth clicking on a group that exists only while you type.
   * - THE GROUP HOLDING THE OPEN TRANSCRIPT opens, so arriving with
   *   something already loaded shows you where you are - until you say
   *   otherwise.
   * - Everything else starts folded.
   */
  const isOpen = useCallback((folder: string, holdsActive: boolean) => {
    if (folder === "__results__") return true;
    const choice = choices.get(folder);
    if (choice !== undefined) return choice;
    return holdsActive;
  }, [choices]);

  const toggleGroup = useCallback((folder: string, holdsActive: boolean) => {
    const cur = choicesRef.current;
    const wasOpen = cur.get(folder) ?? holdsActive;
    const next = new Map(cur);
    next.set(folder, !wasOpen);
    // Outside the updater, which has to stay pure.
    try {
      localStorage.setItem("saucebunny.readerFolds", JSON.stringify(Object.fromEntries(next)));
    } catch { /* quota */ }
    setChoices(next);
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

  /**
   * Folders a transcript can actually be moved INTO: the real one-level
   * listing from disk, never the display groups.
   *
   * Groups are the wrong source and were being used as one. A group's key is
   * whatever the scan reported as the transcript's IMMEDIATE parent, so a
   * folder nested two deep yields a bare name that does not exist at the
   * root - and `${root}/${name}` then addresses a DIFFERENT directory that
   * might well exist, which is a silent misfile rather than an error. While
   * a search is running the single group's key is the pseudo-value
   * `__results__`, so the move dialog was offering "3 matches" as a
   * destination pointing at a directory that has never existed.
   *
   * `list_transcript_folders` returns exactly the one-level subfolders, which
   * is exactly the set that `${root}/${name}` addresses correctly.
   */
  const moveTargets = useMemo(
    () => new Set(folders ?? []),
    [folders],
  );
  const folderOptions = useMemo(() => {
    const root = transcriptLibraryPath.replace(/\/+$/, "");
    return [
      { label: "Library root", dir: root },
      ...[...moveTargets].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .map((folder) => ({ label: folderLabel(folder), dir: `${root}/${folder}` })),
    ];
  }, [moveTargets, transcriptLibraryPath]);

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
  // The picker was a fixed 300px column: a long project name simply
  // truncated and there was nothing to do about it. Same resizer the Library
  // tree mounts, so the two panes cannot drift apart.
  /**
   * Compact rows: name and chips, no poster.
   *
   * The picker's row is a 52px thumbnail and two lines, which is right when
   * you are recognising a film by its frame and wrong when you are looking
   * down a list of a hundred named episodes. The Library already offers both
   * readings of the same shelf; this is that toggle, in the one place the
   * app renders a wall of transcripts.
   */
  const [compact, setCompact] = useState(() => {
    try { return localStorage.getItem("saucebunny.readerCompact") === "1"; } catch { return false; }
  });
  const toggleCompact = useCallback(() => {
    setCompact((prev) => {
      const next = !prev;
      return next;
    });
  }, []);
  // Persisted OUTSIDE the updater, which must stay pure.
  useEffect(() => {
    try { localStorage.setItem("saucebunny.readerCompact", compact ? "1" : "0"); } catch { /* quota */ }
  }, [compact]);

  const PICKER_W_DEFAULT = 300;
  const {
    width: pickerWidth, resizing: pickerResizing,
    onMouseDown: onPickerResize, onKeyDown: onPickerResizeKey,
  } = usePaneWidth({
    key: "saucebunny.readerPickerWidth",
    min: 232, max: 520, fallback: PICKER_W_DEFAULT,
  });

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
      // CAUGHT, like the row menu's copy of this call. The move can be
      // refused - a name collision in the destination is the ordinary case -
      // and a bare `void` on a rejecting promise is an unhandled rejection
      // that the user never sees and console-clean fails on. A drag has no
      // dialog to report into, so it borrows the picker's error line.
      setProjectErr(null);
      void onMoveTranscript(hit.entry, `${transcriptLibraryPath}/${folder}`)
        .catch((e) => setProjectErr(formatError(e)));
    },
  });

  return (
    <div
      className={"cp-reader" + stageClass}
      style={{ ["--reader-picker-w" as string]: `${pickerWidth}px` }}
    >
      <aside
        className={"cp-reader-picker" + (compact ? " compact" : "")}
        aria-label="Transcripts"
        {...rowDrag.handlers}
      >
        <div
          className={"cp-reader-picker-resize cp-resize-handle vertical" + (pickerResizing ? " dragging" : "")}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the transcripts panel"
          tabIndex={0}
          onMouseDown={onPickerResize}
          onKeyDown={onPickerResizeKey}
          title="Drag to resize · arrow keys to nudge · Home to reset"
        />
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
          {/* The SAME control the Library and the shelves mount, down to the
              class, so "make a container here" looks and behaves identically
              wherever you are. It said only "+" before, which is the one
              place in the app where that verb had no name on it. A project
              IS a folder here, so the label says so. */}
          <button
            type="button"
            className="cp-reader-viewtoggle"
            title={compact ? "Show posters" : "Compact list"}
            aria-label={compact ? "Show posters" : "Compact list"}
            aria-pressed={compact}
            onClick={toggleCompact}
          >
            {compact ? <IconGrid size={13} /> : <IconList size={13} />}
          </button>
          <button
            type="button"
            className="cp-newfolder-btn"
            title="New project"
            aria-label="New project"
            aria-expanded={newProject !== null}
            onClick={() => setNewProject((v) => (v === null ? "" : null))}
          >
            <IconPlus size={12} />
            New project
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
              className="cp-newfolder-input"
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
                collapsed={!isOpen(g.folder, g.items.some((t) => t.path === activePath))}
                onToggle={() => toggleGroup(g.folder, g.items.some((t) => t.path === activePath))}
                dropKey={moveTargets.has(g.folder) ? g.folder : undefined}
                dropActive={rowDrag.drag?.over === g.folder}
              />
              {isOpen(g.folder, false) && g.items.length === 0 && (
                <p className="cp-reader-group-empty">Nothing here yet. Drag a transcript onto this heading, or move one in from its row menu.</p>
              )}
              {isOpen(g.folder, g.items.some((t) => t.path === activePath)) && g.items.map((t) => (
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
