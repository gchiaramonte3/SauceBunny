import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  filterCachedWeb, groupBySite, siteName, sortCachedWeb, type CachedWebItem,
} from "../lib/web-source";
import { formatBytes } from "../lib/library";
import type { LibrarySortDir, LibrarySortKey } from "../lib/library";
import { secondsToClock } from "../lib/timecode";
import { LibraryBrowserBar, type LibraryViewMode } from "./LibraryBrowserBar";
import { LibraryCard } from "./LibraryCard";
import { LibrarySelectionBar } from "./LibrarySelectionBar";
import { useGridSelection } from "../hooks/use-grid-selection";
import { useMarquee } from "../hooks/use-marquee";
import { WebListRows } from "./WebListRows";
import { WebCollectionMenu } from "./WebCollectionMenu";
import {
  deleteWebCollection, flushWebCollections, getWebCollections, hydrateWebCollections,
  subscribeWebCollections, type WebCollection,
} from "../lib/web-collection-store";

/** View prefs for the web pane, persisted separately from the folder pane's:
 *  the two views are different rooms, and flipping the web cache to a list
 *  must not flip every folder too. Same normalize pattern as
 *  LibraryBrowser's, minus the kind filter (CachedWebItem has no kind field;
 *  the tree's chips are a folder concept until it grows one). Defaults keep
 *  today's implicit order - newest fetch first - so this change reshuffles
 *  nobody's shelf. */
type WebPrefs = { view: LibraryViewMode; sort: LibrarySortKey; dir: LibrarySortDir };
const WEB_PREFS_KEY = "saucebunny.webBrowser";
function normalizeWebPrefs(raw: unknown): WebPrefs {
  const r = (typeof raw === "object" && raw !== null) ? raw as Record<string, unknown> : {};
  const oneOf = <T extends string>(v: unknown, opts: readonly T[], d: T): T =>
    opts.includes(v as T) ? (v as T) : d;
  return {
    view: oneOf(r.view, ["grid", "list"] as const, "grid"),
    sort: oneOf(r.sort, ["name", "date", "size"] as const, "date"),
    dir: oneOf(r.dir, ["asc", "desc"] as const, "desc"),
  };
}

/**
 * Everything this Mac has pulled off the web, shelved by where it came from.
 *
 * WHY THIS IS NOT THE FILE GRID. A cached web source is not a file with a
 * poster: it is a URL, a remote thumbnail, and — only sometimes — a downloaded
 * copy. Pushing it through the folder pane's item pipeline would mean
 * inventing a path for something that may not have one, and the first thing to
 * break would be every verb that assumes a path (rename, tag, reveal).
 *
 * METADATA-ONLY ENTRIES ARE THE MAJORITY, and they are the point. The app
 * streams most web sources and keeps only the resolve, so a shelf that listed
 * only fully-downloaded clips would show two rows out of forty and look
 * broken. Re-opening a metadata-only entry still skips yt-dlp's extraction,
 * which is the ten to fifteen seconds anyone actually notices.
 */
export function CachedWebPane({ onOpenUrl, treeOpen, onShowTree }: {
  onOpenUrl: (url: string) => void;
  treeOpen: boolean;
  onShowTree: () => void;
}) {
  const [items, setItems] = useState<CachedWebItem[] | null>(null);

  const [prefs, setPrefs] = useState<WebPrefs>(() => {
    try { return normalizeWebPrefs(JSON.parse(localStorage.getItem(WEB_PREFS_KEY) ?? "null")); }
    catch { return normalizeWebPrefs(null); }
  });
  const prefsRef = useRef(prefs);
  // Persistence stays OUTSIDE the updaters (updater-purity contract): the
  // events these run from never batch two prefs writes, so reading the
  // current state directly is race-free, and the localStorage write happens
  // as an ordinary effect of the handler rather than inside React's replay.
  const persistPrefs = (next: WebPrefs) => {
    try { localStorage.setItem(WEB_PREFS_KEY, JSON.stringify(next)); } catch { /* quota */ }
  };
  const patchPrefs = useCallback((patch: Partial<WebPrefs>) => {
    const next = { ...prefsRef.current, ...patch };
    prefsRef.current = next;
    persistPrefs(next);
    setPrefs(next);
  }, []);
  // Header click: same column flips direction, a new column starts fresh -
  // the folder pane's rule, via the same persisted prefs the bar edits.
  const onSort = useCallback((key: LibrarySortKey) => {
    const prev = prefsRef.current;
    const next: WebPrefs = prev.sort === key
      ? { ...prev, dir: prev.dir === "asc" ? "desc" : "asc" }
      : { ...prev, sort: key, dir: key === "name" ? "asc" : "desc" };
    prefsRef.current = next;
    persistPrefs(next);
    setPrefs(next);
  }, []);

  // Scoped search - debounced 150ms, instant clear (the folder pane's cadence).
  const [query, setQuery] = useState("");
  const [needle, setNeedle] = useState("");
  useEffect(() => {
    if (query === "") { setNeedle(""); return; }
    const id = window.setTimeout(() => setNeedle(query), 150);
    return () => window.clearTimeout(id);
  }, [query]);

  const load = useCallback(() => {
    void invoke<CachedWebItem[]>("list_cached_web")
      .then(setItems)
      // A cache that cannot be read is an EMPTY shelf, not an error banner:
      // nothing the user did is wrong and nothing of theirs is lost.
      .catch(() => setItems([]));
  }, []);
  useEffect(load, [load]);
  // Collections hydrate once (idempotent, latched); the store notifies this
  // subscription for every membership change.
  useEffect(() => { void hydrateWebCollections(); }, []);
  // Unmount = leaving the web view; push the debounced write out so the last
  // 400ms of curation is not lost to a quick tab switch (CastShelf's rule).
  useEffect(() => () => { void flushWebCollections(); }, []);
  const collections = useSyncExternalStore(subscribeWebCollections, getWebCollections);
  const [armedCollection, setArmedCollection] = useState<string | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);

  const forget = useCallback((url: string) => {
    // Optimistic: the row goes now, because the disk work is a file delete and
    // waiting on it makes a instant action feel broken.
    setItems((prev) => prev?.filter((i) => i.url !== url) ?? prev);
    void invoke("forget_cached_web", { url }).catch(load);
  }, [load]);

  // Derivations run BEFORE the early returns: the selection hook below needs
  // the displayed order, and a hook cannot be called after a conditional
  // return. `all` stands in for a cache that has not been read yet.
  const all = items ?? [];

  // Search flattens the shelves into one result list - a needle that matches
  // four sites as four one-row shelves reads as clutter, and the folder
  // pane's search flattens its subfolders the same way. Without a needle the
  // GRID keeps its site shelves, sorted within themselves; the LIST is one
  // flat table regardless, because Site is a column there and per-shelf
  // tables would repeat the header four times down the page.
  const filtered = filterCachedWeb(all, needle);
  const sortedFlat = sortCachedWeb(filtered, prefs.sort, prefs.dir);
  // A collected item leaves its site shelf - it has been FILED, and showing
  // it twice would make the fold read as a search result rather than an
  // organisation. A collection may hold URLs the cache has since forgotten;
  // those simply have nothing to render until the source is fetched again.
  // Search and the list view ignore the fold entirely and stay flat.
  const byUrl = new Map(all.map((i) => [i.url, i]));
  const collected = new Set(collections.flatMap((c) => c.urls));
  const collectionGroups: { collection: WebCollection; items: CachedWebItem[] }[] =
    prefs.view === "grid" && !needle
      ? collections.map((c) => ({
          collection: c,
          items: sortCachedWeb(
            c.urls.map((u) => byUrl.get(u)).filter((i): i is CachedWebItem => !!i),
            prefs.sort, prefs.dir,
          ),
        }))
      : [];
  const unfiled = prefs.view === "grid" && !needle
    ? all.filter((i) => !collected.has(i.url))
    : all;
  const groups = prefs.view === "list"
    ? (sortedFlat.length ? [{ site: "", items: sortedFlat }] : [])
    : needle
      ? (filtered.length ? [{ site: "Results", items: sortedFlat }] : [])
      : groupBySite(unfiled).map((g) => ({ site: g.site, items: sortCachedWeb(g.items, prefs.sort, prefs.dir) }));
  /**
   * One cached web source, rendered by the LIBRARY's card - the same poster
   * frame, hover reveal, ⋯ menu, selection affordance and broken-art
   * fallback a local file gets. The bespoke cp-web-card this replaced had
   * none of that: a dead i.ytimg.com URL left a broken image with no
   * fallback, right-click gave the WKWebView default, and every card plus
   * its forget button was a separate tab stop.
   *
   * The two facts a web item has and a file does not ride as card props
   * (duration on the art, the downloaded-copy indicator); the forget and
   * add-to-collection controls ride in the cell slot, where they can be
   * positioned against the card and revealed with it.
   */
  /**
   * One cached web source on the LIBRARY's card, with its verbs in the
   * card's own ⋯ menu rather than as buttons floating over the art. The
   * bespoke controls this replaces put a forget button and a collection
   * button beside the ⋯ that already exists to hold exactly those - three
   * affordances fighting for one corner, in two idioms.
   *
   * Collections keep their own control because the menu has no submenu and
   * "file this under one of N" is not a verb, it is a picker; it sits in
   * the cell as a single quiet affordance rather than two.
   */
  const webCard = (it: CachedWebItem) => {
    const size = it.size_bytes ? formatBytes(it.size_bytes) : null;
    return (
      <LibraryCard
        // A web source's identity is its URL. The card used to derive one
        // from LOCAL art only, and these cards carry a remote thumbnail, so
        // every one of them was invisible to selection and to the band.
        selectionPath={it.url}
        selected={grid.selected.has(it.url)}
        onSelect={(e) => grid.onItemClick(it.url, e)}
        key={it.url}
        title={it.title ?? it.url}
        detail={`${it.uploader ?? siteName(it.url)}${size ? ` · ${size}` : ""}`}
        art={{ kind: "remote", url: it.thumbnail }}
        badge="web"
        duration={it.duration_seconds != null ? secondsToClock(it.duration_seconds) : null}
        haveCopy={!!it.path}
        revealPath={it.path}
        onOpen={() => onOpenUrl(it.url)}
        requestThumb={async () => null}
        // The verb differs by what there is to lose, and so does the ask: a
        // downloaded copy is minutes of fetching and names its size, while a
        // resolve-only entry costs ten seconds of extraction and goes
        // without ceremony. That distinction was worth keeping when the
        // control moved into the menu.
        deleteLabel={it.path ? "Delete the copy…" : "Forget this source"}
        onDelete={() => {
          if (it.path && !confirm(
            `Delete the ${size ?? ""} copy of ${it.title ?? it.url} from this Mac? `
            + "The source stays online.",
          )) return;
          forget(it.url);
        }}
        cellControls={<WebCollectionMenu url={it.url} />}
      />
    );
  };

  const withCopy = all.filter((i) => i.path).length;
  const bytes = all.reduce((n, i) => n + (i.size_bytes ?? 0), 0);

  // Display order for ranges and the band: collections first, then the site
  // shelves, exactly as they are painted.
  const shown = [
    ...collectionGroups.flatMap((g) => g.items),
    ...groups.flatMap((g) => g.items),
  ];
  const grid = useGridSelection(shown.map((i) => i.url));
  const { selectedPaths: selectedUrls } = grid;
  const marquee = useMarquee({
    containerRef: paneRef,
    itemSelector: ".cp-lib-card",
    gutterSelector: ".cp-web-grid, .cp-web-shelf, .cp-web-summary",
    onSelect: grid.onMarquee,
    onEnd: grid.onMarqueeEnd,
  });
  const band = marquee.band && (
    <div
      className="cp-lib-marquee"
      aria-hidden="true"
      style={{
        left: marquee.band.left,
        top: marquee.band.top,
        width: marquee.band.right - marquee.band.left,
        height: marquee.band.bottom - marquee.band.top,
      }}
    />
  );

  if (items === null) return <div className="cp-web-empty">Reading the cache…</div>;
  if (items.length === 0) {
    return (
      <div className="cp-web-empty">
        Nothing cached from the web yet. Fetch a URL and it will appear here,
        ready to re-open without waiting for extraction again.
      </div>
    );
  }

  const forgetMany = (urls: readonly string[]) => {
    const n = urls.length;
    if (!confirm(n === 1
      ? "Forget this clip? Its cached copy is removed from this Mac."
      : `Forget ${n} clips? Their cached copies are removed from this Mac.`)) return;
    for (const u of urls) forget(u);
    grid.clear();
  };

  return (
    <div className="cp-web-view">
      <LibraryBrowserBar
        chain={null}
        onCrumb={() => { /* location is fixed; the crumb slot shows it */ }}
        location="From the web"
        dateLabel="Date fetched"
        searchLabel="Search cached clips"
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
        count={selectedUrls.length}
        onDelete={() => forgetMany(selectedUrls)}
        deleteLabel="Forget the selected clips"
        onClear={grid.clear}
      />
      <div
        ref={paneRef}
        className="cp-web-pane"
        onClick={(e) => { if (!marquee.dragging() && e.target === e.currentTarget) grid.clear(); }}
        {...marquee.handlers}
      >
      {band}
      <div className="cp-web-summary">
        {all.length} cached · {withCopy} downloaded
        {bytes > 0 ? ` · ${formatBytes(bytes)} on disk` : ""}
      </div>
      {needle && groups.length === 0 && (
        <div className="cp-web-empty">Nothing cached matches "{needle.trim()}".</div>
      )}
      {collectionGroups.map(({ collection: c, items: cItems }) => {
        const missing = c.urls.length - cItems.length;
        const colArmed = armedCollection === c.id;
        return (
          <section key={"col-" + c.id} className="cp-web-shelf collection">
            <h3 className="cp-web-shelf-head">
              {c.name}
              <span className="cp-web-count">{cItems.length}</span>
              <button
                type="button"
                className={"cp-web-col-delete" + (colArmed ? " armed" : "")}
                title="Delete this collection. The clips and their files stay."
                aria-label={colArmed
                  ? `Confirm deleting the collection ${c.name}`
                  : `Delete the collection ${c.name}`}
                onClick={() => {
                  if (colArmed) { setArmedCollection(null); deleteWebCollection(c.id); }
                  else setArmedCollection(c.id);
                }}
              >
                {colArmed ? "Delete collection" : "×"}
              </button>
            </h3>
            {cItems.length === 0 && (
              <div className="cp-web-shelf-note">
                {missing > 0
                  ? `${missing} ${missing === 1 ? "clip is" : "clips are"} no longer in the cache. Fetch ${missing === 1 ? "it" : "one"} again and it will reappear here.`
                  : "Empty. Use the + on any card to file clips here."}
              </div>
            )}
            <div className="cp-web-grid" role="list">{cItems.map(webCard)}</div>
          </section>
        );
      })}
      {groups.map((g) => (
        <section key={g.site || "list"} className="cp-web-shelf">
          {g.site !== "" && (
            <h3 className="cp-web-shelf-head">
              {g.site}
              <span className="cp-web-count">{g.items.length}</span>
            </h3>
          )}
          {prefs.view === "list" ? (
            <WebListRows
              items={g.items}
              sort={prefs.sort}
              dir={prefs.dir}
              onSort={onSort}
              onOpenUrl={onOpenUrl}
              onForget={(url) => {
                const row = g.items.find((x) => x.url === url);
                const sz = row?.size_bytes ? formatBytes(row.size_bytes) : "";
                if (row?.path && !confirm(
                  `Delete the ${sz} copy of ${row.title ?? url} from this Mac? The source stays online.`,
                )) return;
                forget(url);
              }}
            />
          ) : (
          <div className="cp-web-grid" role="list">
            {g.items.map(webCard)}
          </div>
          )}
        </section>
      ))}
      </div>
    </div>
  );
}
