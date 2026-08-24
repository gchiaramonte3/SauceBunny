import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { assetUrl } from "../lib/asset-url";
import { formatBytes } from "../lib/library";
import { formatFrameTimecode, type FrameItem } from "../lib/frames";
import { useModalFocus } from "../hooks/use-modal-focus";
import { IconChevronLeft, IconChevronRight, IconCircleX, IconReveal } from "./Icons";

/**
 * Look at a grabbed frame full size, and step through the ones beside it.
 *
 * A shelf of 160px thumbnails cannot answer the only question a still is
 * grabbed to answer - is the focus good, is the grade right, is the eyeline
 * where I thought - so opening one used to bounce the user out to Finder.
 * That is a strange thing for a picture viewer to do, and it left the app
 * to look at frames in another app.
 *
 * ARROWS STEP THROUGH THE SHELF AS DISPLAYED. The list handed in is the
 * flattened visual order, so Left/Right walk the frames in the order they
 * are on screen, across the source bundles, rather than in some private
 * order the viewer invented. Comparing two takes is the point.
 */
export function FramePreview({ items, path, onPath, onClose, onReveal }: {
  /** Every frame currently on the shelf, in the order it is displayed. */
  items: readonly FrameItem[];
  /** The frame being shown, addressed BY PATH. */
  path: string;
  onPath: (next: string) => void;
  onClose: () => void;
  onReveal: (path: string) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(true, dialogRef);
  const [failed, setFailed] = useState(false);

  // Addressed by path rather than by index on purpose. The shelf re-sorts
  // under the viewer (a sort change, a focus re-read, a delete from the card
  // menu), and an index held across that quietly starts pointing at a
  // DIFFERENT picture - the viewer would look right and be wrong. A path
  // either still resolves or does not.
  const index = items.findIndex((f) => f.path === path);
  const item = index >= 0 ? items[index] : null;

  // The frame went away while it was open - deleted here or in Finder. Close
  // rather than hold an empty lightbox over the shelf.
  useEffect(() => {
    if (!item) onClose();
  }, [item, onClose]);

  // A new picture deserves a fresh error state, or one unreadable frame would
  // poison every frame stepped to afterwards.
  useEffect(() => setFailed(false), [path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (index < 0) return;
      // Wrapping is deliberate: a shelf is a ring here, and stepping off the
      // end of a bundle to land on the next one is how you compare a first
      // and last take without walking back through the middle.
      const step = (delta: number) => {
        e.preventDefault();
        const n = items.length;
        if (n > 0) onPath(items[((index + delta) % n + n) % n].path);
      };
      if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "Home") { e.preventDefault(); if (items[0]) onPath(items[0].path); }
      else if (e.key === "End") { e.preventDefault(); const l = items.at(-1); if (l) onPath(l.path); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, index, onPath, onClose]);

  if (!item) return null;

  const tc = formatFrameTimecode(item.timecode);
  const go = (delta: number) => {
    const n = items.length;
    if (n > 0) onPath(items[((index + delta) % n + n) % n].path);
  };

  return createPortal(
    <div
      className="cp-framepv-scrim"
      onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="cp-framepv"
        role="dialog"
        aria-modal="true"
        aria-label={`Frame ${item.name}`}
      >
        <div className="cp-framepv-stage">
          {items.length > 1 && (
            <button
              type="button"
              className="cp-framepv-step prev"
              aria-label="Previous frame"
              onClick={() => go(-1)}
            >
              <IconChevronLeft size={20} />
            </button>
          )}
          {failed ? (
            // A denied asset read comes back 403 with an EMPTY body, so the
            // browser's own failure is a broken-image glyph and no reason.
            // Say which of the two it actually is.
            <p className="cp-framepv-failed">
              This frame could not be read. It may have been moved or deleted
              outside Sauce Bunny.
            </p>
          ) : (
            <img
              className="cp-framepv-img"
              src={assetUrl(item.path)}
              alt={item.name}
              draggable={false}
              onError={() => setFailed(true)}
            />
          )}
          {items.length > 1 && (
            <button
              type="button"
              className="cp-framepv-step next"
              aria-label="Next frame"
              onClick={() => go(1)}
            >
              <IconChevronRight size={20} />
            </button>
          )}
        </div>

        <div className="cp-framepv-foot">
          <div className="cp-framepv-meta">
            <span className="cp-framepv-name">{item.name}</span>
            <span className="cp-framepv-facts">
              {[
                item.source,
                tc,
                item.size_bytes ? formatBytes(item.size_bytes) : null,
              ].filter(Boolean).join(" · ")}
            </span>
          </div>
          {items.length > 1 && (
            <span className="cp-framepv-count">{index + 1} of {items.length}</span>
          )}
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onReveal(item.path)}
            title="Show this file in Finder"
          >
            <IconReveal size={13} /> Reveal
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose} title="Close (Esc)">
            <IconCircleX size={13} /> Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Open a frame in Finder. Kept here so both the viewer and the shelf that
 *  launches it name the same one-line action. */
export function revealFrame(path: string) {
  invoke("reveal_in_finder", { path }).catch(() => { /* ignore */ });
}
