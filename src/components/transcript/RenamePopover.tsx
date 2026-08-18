import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SpeakerColorPicker } from "../SpeakerColorPicker";
import { createPortal } from "react-dom";
import { KindGlyph } from "./KindGlyph";
import { BadgeIconSheet } from "./BadgeIconSheet";
import { badgeIcon } from "./badge-icons";
import { noteBadgeIconUsed, readBadgeRecents } from "./badge-recents";
import { KIND_LABEL, kindTag, NON_SPEECH_KINDS } from "../../lib/speech-kind";
import { IconPlus } from "../Icons";
import { fmtTalkSeconds } from "../../lib/speaker-stats";

/**
 * Inline rename UI for a speaker chip. Anchored to the chip's bounding
 * rect (passed in by the parent) and portaled to <body> so it can
 * overflow the right-docked drawer and float above scroll.
 *
 * Extracted from TranscriptViewer.tsx (r46.B) — same behaviour, no
 * change to the layered-overrides logic which still lives in the
 * viewer (this component only collects user input and calls onApply).
 *
 * Scope semantics:
 *   "all"  — apply to every turn whose ORIGINAL tag matches.
 *   "turn" — apply only to the anchor turn.
 *
 * Click-outside + Escape both cancel; Enter commits. Auto-selects the
 * existing text on open so users can just type the new name.
 */

export type RenameState = {
  turnIdx: number;
  originalTag: string | null;
  currentName: string;
  rect: DOMRect;
};

/** One reassignment target — a known speaker from the roster. */
export type ReassignChoice = {
  /** Canonical roster tag ("Speaker" sentinel for the untagged group). */
  tag: string;
  /** Display name (after any global rename). */
  name: string;
  /** Pip background (gradient or custom hex) — matches the roster chip. */
  color: string;
  /** Seconds of speech. The list is ordered by it, like every other speaker
   *  list in the app. */
  talkSeconds: number;
};

type Props = {
  state: RenameState;
  onCancel: () => void;
  onApply: (name: string, scope: "all" | "turn") => void;
  /** 4a: the same color plumbing Manage speakers uses - a compact preset
   *  row; picking commits through the shared override path (and so fires
   *  speakers-changed, recoloring the timeline lane too). */
  colorValue?: string;
  onPickColor?: (hex: string) => void;
  /** Explicit badge icon for this speaker ("none" = initials), or undefined
   *  to leave it derived from the tag/name. */
  iconValue?: string | null;
  onPickIcon?: (kind: string | null) => void;
  /** Jump the transcript to where this speaker first appears, then close.
   *  Optional so any caller without a viewport stays valid. */
  onGoToSpeaker?: () => void;
  /** Other known speakers this ONE turn can be reassigned to. When present
   *  (and non-empty) the popover grows a "this turn is actually …" row —
   *  the per-turn twin of drag-to-merge, for the "the diarizer got this one
   *  turn wrong" case. Omitted → classic rename-only popover. */
  reassignChoices?: ReassignChoice[];
  /** Reassign the anchor turn to `tag`. Parent applies + closes. */
  onReassign?: (tag: string) => void;
};

export function RenamePopover({
  state, onCancel, onApply, onGoToSpeaker, reassignChoices, onReassign,
  colorValue, onPickColor, iconValue, onPickIcon,
}: Props) {
  const [name, setName] = useState(state.currentName);
  const [scope, setScope] = useState<"all" | "turn">("all");
  const inputRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  /** The four non-kind slots in the icon row. See badge-recents for why. */
  // Read ONCE per open. See pickIcon for why this never updates in place.
  const [recents] = useState<string[]>(() => readBadgeRecents());
  /** Anchor for the full icon sheet, or null when it is closed. */
  const [sheetAt, setSheetAt] = useState<DOMRect | null>(null);
  /** What the strip under the row names right now. */
  const [iconHint, setIconHint] = useState<string | null>(null);
  /**
   * The pick made in THIS popover, so an icon chosen from the full sheet shows
   * up in the row straight away rather than waiting for the parent to hand
   * `iconValue` back. It only ever ADDS; the row's existing members keep their
   * places, which is the difference between this and the recency reordering
   * that used to move buttons under the cursor.
   */
  const [justPicked, setJustPicked] = useState<string | null>(null);

  function pickIcon(id: string | null) {
    onPickIcon?.(id);
    // Record the use, but do NOT re-order the row you are looking at.
    //
    // `noteBadgeIconUsed` promotes the pick to the front of recents, and
    // feeding that straight back into state moved the buttons under the
    // cursor: pick the star and the star and the group swap places, so the
    // thing you just pressed is no longer where you pressed it and a second
    // pick lands on a different icon. A control has to hold still while it is
    // being used. The new order is persisted and shows up the next time the
    // popover opens, which is the moment it costs nothing.
    if (id) noteBadgeIconUsed(id);
    setJustPicked(id);
    setSheetAt(null);
  }

  /**
   * The four non-kind slots, with one guarantee on top of recency: whatever
   * this speaker is ALREADY wearing is in there.
   *
   * Without it, a speaker set to an icon that has since aged out of recents
   * opened a popover where nothing was ringed — the row said "no icon" while
   * the badge two inches away showed one. The current pick displaces the
   * oldest slot rather than adding an eleventh, so the row stays one line.
   */
  const rowIds = (() => {
    const base = recents.slice(0, 4);
    const shown = justPicked ?? iconValue;
    const worn = shown && shown !== "none" ? shown : null;
    if (!worn || base.includes(worn) || !badgeIcon(worn)) return base;
    if (NON_SPEECH_KINDS.some((k) => k === worn)) return base; // already in the row
    return [worn, ...base].slice(0, 4);
  })();

  // Select-all on mount so typing replaces the existing name.
  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.select());
  }, []);

  // Click-outside closes. Deferred a tick so the click that opened the
  // popover doesn't immediately close it.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!popRef.current?.contains(e.target as Node)) onCancel();
    }
    const t = setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDoc);
    };
  }, [onCancel]);

  function commit() {
    onApply(name, scope);
  }

  const showReassign = !!onReassign && !!reassignChoices && reassignChoices.length > 0;

  const POP_W = 300;
  // First guess, corrected below. Only the height was ever really unknown, and
  // guessing it is what let the popover hang off the bottom of the screen: the
  // constant predated the colour row and the icon row, so by now it was short
  // by about eighty pixels on every speaker chip near the foot of the drawer.
  const [pos, setPos] = useState(() => ({
    top: Math.max(8, Math.min(window.innerHeight - 240, state.rect.bottom + 6)),
    left: Math.max(8, Math.min(window.innerWidth - POP_W - 8, state.rect.left - 8)),
  }));

  // Measure what was actually laid out. Layout effect, so the correction is
  // applied before the browser paints and there is no visible jump.
  useLayoutEffect(() => {
    const el = popRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      top: Math.max(8, Math.min(window.innerHeight - height - 8, state.rect.bottom + 6)),
      left: Math.max(8, Math.min(window.innerWidth - width - 8, state.rect.left - 8)),
    });
  }, [state.rect, showReassign]);

  return createPortal(
    <div
      ref={popRef}
      className="cp-tx-rename"
      style={{ top: pos.top, left: pos.left, width: POP_W }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="cp-tx-rename-label">
        Rename <span className="cp-tx-rename-target">{state.currentName}</span>
      </div>
      <input
        ref={inputRef}
        className="cp-tx-rename-input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        placeholder="e.g. Tim, Marc, Interviewer"
        /* Spell-check ON — catches typos in real-word labels like
           "Interviewer" / "Moderator" / "Host". Proper nouns ("Tim")
           may squiggle, but that's a one-click "Learn Spelling" away
           via the native context menu and the catch-typos value
           outweighs the noise. */
        spellCheck
        lang="en"
        autoCorrect="off"
        autoComplete="off"
      />
      {colorValue && onPickColor && (
        <SpeakerColorPicker compact value={colorValue} anchorRect={null} onCommit={onPickColor} onClose={() => {}} />
      )}
      {/* Badge icon, directly under the colour row it rhymes with.
          A DISPLAY choice only: it changes what this speaker's badge shows,
          never who their lines belong to. So the show's band can wear a music
          note without their dialogue being folded into the shared Music group.
          "Initials" is first because it is the default and the way back.

          The row is four kinds plus four recents plus the plus, and the strip
          under it names whatever is hovered or focused. Before that the row was
          five unlabelled circles: a third of the width it sits in, with no way
          to learn what any of them meant short of pressing one and watching the
          badge change. */}
      {onPickIcon && (
        <div className="cp-tx-rename-iconwrap">
          {/* A group of toggles, not a radiogroup: the plus is a real button and
              lives in the same row, and a radiogroup with a non-radio child is
              invalid ARIA. aria-pressed says the same thing here. */}
          <div
            className="cp-tx-rename-icons"
            role="group"
            aria-label="Speaker icon"
            onMouseLeave={() => setIconHint(null)}
          >
            <button
              type="button"
              aria-pressed={!iconValue || iconValue === "none"}
              className={"cp-tx-rename-icon" + (!iconValue || iconValue === "none" ? " picked" : "")}
              title="Initials"
              aria-label="Initials"
              onClick={() => pickIcon(null)}
              onMouseEnter={() => setIconHint("Initials")}
              onFocus={() => setIconHint("Initials")}
              onBlur={() => setIconHint(null)}
            >
              <span className="cp-tx-rename-icon-initials">Aa</span>
            </button>
            {NON_SPEECH_KINDS.map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={iconValue === k}
                className={"cp-tx-rename-icon" + (iconValue === k ? " picked" : "")}
                title={KIND_LABEL[k]}
                aria-label={KIND_LABEL[k]}
                onClick={() => pickIcon(k)}
                onMouseEnter={() => setIconHint(KIND_LABEL[k])}
                onFocus={() => setIconHint(KIND_LABEL[k])}
                onBlur={() => setIconHint(null)}
              >
                <KindGlyph tag={kindTag(k)} name={KIND_LABEL[k]} size={14} />
              </button>
            ))}
            <span className="cp-tx-rename-icon-sep" aria-hidden="true" />
            {rowIds.map((id) => {
              const def = badgeIcon(id);
              if (!def) return null;
              const Glyph = def.Glyph;
              return (
                <button
                  key={id}
                  type="button"
                  aria-pressed={iconValue === id}
                  className={"cp-tx-rename-icon" + (iconValue === id ? " picked" : "")}
                  title={def.label}
                  aria-label={def.label}
                  onClick={() => pickIcon(id)}
                  onMouseEnter={() => setIconHint(def.label)}
                  onFocus={() => setIconHint(def.label)}
                  onBlur={() => setIconHint(null)}
                >
                  <Glyph size={14} strokeWidth={1.9} />
                </button>
              );
            })}
            <button
              ref={plusRef}
              type="button"
              className={"cp-tx-rename-icon plus" + (sheetAt ? " open" : "")}
              title="All icons"
              aria-label="All icons"
              aria-expanded={!!sheetAt}
              onClick={() => setSheetAt(sheetAt ? null : (plusRef.current?.getBoundingClientRect() ?? null))}
              onMouseEnter={() => setIconHint("All icons")}
              onFocus={() => setIconHint("All icons")}
              onBlur={() => setIconHint(null)}
            >
              <IconPlus size={13} strokeWidth={2.2} />
            </button>
          </div>
          {/* One fixed place, no tooltip delay, and it fires for keyboard focus
              too. Resting state names the CURRENT choice rather than going
              blank, so the row answers "what is this set to" as well. */}
          <div className="cp-tx-rename-iconhint">
            {iconHint ?? currentIconLabel(iconValue)}
          </div>
        </div>
      )}
      {sheetAt && onPickIcon && (
        <BadgeIconSheet
          anchorRect={sheetAt}
          value={iconValue ?? null}
          onPick={pickIcon}
          onClose={() => setSheetAt(null)}
          ignoreRef={plusRef}
        />
      )}
      <div className="cp-tx-rename-scope">
        <label>
          <input
            type="radio"
            checked={scope === "all"}
            onChange={() => setScope("all")}
          />
          <span>
            Apply to every{" "}
            <strong>{state.currentName}</strong> in this transcript
          </span>
        </label>
        <label>
          <input
            type="radio"
            checked={scope === "turn"}
            onChange={() => setScope("turn")}
          />
          <span>Only this turn</span>
        </label>
      </div>
      {showReassign && (
        <div className="cp-tx-rename-assign">
          <div className="cp-tx-rename-assign-label">…or this turn is actually</div>
          {/* Rows in a scroll box, not a wrapped cloud of pills.
              The cloud was fine at four speakers and at twenty-six it ran off
              the bottom of the popover with its last row sliced in half, in
              first-appearance order. Rows also let this list carry the same
              badge and talk time as the Speakers view and the roster, so the
              four places that list speakers finally look like one app. */}
          <div className="cp-tx-rename-assign-list" role="listbox" aria-label="Reassign this turn to a known speaker">
            {reassignChoices!.map((c) => (
              <button
                key={c.tag}
                role="option"
                aria-selected={false}
                className="cp-tx-rename-assign-btn"
                onClick={() => onReassign!(c.tag)}
                title={`Reassign only this turn to ${c.name}`}
              >
                <span className="cp-tx-rename-assign-pip" style={{ background: c.color }} aria-hidden>
                  <KindGlyph tag={c.tag === "Speaker" ? null : c.tag} name={c.name} size={11} />
                </span>
                <span className="cp-tx-rename-assign-name">{c.name}</span>
                <span className="cp-tx-rename-assign-talk">{fmtTalkSeconds(c.talkSeconds)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="cp-tx-rename-actions">
        {onGoToSpeaker && (
          <button
            className="btn btn-ghost cp-tx-rename-goto"
            onClick={onGoToSpeaker}
            title="Jump to where this speaker first appears"
          >
            Go to speaker
          </button>
        )}
        <button className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={commit}>
          Rename
        </button>
      </div>
    </div>,
    document.body,
  );
}

/**
 * What the hint strip says when nothing is hovered.
 *
 * "Automatic" rather than "Initials" for the no-choice case, because that is
 * what it actually is: with no explicit pick the badge is DERIVED, and a group
 * called "Music" shows a note under exactly that value. Calling it Initials
 * would be a claim the badge next to it visibly contradicts.
 */
function currentIconLabel(value: string | null | undefined): string {
  if (value === "none") return "Initials";
  return badgeIcon(value)?.label ?? "Automatic";
}

/** Talk time, short enough to sit at the end of a narrow row. */
