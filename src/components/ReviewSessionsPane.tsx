import { useEffect, useMemo, useRef, useState } from "react";
import {
  hydrateScreeningIndex, listScreenings, loadScreening, SCREENINGS_CHANGED,
  type ScreeningIndexEntry,
} from "../lib/screening-store";
import { listFillPhase, LASSO_GUTTER_SELECTOR } from "../lib/library";
import type { LibrarySortDir, LibrarySortKey } from "../lib/library";
import { loadJson, saveJson } from "../lib/storage";
import { LibraryBrowserBar, type LibraryViewMode } from "./LibraryBrowserBar";
import { useListColumns } from "../hooks/use-list-columns";
import { NameHeader, ListColumnHeaders, ListColumnRules, type ColSpec } from "./ListColumnHeaders";
import { LibraryCardMenu } from "./LibraryCardMenu";
import { useGridSelection } from "../hooks/use-grid-selection";
import { useMarquee } from "../hooks/use-marquee";
import { IconReview } from "./Icons";
import { SavedReviewSession } from "./SavedReviewSession";
import { sessionSourceSummary } from "../lib/saved-session";

/**
 * The sessions this Mac has already held.
 *
 * The record existed all along - every co-review session writes one to
 * ~/Documents/Sauce Bunny/Screenings, with its participants, the sources
 * watched and the comment count - and the ONLY way to see one was a shelf at
 * the bottom of the co-review lobby, which is the last place you look for
 * something you did last week.
 *
 * So this is a reader over an existing store, not a new one. It deliberately
 * mounts the same pieces the web and frames shelves mount (the shared browser
 * bar, grid selection, the marquee, the selection bar) so the section behaves
 * like every other section rather than being a special page that happens to
 * live in the library.
 */

type SessionPrefs = { view: LibraryViewMode; sort: LibrarySortKey; dir: LibrarySortDir };
const PREFS_KEY = "saucebunny.sessionsBrowser";
const COLS_KEY = "saucebunny.sessionListCols";
const COL_DEFAULT = { people: 180, notes: 64, date: 120 };

/** The same shape the web and frames tables declare, so this reads as one more
 *  table rather than a bespoke page: sortable, resizable, reorderable,
 *  hideable, with the shared uppercase header type and column dividers. */
type SessColKey = "people" | "notes" | "date";
const SESS_COL_SPECS: readonly ColSpec<SessColKey>[] = [
  { key: "people", label: "People", className: "cp-lib-lrow-kind" },
  { key: "notes", label: "Notes", className: "cp-lib-lrow-size", sort: "size" },
  { key: "date", label: "Held", className: "cp-lib-lrow-date", sort: "date" },
];

function normalizePrefs(raw: unknown): SessionPrefs {
  const r = (typeof raw === "object" && raw !== null) ? raw as Record<string, unknown> : {};
  const oneOf = <T extends string>(v: unknown, opts: readonly T[], d: T): T =>
    opts.includes(v as T) ? (v as T) : d;
  return {
    view: oneOf(r.view, ["grid", "list"] as const, "list"),
    // A session is a thing that HAPPENED, so the useful order is when.
    sort: oneOf(r.sort, ["name", "date", "size"] as const, "date"),
    dir: oneOf(r.dir, ["asc", "desc"] as const, "desc"),
  };
}

type Row = ScreeningIndexEntry & { id: string };

function whenLabel(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    + " · " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function lengthLabel(a: number, b: number): string {
  // An unfinished session has endedAt 0; saying "0 min" would be a lie about
  // a session that may simply never have been closed cleanly.
  if (!a || !b || b <= a) return "";
  const mins = Math.round((b - a) / 60000);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, "0")}`;
}

export function ReviewSessionsPane({ treeOpen, onShowTree, onOpenLocalPath, onOpenWebUrl }: {
  treeOpen: boolean;
  onShowTree: () => void;
  /** The two openers every other library section already receives. This pane
   *  had NEITHER, which is why "Open in Clip" was wired to the reveal: the
   *  capability was never plumbed here, so the menu offered a verb the
   *  component could not perform. */
  onOpenLocalPath: (path: string) => void;
  onOpenWebUrl: (url: string) => void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [query, setQuery] = useState("");
  const [prefs, setPrefs] = useState<SessionPrefs>(() => normalizePrefs(loadJson(PREFS_KEY, {})));
  const paneRef = useRef<HTMLDivElement>(null);
  const colModel = useListColumns(COLS_KEY, COL_DEFAULT);
  const { visible, template } = colModel;
  const [menuAt, setMenuAt] = useState<{ x: number; y: number; id: string } | null>(null);
  const [openedId, setOpenedId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const returnTo = useRef<HTMLButtonElement | null>(null);

  // Persist OUTSIDE the updater, the way every other pane does: a setState
  // updater must stay pure, and updater-purity-contract enforces it.
  const patchPrefs = (p: Partial<SessionPrefs>) => {
    const next = { ...prefs, ...p };
    setPrefs(next);
    saveJson(PREFS_KEY, next);
  };
  const onSort = (key: LibrarySortKey) => {
    patchPrefs(prefs.sort === key
      ? { dir: prefs.dir === "asc" ? "desc" : "asc" }
      : { sort: key, dir: key === "name" ? "asc" : "desc" });
  };

  useEffect(() => {
    let alive = true;
    let generation = 0;
    const load = () => {
      const current = ++generation;
      void hydrateScreeningIndex()
        .then(async () => {
          if (!alive || current !== generation) return;
          const entries = listScreenings();
          setRows(entries);
          // Old index rows have no source kind. Read records with a bounded
          // pool, without rewriting the index or opening media/NDI inputs.
          const unknown = entries.filter(r => !r.sourceKinds);
          let next = 0;
          await Promise.all(Array.from({ length: Math.min(3, unknown.length) }, async () => {
            while (alive && current === generation && next < unknown.length) {
              const entry = unknown[next++];
              const doc = await loadScreening(entry.id);
              if (doc && alive && current === generation) {
                const summary = sessionSourceSummary(doc);
                setRows(previous => previous?.map(r => r.id === entry.id ? { ...r, ...summary } : r) ?? null);
              }
            }
          }));
        })
        .catch(() => { if (alive && current === generation) setRows([]); });
    };
    load();
    // A session ending while the library is open should appear without a
    // relaunch. The store already announces itself.
    window.addEventListener(SCREENINGS_CHANGED, load);
    return () => { alive = false; window.removeEventListener(SCREENINGS_CHANGED, load); };
  }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (rows ?? []).filter((r) => !q
      || r.title.toLowerCase().includes(q)
      || r.participants.some((p) => p.toLowerCase().includes(q)));
    const dir = prefs.dir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      if (prefs.sort === "name") return a.title.localeCompare(b.title) * dir;
      if (prefs.sort === "size") return (a.commentCount - b.commentCount) * dir;
      return (a.startedAt - b.startedAt) * dir;
    });
  }, [rows, query, prefs.sort, prefs.dir]);

  // Identity is the screening id, not a path: a session has a file, but the
  // file is an implementation detail of the store.
  const grid = useGridSelection(shown.map((r) => r.id));
  const marquee = useMarquee({
    containerRef: paneRef,
    // MUST follow the view mode. Pinned to one selector the lasso silently
    // selects nothing in the other view: the band draws and finds no items.
    itemSelector: prefs.view === "list" ? ".cp-lib-lrow" : ".cp-sess-card",
    gutterSelector: LASSO_GUTTER_SELECTOR,
    onSelect: grid.onMarquee,
    onEnd: grid.onMarqueeEnd,
  });

  const openOne = (id: string) => {
    setMenuAt(null);
    setOpenedId(id);
  };
  const copySessionName = async (id: string) => {
    const title = rows?.find(r => r.id === id)?.title;
    if (!title) return;
    try {
      await navigator.clipboard.writeText(title);
      setNotice("Session name copied.");
    } catch {
      setNotice("Could not copy the session name. Select and copy it from the session header.");
    }
  };
  const menuHandlers = (id: string) => ({
    onContextMenu: (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.currentTarget.focus();
      returnTo.current = e.currentTarget;
      if (!grid.selected.has(id)) grid.onItemClick(id, e);
      setMenuAt({ x: e.clientX, y: e.clientY, id });
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === " " || e.key === "Enter") e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); returnTo.current = e.currentTarget; openOne(id); }
      if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
        e.preventDefault();
        returnTo.current = e.currentTarget;
        const b = e.currentTarget.getBoundingClientRect();
        setMenuAt({ x: b.left + 18, y: b.bottom - 6, id });
      }
    },
    onDoubleClick: (e: React.MouseEvent<HTMLButtonElement>) => { returnTo.current = e.currentTarget; openOne(id); },
  });
  const sourceBadge = (r: Row) => r.sourceKinds?.includes("ndi")
    ? <span className="cp-session-source-badge" title={r.premiere ? "Premiere Pro live session" : "NDI live session"}>{r.premiere ? "Pr" : "NDI"}</span> : null;
  const back = () => {
    setOpenedId(null);
    requestAnimationFrame(() => returnTo.current?.focus());
  };

  return (
    <div className="cp-web-view cp-sessions-view">
      {openedId && <SavedReviewSession key={openedId} id={openedId} onBack={back}
        onOpenMedia={path => /^https?:\/\//i.test(path) ? onOpenWebUrl(path) : onOpenLocalPath(path)} />}
      <div className="cp-session-browser" hidden={openedId !== null}>
      <LibraryBrowserBar
        chain={null}
        onCrumb={() => { /* location is fixed; the crumb slot shows it */ }}
        location="Review sessions"
        dateLabel="Date held"
        searchLabel="Search sessions and people"
        sizeLabel="Notes"
        query={query}
        onQuery={setQuery}
        sort={prefs.sort}
        dir={prefs.dir}
        view={prefs.view}
        onPrefs={patchPrefs}
        treeOpen={treeOpen}
        onShowTree={onShowTree}
      />
      {notice && <p className="cp-session-copy-notice" role="status">{notice}</p>}
      <div
        ref={paneRef}
        className="cp-web-pane"
        onClick={(e) => { if (!marquee.dragging() && e.target === e.currentTarget) grid.clear(); }}
        {...marquee.handlers}
      >
        {marquee.band && <div className="cp-lib-marquee" style={marquee.band} />}

        {rows === null ? null : shown.length === 0 ? (
          <div className="cp-pane-empty">
            <IconReview size={28} />
            <div className="cp-pane-empty-title">
              {query ? "No sessions match" : "No review sessions yet"}
            </div>
            <div className="cp-pane-empty-body">
              {query
                ? "Try a different name."
                : "Every co-review session you hold is recorded here: who was there, what you watched and the notes taken."}
            </div>
          </div>
        ) : (
          <>
            <div className="cp-web-summary">
              {shown.length} session{shown.length === 1 ? "" : "s"}
            </div>
            {prefs.view === "list" ? (
              <div
                className="cp-lib-list"
                style={{ ["--lrow-cols" as string]: template, ["--lrow-fill-phase" as string]: String(listFillPhase(shown.length)) }}
              >
                <div className="cp-lib-list-head" onContextMenu={(e) => e.preventDefault()}>
                  <span className="cp-lib-lrow-art" aria-hidden="true" />
                  <NameHeader sort={prefs.sort} dir={prefs.dir} onSort={onSort} model={colModel} />
                  <ListColumnHeaders specs={SESS_COL_SPECS} model={colModel} sort={prefs.sort} dir={prefs.dir} onSort={onSort} />
                </div>
                {shown.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    data-path={r.id}
                    className={"cp-lib-lrow" + (grid.selected.has(r.id) ? " selected" : "")}
                    onClick={(e) => grid.onItemClick(r.id, e)}
                    {...menuHandlers(r.id)}
                    title={r.title}
                  >
                    <span className="cp-lib-lrow-art">{sourceBadge(r) ?? <IconReview size={13} />}</span>
                    <span className="cp-lib-lrow-name">{r.title}</span>
                    {visible.map((k) => (
                      k === "people"
                        ? <span key={k} className="cp-lib-lrow-kind">{r.participants.join(", ")}</span>
                        : k === "notes"
                          ? <span key={k} className="cp-lib-lrow-size">{r.commentCount || ""}</span>
                          : <span key={k} className="cp-lib-lrow-date">{whenLabel(r.startedAt)}</span>
                    ))}
                  </button>
                ))}
                <ListColumnRules template={template} trackCount={colModel.trackCount} lastColumnTrack={colModel.lastColumnTrack} />
              </div>
            ) : (
              <div className="cp-web-grid" role="list">
                {shown.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    role="listitem"
                    data-path={r.id}
                    className={"cp-sess-card" + (grid.selected.has(r.id) ? " selected" : "")}
                    onClick={(e) => grid.onItemClick(r.id, e)}
                    {...menuHandlers(r.id)}
                  >
                    <span className="cp-sess-card-title">{sourceBadge(r)} {r.title}</span>
                    <span className="cp-sess-card-meta">{whenLabel(r.startedAt)}</span>
                    <span className="cp-sess-card-meta">
                      {r.participants.join(", ") || "Just you"}
                    </span>
                    <span className="cp-sess-card-foot">
                      {r.commentCount} note{r.commentCount === 1 ? "" : "s"}
                      {lengthLabel(r.startedAt, r.endedAt) && ` · ${lengthLabel(r.startedAt, r.endedAt)}`}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        {menuAt && (
          <LibraryCardMenu
            anchor={{ x: menuAt.x, y: menuAt.y }}
            revealPath={null}
            sessionActions={{ onOpen: () => openOne(menuAt.id), onCopyName: () => { void copySessionName(menuAt.id); } }}
            // A screening is a RECORD of something that happened. There is no
            // sensible "delete" here yet, and inventing one that throws away
            // the only account of a session would be worse than not offering
            // it - so the menu carries the verbs that exist and no more.
            canPickThumbnail={false}
            hasChosenThumbnail={false}
            onChooseThumbnail={() => {}}
            onResetThumbnail={() => {}}
            onClose={() => { setMenuAt(null); returnTo.current?.focus(); }}
          />
        )}
      </div>
      </div>
    </div>
  );
}
