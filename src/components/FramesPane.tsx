import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  filterFrames, formatFrameTimecode, groupBySource, sortFrames, type FrameItem,
} from "../lib/frames";
import { formatBytes } from "../lib/library";
import type { LibrarySortDir, LibrarySortKey } from "../lib/library";
import { assetUrl } from "../lib/asset-url";
import { LibraryBrowserBar, type LibraryViewMode } from "./LibraryBrowserBar";
import { LibraryCard } from "./LibraryCard";
import { FrameListRows } from "./FrameListRows";

/**
 * Frames — every still grabbed during a review, bundled by the film it came
 * from.
 *
 * Snapshots used to go through a save dialog, so they scattered across the
 * Desktop, Downloads and the export folder, and the app could not show
 * them afterwards because it had no idea where they went. They land in one
 * managed folder now, and this shelf is the other half of that: the same
 * browser bar, the same grid and list views, and the same shared
 * LibraryCard the folder pane and the web shelf use.
 *
 * Bundled BY SOURCE, which is the web shelf's grouping-by-site in the shape
 * frames want. Both derive their groups from data that already exists (a
 * host, a filename stem) rather than from an index that could fall out of
 * step with the directory.
 */

type FramePrefs = { view: LibraryViewMode; sort: LibrarySortKey; dir: LibrarySortDir };
const PREFS_KEY = "saucebunny.framesBrowser";
function normalizeFramePrefs(raw: unknown): FramePrefs {
  const r = (typeof raw === "object" && raw !== null) ? raw as Record<string, unknown> : {};
  const oneOf = <T extends string>(v: unknown, opts: readonly T[], d: T): T =>
    opts.includes(v as T) ? (v as T) : d;
  return {
    view: oneOf(r.view, ["grid", "list"] as const, "grid"),
    sort: oneOf(r.sort, ["name", "date", "size"] as const, "date"),
    dir: oneOf(r.dir, ["asc", "desc"] as const, "desc"),
  };
}

export function FramesPane({ treeOpen, onShowTree, onOpenFrame }: {
  treeOpen: boolean;
  onShowTree: () => void;
  /** Open a frame in whatever the app uses to look at a still. */
  onOpenFrame?: (path: string) => void;
}) {
  const [items, setItems] = useState<FrameItem[] | null>(null);

  const load = useCallback(() => {
    void invoke<FrameItem[]>("list_frames")
      .then(setItems)
      // A folder that cannot be read is an EMPTY shelf, not an error banner:
      // not having grabbed a frame yet is the normal first-run state.
      .catch(() => setItems([]));
  }, []);
  useEffect(load, [load]);
  // A frame grabbed while this shelf is open should appear on it. The
  // grabber lives in the Clip workspace, so a window-focus re-read is the
  // cheap way to catch both that and anything done in Finder.
  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const [prefs, setPrefs] = useState<FramePrefs>(() => {
    try { return normalizeFramePrefs(JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null")); }
    catch { return normalizeFramePrefs(null); }
  });
  const prefsRef = useRef(prefs);
  const persist = (next: FramePrefs) => {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* quota */ }
  };
  const patchPrefs = useCallback((patch: Partial<FramePrefs>) => {
    const next = { ...prefsRef.current, ...patch };
    prefsRef.current = next;
    persist(next);
    setPrefs(next);
  }, []);
  const onSort = useCallback((key: LibrarySortKey) => {
    const prev = prefsRef.current;
    const next: FramePrefs = prev.sort === key
      ? { ...prev, dir: prev.dir === "asc" ? "desc" : "asc" }
      : { ...prev, sort: key, dir: key === "name" ? "asc" : "desc" };
    prefsRef.current = next;
    persist(next);
    setPrefs(next);
  }, []);

  const [query, setQuery] = useState("");
  const [needle, setNeedle] = useState("");
  useEffect(() => {
    if (query === "") { setNeedle(""); return; }
    const id = window.setTimeout(() => setNeedle(query), 150);
    return () => window.clearTimeout(id);
  }, [query]);

  const remove = useCallback((path: string) => {
    // Optimistic: the card goes now, because the disk work is one unlink and
    // waiting on it makes an instant action feel broken.
    setItems((prev) => prev?.filter((i) => i.path !== path) ?? prev);
    void invoke("delete_frame", { path }).catch(load);
  }, [load]);

  if (items === null) return <div className="cp-web-empty">Reading your frames…</div>;
  if (items.length === 0) {
    return (
      <div className="cp-web-empty">
        No frames yet. Press the camera in the player to grab the frame you are
        looking at, and it will land here.
      </div>
    );
  }

  const filtered = filterFrames(items, needle);
  const sortedFlat = sortFrames(filtered, prefs.sort, prefs.dir);
  const groups = prefs.view === "list"
    ? (sortedFlat.length ? [{ source: "", items: sortedFlat }] : [])
    : needle
      ? (filtered.length ? [{ source: "Results", items: sortedFlat }] : [])
      : groupBySource(items).map((g) => ({
          source: g.source,
          items: sortFrames(g.items, prefs.sort, prefs.dir),
        }));
  const bytes = items.reduce((n, i) => n + i.size_bytes, 0);

  const frameCard = (it: FrameItem) => {
    const tc = formatFrameTimecode(it.timecode);
    return (
      <LibraryCard
        key={it.path}
        title={it.name}
        detail={`${it.source}${it.size_bytes ? ` · ${formatBytes(it.size_bytes)}` : ""}`}
        // A still IS its own poster - point the card's remote art at the file
        // through the asset protocol rather than asking the thumbnailer to
        // decode a video frame out of a JPEG.
        art={{ kind: "remote", url: assetUrl(it.path) }}
        duration={tc}
        revealPath={it.path}
        onOpen={() => onOpenFrame?.(it.path)}
        requestThumb={async () => null}
        // Delete lives in the card's ⋯ menu, beside Reveal in Finder and
        // Open in Clip, because that is where a card's verbs live. It asks
        // first: one file, and every other destructive action in this app
        // asks. No armed second click - that pattern belongs to a control
        // you can press twice, and a menu closes on the first.
        deleteLabel="Delete frame…"
        onDelete={() => {
          if (!confirm(`Delete ${it.name}? It is removed from this Mac.`)) return;
          remove(it.path);
        }}
      />
    );
  };

  return (
    <div className="cp-web-view">
      <LibraryBrowserBar
        chain={null}
        onCrumb={() => { /* location is fixed */ }}
        location="Frames"
        dateLabel="Date grabbed"
        searchLabel="Search frames"
        query={query}
        onQuery={setQuery}
        sort={prefs.sort}
        dir={prefs.dir}
        view={prefs.view}
        onPrefs={patchPrefs}
        treeOpen={treeOpen}
        onShowTree={onShowTree}
      />
      <div className="cp-web-pane">
        <div className="cp-web-summary">
          {items.length} {items.length === 1 ? "frame" : "frames"}
          {bytes > 0 ? ` · ${formatBytes(bytes)} on disk` : ""}
        </div>
        {needle && groups.length === 0 && (
          <div className="cp-web-empty">No frames match "{needle.trim()}".</div>
        )}
        {groups.map((g) => (
          <section key={g.source || "list"} className="cp-web-shelf">
            {g.source !== "" && (
              <h3 className="cp-web-shelf-head">
                {g.source}
                <span className="cp-web-count">{g.items.length}</span>
              </h3>
            )}
            {prefs.view === "list" ? (
              <FrameListRows
                items={g.items}
                sort={prefs.sort}
                dir={prefs.dir}
                onSort={onSort}
                onOpenFrame={(p) => onOpenFrame?.(p)}
                onDelete={(p) => {
                  const row = g.items.find((x) => x.path === p);
                  if (!row) return;
                  if (!confirm(`Delete ${row.name}? It is removed from this Mac.`)) return;
                  remove(p);
                }}
              />
            ) : (
              <div className="cp-web-grid" role="list">{g.items.map(frameCard)}</div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
