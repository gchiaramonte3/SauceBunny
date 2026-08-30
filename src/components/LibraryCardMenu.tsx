import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useMenuKeys } from "../hooks/use-menu-keys";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { IconCamera, IconRefresh, IconReveal, IconPlay, IconReview, IconPencil, IconTrash, IconFolderSolid } from "./Icons";
import { TagColorRow } from "./TagColorRow";
import type { TagColorIndex } from "../lib/finder-tags";
import type { FinderTag } from "../bindings/FinderTag";

/**
 * Right-click / ⋯ context menu for a LibraryCard. PORTALED to document.body
 * with position:fixed at the anchor — the same escape as CoReviewPopover: a
 * card's transformed/overflow-clipped shelf would otherwise clip an absolutely
 * positioned child. The anchor is clamped to stay on-screen near the right and
 * bottom edges.
 *
 * Items, in order: "Choose thumbnail…", "Reset thumbnail" (disabled until a
 * chosen time exists), "Reveal in Finder" (only when the source is local), and
 * "Open in Clip". Closes on Esc / outside-click; the caller's onClose restores
 * focus to the card. Arrow keys rove between items; Enter/Space activate.
 */

type Props = {
  /** Viewport coords to anchor at (cursor, or the ⋯ button's corner). */
  anchor: { x: number; y: number };
  /**
   * Which of the menu's own corners sits at `anchor`.
   *
   * "left" is right for a cursor and for the card's own keyboard menu: the
   * menu grows away from the point you asked at. The ⋯ trigger lives in the
   * card's TOP-RIGHT, so left-aligning there throws the menu rightward off the
   * card and the viewport clamp then yanks it somewhere unrelated. Anchoring
   * its right edge instead keeps it under the button it came from.
   */
  align?: "left" | "right";
  /** Local video → the two thumbnail items appear. */
  canPickThumbnail: boolean;
  /** A user-chosen thumbnail already exists → "Reset thumbnail" is enabled. */
  hasChosenThumbnail: boolean;
  /** Filesystem path when the source is local → "Reveal in Finder" appears. */
  revealPath: string | null;
  /**
   * Remove this item. Rendered LAST and in danger text, and only when a
   * caller passes it, so file cards are untouched.
   *
   * It lives here rather than as a control on the card because the card
   * already HAS the place for per-item verbs - this menu - and a floating
   * button beside the ⋯ that opens it is the same action twice, in two
   * idioms, fighting for the same corner. The shelves that own deletable
   * items (frames, cached web sources) pass it; everything else does not.
   */
  onDelete?: () => void;
  /** The verb, since it differs by shelf ("Delete", "Forget"). */
  deleteLabel?: string;
  /** File this item somewhere. Shelves whose items live in real folders
   *  pass it; everything else shows no such verb. */
  onMove?: () => void;
  /** Finder tags on this file, and the two ways to change them. Absent for
   *  sources with no path on disk (web), which cannot carry an xattr. */
  tags?: readonly FinderTag[];
  onToggleTagColor?: (index: TagColorIndex) => void;
  onClearTagColors?: () => void;
  /** Rename this file (or the whole selection it belongs to). Absent for
   *  sources with no path on disk. */
  onRename?: () => void;
  onChooseThumbnail: () => void;
  onResetThumbnail: () => void;
  onOpen: () => void;
  /** Open this source and land in the Review workspace (session-ready). */
  onReview?: () => void;
  onClose: () => void;
};

type Item = {
  icon: ReactNode; label: string; disabled?: boolean; onSelect: () => void;
  /** Destructive: rendered in danger text, and last. */
  danger?: boolean;
};

export function LibraryCardMenu({
  anchor, align = "left", canPickThumbnail, hasChosenThumbnail, revealPath,
  onChooseThumbnail, onResetThumbnail, onOpen, onReview, onClose,
  tags, onToggleTagColor, onClearTagColors, onRename, onDelete, deleteLabel, onMove,
}: Props) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: anchor.x, top: anchor.y });

  const items: Item[] = [];
  if (canPickThumbnail) {
    items.push({ icon: <IconCamera size={14} />, label: "Choose thumbnail…", onSelect: onChooseThumbnail });
    items.push({ icon: <IconRefresh size={14} />, label: "Reset thumbnail", disabled: !hasChosenThumbnail, onSelect: onResetThumbnail });
  }
  if (revealPath) {
    items.push({
      icon: <IconReveal size={14} />,
      label: "Reveal in Finder",
      onSelect: () => { invoke("reveal_in_finder", { path: revealPath }).catch(() => { /* ignore */ }); },
    });
  }
  if (onRename) items.push({ icon: <IconPencil size={14} />, label: "Rename…", onSelect: onRename });
  if (onMove) items.push({ icon: <IconFolderSolid size={13} />, label: "Move to folder…", onSelect: onMove });
  items.push({ icon: <IconPlay size={13} />, label: "Open in Clip", onSelect: onOpen });
  if (onReview) {
    items.push({ icon: <IconReview size={13} />, label: "Review this clip", onSelect: onReview });
  }
  // Last, always: a destructive verb should never sit where a muscle-memory
  // click for the item above it lands.
  if (onDelete) {
    items.push({
      icon: <IconTrash size={13} />,
      label: deleteLabel ?? "Delete…",
      danger: true,
      onSelect: onDelete,
    });
  }

  // Clamp the fixed anchor so the menu never spills off the right/bottom edge.
  useLayoutEffect(() => {
    const el = popoverRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const pad = 8;
    let left = align === "right" ? anchor.x - width : anchor.x;
    let top = anchor.y;
    if (left + width > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - pad - width);
    if (left < pad) left = pad;
    if (top + height > window.innerHeight - pad) top = Math.max(pad, anchor.y - height);
    setPos({ left, top });
  }, [anchor.x, anchor.y, align]);

  // Focus-on-open, arrows, Home/End, type-ahead, Tab-to-leave and focus
  // restoration all come from the shared hook now. This component had the
  // best hand-rolled version of the eleven - it focused the first enabled item
  // and wrapped the arrows - and it was still missing Home/End, type-ahead,
  // roving tabindex (so every item was a tab stop) and Tab-closes. Ten other
  // menus had less than this; one implementation is how they stop diverging.
  useMenuKeys(popoverRef, true, onClose);

  // Outside-click + Escape dismissal (Escape captures so it beats App's global keys).
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!popoverRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={popoverRef}
      className="cp-lib-menu"
      role="menu"
      aria-label="Card actions"
      style={{ position: "fixed", left: pos.left, top: pos.top }}
    >
      {/* Colour first, above the verbs — where Finder puts it, and one click
          from right-click, which is the whole reason tags get used. */}
      {onToggleTagColor && onClearTagColors && (
        <TagColorRow
          tags={tags ?? []}
          onToggle={(i) => onToggleTagColor(i)}
          onClear={onClearTagColors}
        />
      )}
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          className={"cp-lib-menu-item" + (it.danger ? " danger" : "")}
          disabled={it.disabled}
          onClick={() => { it.onSelect(); onClose(); }}
        >
          <span className="cp-lib-menu-icon" aria-hidden="true">{it.icon}</span>
          {it.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
