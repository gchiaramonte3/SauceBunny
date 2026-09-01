import { countLibraryItems } from "../lib/library";
import { IconFolder } from "./Icons";
import type { LibraryFolder } from "../types";
import { DEFAULT_LIB_COLUMNS } from "../lib/library";
import { useState } from "react";
import { FolderTagMenu } from "./FolderTagMenu";
import { primarySwatch } from "../lib/finder-tags";
import type { FinderTag } from "../bindings/FinderTag";

type Props = {
  /** See LibraryListRow: the header's current column order. */
  columns?: readonly string[];
  /** Its Finder tags, for the folder-glyph tint. Absent left the list view's
   *  folders colourless while the sidebar tree's wore their colour. */
  tags?: readonly FinderTag[];
  /** Tags were written; the caller re-reads whatever shows the colour. */
  onTagsChanged?: () => void;
  folder: LibraryFolder;
  onOpen: () => void;
  /** Highlighted because a drag is hovering it. */
  dropActive?: boolean;
};

/**
 * One container row of the Library browser's list mode — the sibling of
 * LibraryListRow, and the list's answer to LibraryFolderCard.
 *
 * The list branch used to render files only. A folder holding nothing but
 * more folders therefore came out as a completely blank pane (the empty note
 * is suppressed whenever folders exist, so it did not even say "nothing
 * here"), and an ordinary folder simply vanished from its own parent. A view
 * toggle must not be able to remove content.
 *
 * It also kept the keyboard honest. `names` in the pane lists folders FIRST to
 * match the grid's render order, while type-ahead reads its elements from
 * `.cp-lib-lrow` — so every list row was offset by the number of folders and
 * typing a name jumped to the wrong file. Rendering the folders as rows puts
 * the two lists back in step by construction rather than by a second ordering
 * rule that has to be kept in sync.
 *
 * Deliberately thinner than the file row: a directory has no size of its own
 * worth printing and no poster, so the Size column carries its item count and
 * Modified stays empty rather than inventing a date.
 */
export function LibraryFolderRow({ folder, onOpen, dropActive, columns, tags, onTagsChanged }: Props) {
  const count = countLibraryItems(folder);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  /* The tint rides the folder GLYPH: it is already a filled folder shape, so
     colouring it IS the Finder treatment, with no extra dot competing for row
     space. Same reasoning as the sidebar tree's rows. */
  const swatch = primarySwatch(tags ?? []);
  return (
    <>
    <button
      type="button"
      className={"cp-lib-lrow cp-lib-lrow-folder" + (dropActive ? " dropping" : "")}
      // `data-drop` is the attribute use-card-drag reads, and it is the same
      // name the grid's folder tile uses - one drop contract, two shapes.
      data-drop={folder.path}
      data-folder={folder.path}
      title={folder.name}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); onOpen(); }
        // The keyboard route to the same menu the pointer gets. Without it a
        // folder's colours are mouse-only (WCAG 2.1.1).
        if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          setMenuAt({ x: r.left + 12, y: r.bottom - 4 });
        }
      }}
      onContextMenu={(e) => { e.preventDefault(); setMenuAt({ x: e.clientX, y: e.clientY }); }}
    >
      <span className="cp-lib-lrow-art"><IconFolder size={13} style={swatch ? { color: swatch.hex } : undefined} /></span>
      <span className="cp-lib-lrow-name">{folder.name}</span>
      {/* Same order the header is showing, hidden ones absent. A folder row
          and a file row share one grid, so they have to agree. */}
      {(columns ?? DEFAULT_LIB_COLUMNS).map((k) => (
        k === "kind"
          ? <span key={k} className="cp-lib-lrow-kind cp-lib-lrow-kindword">folder</span>
          : k === "size"
            ? <span key={k} className="cp-lib-lrow-size">{count === 1 ? "1 item" : `${count} items`}</span>
            : k === "date"
              ? <span key={k} className="cp-lib-lrow-date" />
              /* A cell PER COLUMN, even when a folder has nothing to put in
                 one. The row is a grid whose tracks are shared with the item
                 rows above and below it; emit one cell fewer and every column
                 to the right of the gap slides left on that row alone. Folders
                 carry no custom-column values today - only clips do - so this
                 is deliberately empty rather than absent. */
              : <span key={k} className="cp-lib-lrow-custom" />
      ))}
    </button>
    {menuAt && (
      <FolderTagMenu
        path={folder.path}
        anchor={menuAt}
        onClose={() => setMenuAt(null)}
        onChanged={() => onTagsChanged?.()}
      />
    )}
    </>
  );
}
