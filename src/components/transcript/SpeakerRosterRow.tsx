import { useEffect, useState } from "react";
import { IconPlay } from "../Icons";
import { KindGlyph } from "./KindGlyph";
import type { RosterItem } from "./SpeakerRosterModal";
import { fmtTalkSeconds } from "../../lib/speaker-stats";

/**
 * One speaker in the roster.
 *
 * Split out of the modal when the modal grew a filter, a sort and a bulk
 * merge — not to be clever, but because the row now owns real state (its own
 * name draft) and the shell owns different real state, and one file doing
 * both had stopped being readable.
 *
 * The selection checkbox replaces what used to be a native `<select>` per row
 * listing every OTHER speaker. At twenty-six that was twenty-six freshly
 * allocated arrays and six hundred and fifty option elements on every render,
 * and it could still only merge one pair at a time.
 */
export function SpeakerRosterRow({
  item, color, icon, selected, onToggle, onRename, onPickColor, onPlay,
}: {
  item: RosterItem;
  color: string;
  /** Explicit badge-icon id, or null to let the tag and name decide. */
  icon?: string | null;
  selected: boolean;
  onToggle: () => void;
  onRename: (canonicalTag: string, name: string) => void;
  onPickColor: (item: RosterItem, rect: DOMRect) => void;
  onPlay: () => void;
}) {
  const [name, setName] = useState(item.name);
  // Keep the field in step when the roster recomputes under it (a rename or
  // merge made somewhere else).
  useEffect(() => setName(item.name), [item.name]);

  const commit = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== item.name) onRename(item.tag, trimmed);
    else setName(item.name);
  };

  return (
    <div className={"cp-spk-row" + (selected ? " picked" : "")}>
      <input
        type="checkbox"
        className="cp-spk-check"
        checked={selected}
        onChange={onToggle}
        // The untagged group can never be a merge SOURCE — null-tagged turns
        // have no alias to rewrite — so it cannot be selected either.
        disabled={item.colorTag === null}
        aria-label={`Select ${item.name}`}
        title={item.colorTag === null ? "Unassigned speech cannot be merged" : `Select ${item.name}`}
      />
      {/* A badge, not a bare dot. The roster is the one screen that shows the
          WHOLE cast, and it was the only one of the four speaker lists whose
          circles carried nothing — so at twenty-six speakers it was twenty-six
          coloured dots and a column of names, and the colour was doing all the
          identifying on its own. Same glyph rule as the transcript bubbles, so
          a music bed reads as one here too. */}
      <button
        type="button"
        className="cp-spk-pip cp-spk-pip-btn"
        style={{ background: color }}
        title="Change colour"
        aria-label={`Change ${item.name} colour`}
        onClick={(e) => onPickColor(item, e.currentTarget.getBoundingClientRect())}
      >
        <KindGlyph tag={item.colorTag} name={item.name} size={11} override={icon} />
      </button>
      <input
        className="cp-spk-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        aria-label="Speaker name"
      />
      <span className="cp-spk-count" title={`${item.turnCount} turns`}>
        {fmtTalkSeconds(item.talkSeconds)}
      </span>
      {/* To name a voice you have to hear it. Before this the modal was a dead
          end: you closed it, scrolled the transcript, found a turn, played it,
          and came back. */}
      <button
        type="button"
        className="cp-spk-play"
        onClick={onPlay}
        aria-label={`Play ${item.name}`}
        title="Jump to their first line"
      >
        <IconPlay size={11} />
      </button>
    </div>
  );
}

/** Talk time, short enough to sit in a narrow column. */
