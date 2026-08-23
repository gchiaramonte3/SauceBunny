import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  IconMarkIn, IconPlay, IconScissors, IconStack, IconTranscript, IconUndo,
} from "../Icons";
import { SpeakerAssignFlyout } from "./SpeakerAssignFlyout";

/**
 * Above this many reassignment targets, they collapse into one submenu.
 *
 * Six because a flat list is genuinely better below it: every name visible,
 * one click, no hover, no second panel. The cost only appears on a big cast,
 * where one row per speaker pushes Play and Clear speaker off the bottom of
 * the screen and the menu stops being a menu. Counted AFTER the current
 * speaker is filtered out, since that row is never offered.
 */
const COLLAPSE_SPEAKERS_AT = 6;

/** Row height of `.cp-lib-menu-item`, used to line the flyout up with the row
 *  that opened it. A measured offsetTop would be exact, but it forces a layout
 *  read on every open for a couple of pixels nobody can see. */
const MENU_ROW_H = 30;
/** Flyout width, only needed to decide which side it can fit on. */
const FLYOUT_W = 210;

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
  /**
   * Turn the selection into an in/out range, and optionally straight into a
   * queued clip.
   *
   * "I found the quote, now cut it" is the move an editor makes most, and it
   * had no path: every cue click called `onSeek(cue.start)` and nothing else,
   * so marking the end meant clicking the LAST cue (which seeks to its start,
   * not its end) and then scrubbing by hand. Absent when the host has no
   * transport to mark against.
   */
  onMarkRange?: () => void;
  onQueueRange?: () => void;
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

type Item = {
  icon: ReactNode;
  label: string;
  disabled?: boolean;
  onSelect: () => void;
  /** Renders the ▸ affordance and opens the flyout instead of acting. */
  submenu?: boolean;
};

export function CueSelectionMenu({
  anchor, cueCount, speakers, currentTag, onAssign, onNewSpeaker, onPlay, onClose,
  phrase, onUnsplit, onMarkRange, onQueueRange,
}: Props) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [pos, setPos] = useState({ left: anchor.x, top: anchor.y });
  /** Index of the item whose flyout is open, or -1. */
  const [openSub, setOpenSub] = useState(-1);
  const openSubRef = useRef(-1);
  useEffect(() => { openSubRef.current = openSub; }, [openSub]);

  /** Everyone the selection could move to. Assigning to the speaker it already
   *  has is a no-op dressed as an action, so it is never listed. */
  const assignable = speakers.filter((s) => s.tag !== currentTag);

  /**
   * Which side the flyout opens on.
   *
   * The parent menu is already clamped away from the right edge, so a flyout
   * that always opened rightward would be the one thing that still ran off
   * screen — and a right-click near the right edge is exactly where a context
   * menu gets used. Falls back to the right when neither side fits, since the
   * left would be worse.
   */
  const flyoutSide: "left" | "right" =
    pos.left + FLYOUT_W + 200 > window.innerWidth && pos.left > FLYOUT_W ? "left" : "right";

  const lines = cueCount === 1 ? "1 line" : `${cueCount} lines`;
  const items: Item[] = [
    // Marking leads when a transport is there to mark against. The selection
    // already describes a range in time; every other item here reinterprets it
    // as a range of SPEAKERS, which is the less common thing to want.
    ...(onMarkRange
      ? [{
          icon: <IconMarkIn size={13} />,
          label: `Mark in/out from ${lines}`,
          onSelect: onMarkRange,
        }]
      : []),
    ...(onQueueRange
      ? [{
          icon: <IconStack size={13} />,
          label: "Add to queue",
          onSelect: onQueueRange,
        }]
      : []),
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
    ...(assignable.length > COLLAPSE_SPEAKERS_AT
      ? [{
          icon: <IconTranscript size={13} />,
          label: `Assign to speaker (${assignable.length})`,
          submenu: true,
          // Opening is handled by the click/keydown branch below; a submenu
          // parent that also "acted" would close the menu on the way in.
          onSelect: () => {},
        }]
      : assignable.map((s) => ({
          icon: <span className="cp-cuemenu-pip" style={{ background: s.color }} aria-hidden="true" />,
          label: `Assign to ${s.name}`,
          onSelect: () => onAssign(s.tag),
        }))),
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
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      // One panel at a time. With a flyout open, Escape backs out of it and
      // leaves the menu standing; only a second Escape dismisses everything.
      // Closing both at once would throw away the selection the user is still
      // working on, which is the expensive half of the gesture.
      if (openSubRef.current >= 0) { setOpenSub(-1); return; }
      onClose();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
    // openSub is read through a ref so this listener is registered once; a
    // re-registering Escape handler races the capture-phase ordering it
    // depends on to beat App's global keys.
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
          aria-haspopup={it.submenu ? "menu" : undefined}
          aria-expanded={it.submenu ? openSub === i : undefined}
          onClick={() => {
            if (it.submenu) { setOpenSub(openSub === i ? -1 : i); return; }
            it.onSelect();
            onClose();
          }}
          // Hovering a submenu row opens it and hovering any other row closes
          // it, which is how every other context menu on this platform behaves.
          onMouseEnter={() => { if (it.submenu) setOpenSub(i); else if (openSub !== -1) setOpenSub(-1); }}
          onKeyDown={(e) => {
            if (!it.submenu) return;
            if (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setOpenSub(i);
            }
          }}
        >
          <span className="cp-lib-menu-icon" aria-hidden="true">{it.icon}</span>
          {it.label}
          {it.submenu && <span className="cp-cuemenu-caret" aria-hidden="true">›</span>}
        </button>
      ))}
      {openSub >= 0 && (
        <SpeakerAssignFlyout
          speakers={assignable}
          side={flyoutSide}
          top={openSub * MENU_ROW_H}
          onPick={(tag) => { onAssign(tag); onClose(); }}
          onBack={() => { setOpenSub(-1); btnRefs.current[openSub]?.focus(); }}
        />
      )}
    </div>,
    document.body,
  );
}
