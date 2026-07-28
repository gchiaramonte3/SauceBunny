import { useEffect, useMemo, useRef, useState } from "react";
import { UndoRedoButtons } from "../UndoRedoButtons";
import { SpeakerRosterRow } from "./SpeakerRosterRow";

/** One canonical speaker, as computed by the viewer's roster useMemo. */
export type RosterItem = {
  /** Canonical tag ("Speaker" sentinel for the untagged group). */
  tag: string;
  /** Null-preserving resolved tag, for colour (null = untagged group). */
  colorTag: string | null;
  /** Current display name (after rename). */
  name: string;
  /** Turns assigned to this speaker. */
  turnCount: number;
  /** Seconds of speech — the axis a cast is actually ordered by. Turn count
   *  says how often someone was interrupted; talk time says who the lead is. */
  talkSeconds: number;
};

type Props = {
  roster: RosterItem[];
  /** Rename a speaker globally (canonical tag → new name). */
  onRename: (canonicalTag: string, name: string) => void;
  /** Merge every `sourceTags` INTO `targetTag`, as one undo step. */
  onMergeMany: (sourceTags: string[], targetTag: string) => void;
  /** Jump the transcript and player to this speaker's first line. */
  onPlaySpeaker: (tag: string) => void;
  /** Resolve a speaker's current pip colour (override-aware). */
  colorOf: (item: RosterItem) => string;
  /** Open the colour picker anchored to this speaker's pip. */
  onPickColor: (item: RosterItem, rect: DOMRect) => void;
  onClose: () => void;
};

/**
 * Manage-speakers modal, built for a cast rather than a conversation.
 *
 * The version this replaces was fine at four speakers and unusable at
 * twenty-six. Every row carried its own `<select>` listing every OTHER
 * speaker, so a full cast meant twenty-six freshly allocated arrays and six
 * hundred and fifty option elements rebuilt on every keystroke of a rename —
 * and after all that it could still only merge one pair at a time, one undo
 * step each. There was no filter, no sort, and no way to hear a voice without
 * closing the modal and hunting through the transcript for one of its turns.
 *
 * So: a filter that takes focus on open, a sort that defaults to talk time
 * (the leads are who you came to name), checkbox selection with ONE merge
 * control in a footer that only exists while something is selected, and a play
 * button per row. Backdrop / Escape close.
 */
export function SpeakerRosterModal({
  roster, onRename, onMergeMany, colorOf, onPickColor, onPlaySpeaker, onClose,
}: Props) {
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<"talk" | "name" | "order">("talk");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const filterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Autofocused, so the modal opens ready to be typed at. With a cast this
  // size, "type three letters" beats any amount of scrolling.
  useEffect(() => { filterRef.current?.focus(); }, []);

  const togglePicked = (tag: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(tag)) next.delete(tag); else next.add(tag);
    return next;
  });

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q ? roster.filter((r) => r.name.toLowerCase().includes(q)) : roster;
    // Talk time DESCENDING by default: the leads are who you came to name,
    // and a two-line bit-part should not sit above them just because the
    // diarizer happened to hear it first.
    if (sort === "talk") return [...list].sort((a, b) => b.talkSeconds - a.talkSeconds);
    if (sort === "name") return [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return list; // "order" is the roster's own first-appearance order
  }, [roster, filter, sort]);

  return (
    <div className="cp-spk-backdrop" onMouseDown={onClose}>
      <div
        className="cp-spk-modal"
        role="dialog"
        // See ShareDialog: cmd+F / cmd+G are gated on an aria-modal dialog
        // being present, so without this they reached the transcript behind
        // the scrim.
        aria-modal="true"
        aria-label="Manage speakers"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="cp-spk-head">
          <span className="cp-spk-title">Speakers</span>
          <span className="cp-spk-badge">{roster.length}</span>
          {/* Its own pair, because this modal is a scrim over the transcript
              toolbar and merge — the edit most likely to be a mistake — is
              made from right here. */}
          <UndoRedoButtons compact />
          <button className="cp-spk-x" onClick={onClose} aria-label="Close">×</button>
        </div>

        {/* Filter first, because at twenty-six names a three-keystroke lookup
            is the whole difference, and it doubles as the keyboard path into
            the list without needing a roving tabindex. */}
        <div className="cp-spk-tools">
          <input
            ref={filterRef}
            className="cp-input cp-spk-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={`Filter ${roster.length} speakers`}
            spellCheck={false}
            aria-label="Filter speakers"
          />
          <div className="cp-spk-sort" role="tablist" aria-label="Sort speakers">
            {(["talk", "name", "order"] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={sort === k}
                className={"cp-spk-sortbtn" + (sort === k ? " on" : "")}
                onClick={() => setSort(k)}
              >
                {k === "talk" ? "Talk time" : k === "name" ? "Name" : "Order"}
              </button>
            ))}
          </div>
        </div>

        <div className="cp-spk-list">
          {shown.length === 0 && (
            <p className="cp-lib-note">No speaker matches “{filter.trim()}”.</p>
          )}
          {shown.map((r) => (
            <SpeakerRosterRow
              key={r.tag}
              item={r}
              color={colorOf(r)}
              selected={picked.has(r.tag)}
              onToggle={() => togglePicked(r.tag)}
              onRename={onRename}
              onPickColor={onPickColor}
              onPlay={() => onPlaySpeaker(r.tag)}
            />
          ))}
        </div>

        {/* The merge bar appears only when there is a merge to make. A footer
            that is always there is a footer nobody reads. */}
        {picked.size > 0 && (
          <div className="cp-spk-foot">
            <span className="cp-spk-footcount">
              {picked.size} selected
            </span>
            <select
              className="cp-spk-merge"
              value=""
              onChange={(e) => {
                if (!e.target.value) return;
                onMergeMany([...picked], e.target.value);
                setPicked(new Set());
              }}
              aria-label="Merge the selected speakers into one"
            >
              <option value="">Merge into…</option>
              {/* Only ONE select exists now, and only while a selection is
                  live. There used to be one per row, each listing every other
                  speaker: twenty-six arrays and six hundred and fifty option
                  nodes rebuilt on every render, to merge one pair at a time. */}
              {roster
                .filter((o) => o.colorTag !== null && !picked.has(o.tag))
                .map((o) => <option key={o.tag} value={o.tag}>{o.name}</option>)}
            </select>
            <button
              type="button"
              className="btn btn-ghost btn-compact"
              onClick={() => setPicked(new Set())}
            >
              Clear
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
