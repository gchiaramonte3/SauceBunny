import { Fragment, useEffect, useState, useSyncExternalStore } from "react";
import { deleteCast, flushCasts, getCastError, getCasts, saveCast, subscribeCasts } from "../../lib/cast-store";
import { castFromSpeakers, type Cast, type CastMember } from "../../lib/cast";
import { isUsableAvatar } from "../../lib/avatar";
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
  roster, colorOf, onApply, onGrabFace, onBack,
}: {
  roster: RosterItem[];
  colorOf: (item: RosterItem) => string;
  /** Move to the assign step for this cast. */
  onApply: (cast: Cast) => void;
  /** Capture the frame on screen as a face. Absent where there is no player. */
  onGrabFace?: () => Promise<string | null>;
  onBack: () => void;
}) {
  const casts = useSyncExternalStore(subscribeCasts, getCasts);
  const error = useSyncExternalStore(subscribeCasts, getCastError);
  const [newName, setNewName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

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
          <Fragment key={c.id}>
          <div className="cp-cast-row">
            <div className="cp-cast-pips" aria-hidden="true">
              {c.members.slice(0, 6).map((m) => (
                <span key={m.id} className="cp-cast-pip" style={{ background: m.color }} />
              ))}
            </div>
            <button
              type="button"
              className="cp-cast-meta"
              onClick={() => setExpanded(expanded === c.id ? null : c.id)}
              aria-expanded={expanded === c.id}
              // Named explicitly: a button whose label is just the cast name
              // says nothing about what pressing it does, and it collides with
              // the delete button on the same row.
              aria-label={`Members of ${c.name}`}
              title="Show the members"
            >
              <span className="cp-cast-name">
                <span className={"cp-cast-chev" + (expanded === c.id ? " open" : "")} aria-hidden="true">›</span>
                {c.name}
              </span>
              <span className="cp-cast-count">
                {c.members.length === 1 ? "1 member" : `${c.members.length} members`}
              </span>
            </button>
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
          {expanded === c.id && (
            <div className="cp-cast-members">
              {c.members.length === 0 && <p className="cp-lib-note">This cast has no members.</p>}
              {c.members.map((m) => (
                <CastMemberRow
                  key={m.id}
                  member={m}
                  onGrabFace={onGrabFace}
                  onFace={(avatar) => saveCast({
                    ...c,
                    members: c.members.map((x) => (x.id === m.id ? { ...x, avatar } : x)),
                  })}
                />
              ))}
            </div>
          )}
          </Fragment>
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

/**
 * One member of an expanded cast, and the face control.
 *
 * "Grab face" takes the frame on screen RIGHT NOW rather than opening a file
 * picker. That is the whole design: the roster one step back has a play button
 * per speaker, so the flow is play their line, look at them, take the frame.
 * A picker would send the user out of the app to find a photograph of somebody
 * they were already looking at, and the photograph would be a headshot rather
 * than the person as they appear in this edit.
 *
 * The control is absent, not disabled, when there is no player — in the panel
 * window there is nothing to grab, and a disabled button that never enables is
 * worse than no button.
 */
function CastMemberRow({
  member, onFace, onGrabFace,
}: {
  member: CastMember;
  onFace: (avatar: string | null) => void;
  onGrabFace?: () => Promise<string | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const grab = async () => {
    if (!onGrabFace || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const avatar = await onGrabFace();
      // No decoded frame yet (paused before the first paint, or a source that
      // cannot be read) is a shrug and a retry one frame later, not an error
      // worth a dialog.
      if (avatar && isUsableAvatar(avatar)) onFace(avatar);
      else setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cp-cast-member">
      <span
        className="cp-cast-face"
        style={{
          background: member.avatar ? `center/cover url("${member.avatar}")` : member.color,
        }}
        aria-hidden="true"
      />
      <span className="cp-cast-mname">{member.name}</span>
      {failed && <span className="cp-cast-facefail">No frame on screen</span>}
      {member.avatar && (
        <button
          type="button"
          className="cp-cast-del"
          onClick={() => onFace(null)}
          aria-label={`Remove ${member.name}'s face`}
          title="Remove this face"
        >
          ×
        </button>
      )}
      {onGrabFace && (
        <button type="button" className="btn btn-ghost btn-compact" onClick={grab} disabled={busy}>
          {busy ? "Grabbing…" : member.avatar ? "Replace face" : "Grab face"}
        </button>
      )}
    </div>
  );
}
