import { useEffect, useRef, useState } from "react";
import { useMenuKeys } from "../hooks/use-menu-keys";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { TagColorRow } from "./TagColorRow";
import { clearTagColors, toggleTagColor, type TagColorIndex } from "../lib/finder-tags";
import { IconCircleX, IconReveal } from "./Icons";
import type { FinderTag } from "../bindings/FinderTag";
import type { TaggedPath } from "../bindings/TaggedPath";

/**
 * Right-click menu for a FOLDER: the tag colour row and Reveal in Finder.
 *
 * SELF-CONTAINED ON PURPOSE. Folders appear in three places (the tree, the
 * Home shelves, the browser's folder cards), none of which share the file
 * pane's tag plumbing. Threading tags through all three ancestries for a menu
 * that needs exactly one path is how a prop chain grows five links; this menu
 * owns its own read and write instead, and the caller notifies whoever needs
 * to recolour via the callback.
 *
 * This closes the actual ask behind the tag work: "add colors to FOLDERS."
 * The first pass wired colours onto file menus only, which coloured everything
 * except the thing that was asked for.
 */
export function FolderTagMenu({
  path, anchor, onClose, onChanged, onRemove,
}: {
  path: string;
  anchor: { x: number; y: number };
  onClose: () => void;
  /** Tags changed on disk — callers refresh whatever shows the colour. */
  onChanged?: (tags: FinderTag[]) => void;
  /** Drop this folder from the library. Present only for ROOTS: a subfolder
   *  comes in as part of its root's scan, so there is nothing to remove. The
   *  folder itself is never touched on disk, which is why this is worded as
   *  leaving rather than deleting. */
  onRemove?: () => void;
}) {
  const [tags, setTags] = useState<FinderTag[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);
  // Mounted only while open, so `true` is the honest open flag here.
  useMenuKeys(boxRef, true, onClose);
  const [pos, setPos] = useState(anchor);

  useEffect(() => {
    void invoke<TaggedPath[]>("read_finder_tags", { paths: [path] })
      .then((rows) => setTags(rows[0]?.tags ?? []))
      .catch(() => { /* a volume without xattrs simply has no tags */ });
  }, [path]);

  // Clamp on-screen once the size is known.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(8, Math.min(window.innerWidth - r.width - 8, anchor.x)),
      y: Math.max(8, Math.min(window.innerHeight - r.height - 8, anchor.y)),
    });
  }, [anchor]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!boxRef.current?.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    const t = setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const write = (next: FinderTag[]) => {
    const prev = tags;
    setTags(next); // optimistic — the dot must respond like Finder's does
    onChanged?.(next);
    invoke("set_finder_tags", { path, tags: next }).catch(() => {
      setTags(prev); // never show a colour the disk does not carry
      onChanged?.(prev);
    });
  };

  return createPortal(
    <div
      ref={boxRef}
      className="cp-lib-menu"
      role="menu"
      aria-label="Folder actions"
      style={{ position: "fixed", left: pos.x, top: pos.y }}
    >
      <TagColorRow
        tags={tags}
        onToggle={(i: TagColorIndex) => write(toggleTagColor(tags, i))}
        onClear={() => write(clearTagColors(tags))}
      />
      <button
        type="button"
        role="menuitem"
        className="cp-lib-menu-item"
        onClick={() => {
          invoke("reveal_in_finder", { path }).catch(() => { /* gone */ });
          onClose();
        }}
      >
        <span className="cp-lib-menu-icon" aria-hidden="true"><IconReveal size={14} /></span>
        Reveal in Finder
      </button>
      {onRemove && (
        <button
          type="button"
          role="menuitem"
          className="cp-lib-menu-item"
          title="The folder and its files stay exactly where they are on disk."
          onClick={() => { onRemove(); onClose(); }}
        >
          <span className="cp-lib-menu-icon" aria-hidden="true"><IconCircleX size={13} /></span>
          Remove from library
        </button>
      )}
    </div>,
    document.body,
  );
}
