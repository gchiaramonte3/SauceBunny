import { countLibraryItems } from "../lib/library";
import { IconFolder } from "./Icons";
import type { LibraryFolder } from "../types";

type Props = {
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
export function LibraryFolderRow({ folder, onOpen, dropActive }: Props) {
  const count = countLibraryItems(folder);
  return (
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
      }}
    >
      <span className="cp-lib-lrow-art"><IconFolder size={13} /></span>
      <span className="cp-lib-lrow-name">{folder.name}</span>
      <span className="cp-lib-lrow-kind cp-lib-lrow-kindword">folder</span>
      <span className="cp-lib-lrow-size">{count === 1 ? "1 item" : `${count} items`}</span>
      <span className="cp-lib-lrow-date" />
    </button>
  );
}
