import { useEffect, useState, useSyncExternalStore } from "react";
import { deleteCast, flushCasts, getCastError, getCasts, saveCast, subscribeCasts } from "../../lib/cast-store";
import { castFromSpeakers, type Cast } from "../../lib/cast";
import type { RosterItem } from "./SpeakerRosterModal";

/**
 * The shelf of saved casts, and the one control that puts a cast on it.
 *
 * Lives INSIDE the speakers modal rather than in its own window, because the
 * only two questions it answers are "save who I just named" and "name these
 * from a set I already have" — both of which are about the roster you are
 * looking at. A separate manager would mean building the same list twice.
 */
export function CastShelf({
  roster, colorOf, onApply, onBack,
}: {
  roster: RosterItem[];
  colorOf: (item: RosterItem) => string;
  /** Move to the assign step for this cast. */
  onApply: (cast: Cast) => void;
  onBack: () => void;
}) {
  const casts = useSyncExternalStore(subscribeCasts, getCasts);
  const error = useSyncExternalStore(subscribeCasts, getCastError);
  const [newName, setNewName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // Leaving the shelf is a deterministic moment when the app is still alive,
  // so it is the right place to force the debounced write out. Relying on the
  // 400ms timer alone means an app quit inside that window loses the cast the
  // user just built, and there is no second copy of it anywhere.
  useEffect(() => () => { void flushCasts(); }, []);

  // Only real speakers become members; the untagged bucket is not a person.
  const nameable = roster.filter((r) => r.colorTag !== null);

  const save = () => {
    const trimmed = newName.trim();
    if (!trimmed || nameable.length === 0) return;
    saveCast(castFromSpeakers(trimmed, nameable.map((r) => ({
      tag: r.tag, name: r.name, color: colorOf(r),
    }))));
    setNewName("");
  };

  return (
    <>
      <div className="cp-cast-capture">
        <input
          className="cp-input cp-cast-newname"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") save(); }}
          placeholder="Save these speakers as…"
          aria-label="Name for a new cast"
          spellCheck={false}
        />
        <button
          type="button"
          className="btn btn-compact"
          disabled={!newName.trim() || nameable.length === 0}
          onClick={save}
        >
          Save {nameable.length}
        </button>
      </div>

      {error && <p className="cp-cast-err">Casts could not be saved: {error}</p>}

      <div className="cp-spk-list">
        {casts.length === 0 && (
          <p className="cp-lib-note">
            No saved casts yet. Name the speakers in this transcript, then save
            them here to reuse on the next episode.
          </p>
        )}
        {casts.map((c) => (
          <div key={c.id} className="cp-cast-row">
            <div className="cp-cast-pips" aria-hidden="true">
              {c.members.slice(0, 6).map((m) => (
                <span key={m.id} className="cp-cast-pip" style={{ background: m.color }} />
              ))}
            </div>
            <div className="cp-cast-meta">
              <span className="cp-cast-name">{c.name}</span>
              <span className="cp-cast-count">
                {c.members.length === 1 ? "1 member" : `${c.members.length} members`}
              </span>
            </div>
            {confirmDelete === c.id ? (
              <>
                {/* Confirm in place. A cast is a season's worth of naming and
                    the store has no undo, so a bare delete button one pixel
                    from Apply is not a thing to ship. */}
                <span className="cp-cast-confirm">Delete?</span>
                <button
                  type="button"
                  className="btn btn-compact cp-cast-danger"
                  onClick={() => { deleteCast(c.id); setConfirmDelete(null); }}
                >
                  Delete
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-compact"
                  onClick={() => setConfirmDelete(null)}
                >
                  Keep
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn-compact"
                  onClick={() => onApply(c)}
                  disabled={c.members.length === 0}
                >
                  Apply
                </button>
                <button
                  type="button"
                  className="cp-cast-del"
                  onClick={() => setConfirmDelete(c.id)}
                  aria-label={`Delete ${c.name}`}
                  title="Delete this cast"
                >
                  ×
                </button>
              </>
            )}
          </div>
        ))}
      </div>

      <div className="cp-spk-foot">
        <span className="cp-spk-footcount">
          {casts.length === 1 ? "1 cast" : `${casts.length} casts`}
        </span>
        <button type="button" className="btn btn-ghost btn-compact" onClick={onBack}>
          Back to speakers
        </button>
      </div>
    </>
  );
}
