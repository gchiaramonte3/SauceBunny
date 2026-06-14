import { useEffect, useState } from "react";

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
};

type Props = {
  roster: RosterItem[];
  /** Rename a speaker globally (canonical tag → new name). */
  onRename: (canonicalTag: string, name: string) => void;
  /** Merge `sourceTag` INTO `targetTag` (they're the same person). */
  onMerge: (sourceTag: string, targetTag: string) => void;
  /** Resolve a speaker's current pip colour (override-aware). */
  colorOf: (item: RosterItem) => string;
  /** Open the colour picker anchored to this speaker's pip. */
  onPickColor: (item: RosterItem, rect: DOMRect) => void;
  onClose: () => void;
};

/**
 * Manage-speakers modal — replaces the cramped horizontally-clipped roster row.
 * Lists EVERY speaker with its colour, an inline rename, turn count, an explicit
 * "Merge into…" action (no obscure drag), and a clickable colour pip that opens
 * the picker. Backdrop / Escape close.
 */
export function SpeakerRosterModal({ roster, onRename, onMerge, colorOf, onPickColor, onClose }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="cp-spk-backdrop" onMouseDown={onClose}>
      <div
        className="cp-spk-modal"
        role="dialog"
        aria-label="Manage speakers"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="cp-spk-head">
          <span className="cp-spk-title">Speakers</span>
          <span className="cp-spk-badge">{roster.length}</span>
          <button className="cp-spk-x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="cp-spk-sub">
          Rename a speaker, recolour their dot, or merge two that are the same
          person. Changes apply to the transcript and the on-video captions instantly.
        </div>
        <div className="cp-spk-list">
          {roster.map((r) => (
            <SpeakerRow
              key={r.tag}
              item={r}
              others={roster.filter((o) => o.tag !== r.tag && o.colorTag !== null)}
              onRename={onRename}
              onMerge={onMerge}
              color={colorOf(r)}
              onPickColor={onPickColor}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function SpeakerRow({
  item, others, onRename, onMerge, color, onPickColor,
}: {
  item: RosterItem;
  others: RosterItem[];
  onRename: (canonicalTag: string, name: string) => void;
  onMerge: (sourceTag: string, targetTag: string) => void;
  color: string;
  onPickColor: (item: RosterItem, rect: DOMRect) => void;
}) {
  const [name, setName] = useState(item.name);
  // Keep the field in sync if the roster recomputes (rename/merge elsewhere).
  useEffect(() => setName(item.name), [item.name]);

  const commit = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== item.name) onRename(item.tag, trimmed);
    else setName(item.name);
  };

  // The untagged group ("Speaker" sentinel, colorTag null) can't be a merge
  // SOURCE — null-tagged turns have no alias to rewrite. It can still be renamed.
  const canMerge = item.colorTag !== null && others.length > 0;

  return (
    <div
      className="cp-spk-row"
      onContextMenu={(e) => {
        e.preventDefault();
        onPickColor(item, (e.currentTarget.querySelector(".cp-spk-pip") as HTMLElement).getBoundingClientRect());
      }}
    >
      <button
        type="button"
        className="cp-spk-pip cp-spk-pip-btn"
        style={{ background: color }}
        title="Change colour"
        aria-label={`Change ${item.name} colour`}
        onClick={(e) => onPickColor(item, e.currentTarget.getBoundingClientRect())}
      />
      <input
        className="cp-spk-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        aria-label="Speaker name"
      />
      <span className="cp-spk-count">{item.turnCount} {item.turnCount === 1 ? "turn" : "turns"}</span>
      {canMerge && (
        <select
          className="cp-spk-merge"
          value=""
          onChange={(e) => { if (e.target.value) onMerge(item.tag, e.target.value); }}
          aria-label={`Merge ${item.name} into another speaker`}
          title="Merge this speaker into another (same person)"
        >
          <option value="">Merge into…</option>
          {others.map((o) => <option key={o.tag} value={o.tag}>{o.name}</option>)}
        </select>
      )}
    </div>
  );
}
