import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconPlay, IconScissors, IconTranscript, IconUndo } from "../Icons";

/**
 * Right-click menu for a RANGE OF SELECTED CUES in the transcript.
 *
 * The job: a diarizer decided two people were one speaker, and the user wants
 * to lasso the misattributed dialogue and pull it out. Everything about the
 * shell — portal to body, fixed positioning clamped to the viewport, roving
 * arrow keys, Escape in the capture phase so it beats App's global keys — is
 * the same as LibraryCardMenu, deliberately duplicated rather than abstracted
 * into a generic <ContextMenu>. Two ~130-line siblings is the house style, and
 * the two menus want different things from their anchors.
 *
 * NO SCRIM, and that is load-bearing here in a way it is not for a card menu:
 * the whole point is that the user can still see the text they highlighted
 * while they choose what to do with it. ReaderRowMenu's full-surface scrim
 * would grey out the very thing being confirmed.
 */

type Props = {
  /** Viewport coords to anchor at (the cursor). */
  anchor: { x: number; y: number };
  /** How many cues the selection covers, for the labels. */
  cueCount: number;
  /** Existing speakers to reassign to, already display-named and ordered. */
  speakers: { tag: string; name: string; color: string }[];
  /** The speaker the selection currently belongs to, so it can be skipped. */
  currentTag: string | null;
  onAssign: (tag: string) => void;
  onNewSpeaker: () => void;
  onPlay: () => void;
  onClose: () => void;
  /**
   * Present only when the lasso stayed inside ONE cue and covered part of it.
   *
   * The sub-cue case gets its own verb rather than reusing "Make 1 line a new
   * speaker", because the two do visibly different things to the transcript —
   * one moves an existing line, the other divides it — and a menu that used one
   * label for both would be lying about the more destructive of them.
   */
  phrase?: { text: string; onSplitOut: () => void };
  /** Present when this cue is ALREADY divided, so the cut can be undone from
   *  the same place it was made. */
  onUnsplit?: () => void;
};

/** Enough of the phrase to recognise it in a menu label, without the label
 *  growing to the width of a cue. */
function shorten(s: string, max = 28): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

type Item = { icon: ReactNode; label: string; disabled?: boolean; onSelect: () => void };

export function CueSelectionMenu({
  anchor, cueCount, speakers, currentTag, onAssign, onNewSpeaker, onPlay, onClose,
  phrase, onUnsplit,
}: Props) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [pos, setPos] = useState({ left: anchor.x, top: anchor.y });

  const lines = cueCount === 1 ? "1 line" : `${cueCount} lines`;
  const items: Item[] = [
    // The cut leads when there is one, because it is what the user's selection
    // actually described. Quoting the phrase back is the confirmation: this
    // action divides a line, and the only way to be sure it divides it in the
    // right place is to see the words that are moving.
    ...(phrase
      ? [{
          icon: <IconScissors size={13} />,
          label: `Split out "${shorten(phrase.text)}"`,
          onSelect: phrase.onSplitOut,
        }]
      : []),
    {
      icon: <IconTranscript size={13} />,
      label: `Make ${lines} a new speaker`,
      onSelect: onNewSpeaker,
    },
    // Reassigning to someone who already exists is the other half of the same
    // problem: the diarizer often splits ONE person into two as readily as it
    // merges two into one.
    ...speakers
      .filter((s) => s.tag !== currentTag)
      .map((s) => ({
        icon: <span className="cp-cuemenu-pip" style={{ background: s.color }} aria-hidden="true" />,
        label: `Assign to ${s.name}`,
        onSelect: () => onAssign(s.tag),
      })),
    { icon: <IconPlay size={13} />, label: `Play ${lines}`, onSelect: onPlay },
    // Present only when there is something to put back, so the menu does not
    // advertise an action that would do nothing.
    ...(currentTag != null
      ? [{
          icon: <IconUndo size={13} />,
          label: "Clear speaker",
          onSelect: () => onAssign(""),
        }]
      : []),
    // Offered from the same menu the cut was made in, because that is where a
    // user will look for it. Last, since it undoes the most.
    ...(onUnsplit
      ? [{ icon: <IconUndo size={13} />, label: "Rejoin this line", onSelect: onUnsplit }]
      : []),
  ];

  // Clamp the fixed anchor so the menu never spills off the right/bottom edge.
  useLayoutEffect(() => {
    const el = popoverRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const pad = 8;
    let left = anchor.x;
    let top = anchor.y;
    if (left + width > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - pad - width);
    if (top + height > window.innerHeight - pad) top = Math.max(pad, anchor.y - height);
    setPos({ left, top });
  }, [anchor.x, anchor.y]);

  // Focus the first enabled item on open (keyboard entry point).
  useEffect(() => {
    const first = items.findIndex((it) => !it.disabled);
    btnRefs.current[first >= 0 ? first : 0]?.focus();
    // Open-once: the item set is stable for a given selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);
    if (enabled.length === 0) return;
    const focused = btnRefs.current.findIndex((b) => b === document.activeElement);
    const at = enabled.indexOf(focused);
    const dir = e.key === "ArrowDown" ? 1 : -1;
    const next = at < 0 ? 0 : (at + dir + enabled.length) % enabled.length;
    btnRefs.current[enabled[next]]?.focus();
  };

  return createPortal(
    <div
      ref={popoverRef}
      className="cp-lib-menu cp-cuemenu"
      role="menu"
      aria-label={`Actions for ${lines}`}
      style={{ position: "fixed", left: pos.left, top: pos.top }}
      onKeyDown={onKeyDown}
    >
      {items.map((it, i) => (
        <button
          key={it.label}
          ref={(el) => { btnRefs.current[i] = el; }}
          type="button"
          role="menuitem"
          className="cp-lib-menu-item"
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
