import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toggleTagColor, clearTagColors, type TagColorIndex } from "../lib/finder-tags";
import type { FinderTag } from "../bindings/FinderTag";
import type { TaggedPath } from "../bindings/TaggedPath";

/**
 * Finder tags for whatever is currently listed.
 *
 * READ IN BULK, per visible page. Tags are an xattr read per file; doing that
 * one invoke at a time would be a hop per row on every folder change. Reading
 * the listed paths in one call keeps it to one.
 *
 * WRITTEN OPTIMISTICALLY, because setting a colour should feel like Finder's
 * does — instant. The write is fire-and-forget against the file, and a failure
 * rolls the dot back rather than leaving the UI claiming a colour the disk
 * does not have.
 */
export function useFinderTags(paths: readonly string[]) {
  const [tags, setTags] = useState<Map<string, FinderTag[]>>(new Map());
  const keyRef = useRef("");
  /** Bumped to force a re-read after a write made OUTSIDE this hook (the
   *  folder menu owns its own xattr write). */
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    // Re-read only when the SET of paths changes, not on every render — the
    // array identity churns with each scan.
    // NUL-joined: paths can contain spaces, so a space join could make two
    // different sets collide. The tick folds in so an external write re-reads
    // even an unchanged set.
    const key = paths.join("\u0000") + "#" + refreshTick;
    if (key === keyRef.current) return;
    keyRef.current = key;
    if (paths.length === 0) { setTags(new Map()); return; }
    let stale = false;
    void invoke<TaggedPath[]>("read_finder_tags", { paths: [...paths] })
      .then((rows) => {
        if (stale) return;
        setTags(new Map(rows.map((r) => [r.path, r.tags])));
      })
      .catch(() => { /* a filesystem without xattrs simply has no tags */ });
    return () => { stale = true; };
  }, [paths, refreshTick]);

  const write = useCallback(async (path: string, next: FinderTag[]) => {
    const prev = tags.get(path) ?? [];
    setTags((m) => new Map(m).set(path, next));
    try {
      await invoke("set_finder_tags", { path, tags: next });
    } catch {
      // Roll back rather than show a colour the file does not carry.
      setTags((m) => new Map(m).set(path, prev));
    }
  }, [tags]);

  const toggle = useCallback((path: string, index: TagColorIndex) => {
    void write(path, toggleTagColor(tags.get(path) ?? [], index));
  }, [tags, write]);

  const clear = useCallback((path: string) => {
    void write(path, clearTagColors(tags.get(path) ?? []));
  }, [tags, write]);

  /** Apply one colour to MANY files — the selection-bar verb. */
  const toggleMany = useCallback((targets: readonly string[], index: TagColorIndex) => {
    // Decided once from the whole set, so a mixed selection resolves to one
    // outcome instead of each file flipping to its own opposite.
    const allHave = targets.every((p) => (tags.get(p) ?? []).some((t) => t.color === index));
    for (const p of targets) {
      const cur = tags.get(p) ?? [];
      const has = cur.some((t) => t.color === index);
      if (allHave === has) void write(p, toggleTagColor(cur, index));
    }
  }, [tags, write]);

  /** Force a re-read — for writes made outside this hook's own setters. */
  const refresh = useCallback(() => setRefreshTick((n) => n + 1), []);

  /**
   * Re-read when the window comes back, because Finder owns these colours and
   * changes them while we are in the background.
   *
   * IN THE HOOK, not at the call site. LibraryTree had this effect and
   * LibraryBrowser did not, so tagging a folder in Finder updated the sidebar
   * and left the grid beside it showing the old colour — the same set of tags,
   * one pane fresh and one stale, which reads as the app failing to see a tag
   * at all. Every consumer gets it here by construction, and the third one
   * cannot forget it. Same argument that put outside-click and Escape together
   * in useDismiss after two siblings each implemented half.
   */
  useEffect(() => {
    const onFocus = () => setRefreshTick((n) => n + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  return { tags, toggle, clear, toggleMany, refresh };
}
