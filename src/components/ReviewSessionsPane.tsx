import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  hydrateScreeningIndex, listScreenings, screeningPath, SCREENINGS_CHANGED,
  type ScreeningIndexEntry,
} from "../lib/screening-store";
import type { LibrarySortDir, LibrarySortKey } from "../lib/library";
import { loadJson, saveJson } from "../lib/storage";
import { LibraryBrowserBar, type LibraryViewMode } from "./LibraryBrowserBar";
import { LibrarySelectionBar } from "./LibrarySelectionBar";
import { useGridSelection } from "../hooks/use-grid-selection";
import { useMarquee } from "../hooks/use-marquee";
import { IconReview } from "./Icons";

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

export function ReviewSessionsPane({ treeOpen, onShowTree }: {
  treeOpen: boolean;
  onShowTree: () => void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [query, setQuery] = useState("");
  const [prefs, setPrefs] = useState<SessionPrefs>(() => normalizePrefs(loadJson(PREFS_KEY, {})));
  const paneRef = useRef<HTMLDivElement>(null);

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
    const load = () => {
      void hydrateScreeningIndex()
        .then(() => { if (alive) setRows(listScreenings()); })
        .catch(() => { if (alive) setRows([]); });
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
    itemSelector: prefs.view === "list" ? ".cp-sess-row" : ".cp-sess-card",
    onSelect: grid.onMarquee,
    onEnd: grid.onMarqueeEnd,
  });

  const revealOne = (id: string) => {
    const p = screeningPath(id);
    if (p) void invoke("reveal_in_finder", { path: p }).catch(() => { /* gone */ });
  };

  return (
    <div className="cp-web-view">
      <LibraryBrowserBar
        chain={null}
        onCrumb={() => { /* location is fixed; the crumb slot shows it */ }}
        location="Review sessions"
        dateLabel="Date held"
        searchLabel="Search sessions and people"
        query={query}
        onQuery={setQuery}
        sort={prefs.sort}
        dir={prefs.dir}
        view={prefs.view}
        onPrefs={patchPrefs}
        treeOpen={treeOpen}
        onShowTree={onShowTree}
      />
      <LibrarySelectionBar
        count={grid.selectedPaths.length}
        onReveal={() => { const f = grid.selectedPaths[0]; if (f) revealOne(f); }}
        onClear={grid.clear}
      />
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
              <div className="cp-lib-list cp-sess-list">
                <div className="cp-lib-list-head cp-sess-row">
                  <button type="button" onClick={() => onSort("name")}>Session</button>
                  <span>People</span>
                  <button type="button" onClick={() => onSort("size")}>Notes</button>
                  <button type="button" onClick={() => onSort("date")}>Held</button>
                </div>
                {shown.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    data-path={r.id}
                    className={"cp-lib-lrow cp-sess-row" + (grid.selected.has(r.id) ? " selected" : "")}
                    onClick={(e) => grid.onItemClick(r.id, e)}
                    onDoubleClick={() => revealOne(r.id)}
                    title={r.title}
                  >
                    <span className="cp-sess-name">{r.title}</span>
                    <span className="cp-lib-lrow-kind">{r.participants.join(", ")}</span>
                    <span className="cp-lib-lrow-size">{r.commentCount || ""}</span>
                    <span className="cp-lib-lrow-date">{whenLabel(r.startedAt)}</span>
                  </button>
                ))}
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
                    onDoubleClick={() => revealOne(r.id)}
                  >
                    <span className="cp-sess-card-title">{r.title}</span>
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
      </div>
    </div>
  );
}
